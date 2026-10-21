/**
 * The `send` rail: resolve the Card's current Stores for the pinned rows, then
 * per Store send bounded chunks through the marketplace registry
 * (`send-native.ts`: resident rows → native material → WASM op 11 freeze →
 * one persistent-intent `POST /api/listing/submit` per chunk).
 *
 * Everything this tab already knows is refused first, with zero requests: a
 * missing pin, an unsaved or removing row, a row already Unknown,
 * invalid or awaiting AI review. The click's revision pins are never
 * replaced by a newer read.
 */
import { refuse } from "@/bindings/refusal"
import { cardPayload } from "@/bindings/listing-projection"
import { rowCacheScope } from "@/bindings/listing-row-cache"
import type { WorkflowOperationRowResult, WorkflowRowsActionRequest } from "@/bindings/commands"
import { bindListingRows, flushListingLogs, listingLog, releaseListingBatch } from "@/lib/listing-log"
import { openCardSession } from "../card/card-session"
import { mapLimit } from "../source-batch"
import { parseStoreIds, sendStoreAssignments } from "../store-quota"
import { peekListingWorkbench } from "../workbench/listing-workbench-store"
import { blocked, cancelledResult, localRefusal, type RowPin } from "./send-local"
import { defaultSendCore, refusedBeforeDispatch, resolveNativeRow, sendNativeChunk, type SendCore } from "./send-native"
import type { PublishDiagnosticDispatch } from "../model/publish-diagnostic"

/**
 * Stores submitted at once. Cloud admits two bulk submits per Workspace
 * (`WORKSPACE_BATCH_BUDGET`); a third in flight would wait its turn there and, past
 * the wait, fail the Store's rows as busy — so the fan-out stays at the budget.
 */
const SEND_STORE_CONCURRENCY = 2
const CHUNK_ROWS = 100

export type SendDeps = Readonly<{
  /** The native core; production lazily instantiates the tab's one `listing-core-wasm`. */
  core?: SendCore
  nowMs?: () => number
  diagnostics?: PublishDiagnosticDispatch
}>

function halts(results: readonly WorkflowOperationRowResult[]): boolean {
  const last = results.at(-1)
  return ["cloud_rate_limited", "unauthenticated", "cloud_unauthenticated"].includes(last?.error?.code ?? "") ||
    results.some((result) => [401, 403, 429].includes(result.submissionReceipt?.http_status ?? 0))
}

export async function sendRows(
  request: WorkflowRowsActionRequest,
  shouldStop: (rowId: string) => boolean = () => false,
  deps: SendDeps = {},
): Promise<WorkflowOperationRowResult[]> {
  if (request.row_ids.length === 0) {
    throw refuse("workflow_send_empty", "没有可发送的商品", "先在表格中选择要发送的商品")
  }
  const session = rowCacheScope()
  const listingBatchId = crypto.randomUUID()
  const listingStarted = performance.now()
  bindListingRows(listingBatchId, request.row_ids)
  listingLog({ module: "submit", event: "batch.start", correlation: { batchId: listingBatchId }, fields: { rows: request.row_ids.length } })
  try {
    return await sendRowsBody(request, (rowId) => !session.current() || shouldStop(rowId), deps, listingBatchId, listingStarted)
  } finally {
    flushListingLogs("batch")
    releaseListingBatch(listingBatchId)
  }
}

async function sendRowsBody(
  request: WorkflowRowsActionRequest,
  shouldStop: (rowId: string) => boolean,
  deps: SendDeps,
  listingBatchId: string,
  listingStarted: number,
): Promise<WorkflowOperationRowResult[]> {
  const pins = new Map<string, RowPin>(request.expected_revisions.map((pin) => [pin.row_id, { ...pin }]))
  const workbench = peekListingWorkbench()
  const settled: WorkflowOperationRowResult[] = []
  const byStore = new Map<string, string[]>()
  const assignments = new Map<string, Map<string, string>>()
  const live: string[] = []
  for (const rowId of request.row_ids) {
    const refusal = shouldStop(rowId) ? cancelledResult(rowId) : localRefusal(rowId, pins.get(rowId), workbench)
    if (refusal) {
      settled.push(refusal)
      continue
    }
    live.push(rowId)
  }
  const resolved = await mapLimit(live, 4, async (rowId) => {
    try {
      const found = await resolveNativeRow(rowId, pins.get(rowId)!.revision)
      if ("outcome" in found) return found
      const card = (await openCardSession(found.view.card_id)).card()
      const stores = parseStoreIds(cardPayload(card).targetStoreId)
      return { row: found.view, stores }
    } catch (reason) {
      return refusedBeforeDispatch(rowId, reason)
    }
  })
  for (const result of resolved) {
    if ("outcome" in result) {
      settled.push(result)
      continue
    }
    const { row, stores } = result
    // New sends adopt current bindings. An existing attempt keeps its Store.
    const fresh = ["none", "cancelled", "superseded", "rejected", "conflict"].includes(row.submission_state)
    let storeId = row.store_id
    if (fresh) {
      let targets = assignments.get(row.card_id)
      if (!targets) {
        const cohort = workbench.cardId === row.card_id
          ? workbench.rows.map((item) => [item.draftId, workbench.productDrafts[item.draftId]?.target_store_id] as const)
          : resolved.flatMap((item) => "row" in item && item.row.card_id === row.card_id ? [[item.row.id, item.row.store_id] as const] : [])
        targets = sendStoreAssignments(stores, cohort)
        assignments.set(row.card_id, targets)
      }
      storeId = targets.get(row.id)
    }
    if (!storeId?.trim()) {
      settled.push(blocked(row.id, "target_store_missing", "上架方案尚未绑定目标 Ozon 店铺", "在上架方案绑定店铺后再发送", { blockers: ["target_store_missing"] }))
      continue
    }
    byStore.set(storeId, [...(byStore.get(storeId) ?? []), row.id])
  }
  const nowMs = deps.nowMs ?? Date.now
  // Keep the two-Store budget and serialize chunks within each Store. A
  // failed chunk returns its own row results; later chunks still get a turn.
  const grouped = byStore.size === 0 ? [] : await mapLimit([...byStore], SEND_STORE_CONCURRENCY, async ([storeId, rowIds]) => {
    const core = deps.core ?? defaultSendCore()
    const results: WorkflowOperationRowResult[] = []
    for (let offset = 0; offset < rowIds.length; offset += CHUNK_ROWS) {
      const chunk = rowIds.slice(offset, offset + CHUNK_ROWS)
      if (halts(results)) {
        results.push(...rowIds.slice(offset).map((rowId) => ({ row_id: rowId, outcome: "blocked" as const, blockers: ["store_rate_limited"] })))
        break
      }
      results.push(...await sendNativeChunk({ core, storeId, rowIds: chunk, pins, shouldStop, nowMs: nowMs(), diagnostics: deps.diagnostics }))
    }
    return results
  })
  const byRow = new Map([...settled, ...grouped.flat()].map((result) => [result.row_id, result]))
  const ordered = request.row_ids.flatMap((rowId) => byRow.get(rowId) ?? [])
  const failed = ordered.filter((result) => result.outcome === "blocked" || result.outcome === "unknown" || result.outcome === "needs_review").length
  listingLog({
    module: "submit",
    event: "batch.end",
    level: failed > 0 ? "warn" : "info",
    correlation: { batchId: listingBatchId },
    durationMs: Math.round(performance.now() - listingStarted),
    fields: { rows: ordered.length, outcome: failed > 0 ? "partial" : "ok" },
  })
  return ordered
}
