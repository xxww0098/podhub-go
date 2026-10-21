/**
 * One legacy Cloud-row Store chunk: resident raw rows at the
 * click's exact pins → the Card's stored payload → the coordinate's resident
 * native material (`listing-material-cache`) → a WASM schema handle keyed by
 * the material signature → native op 11 freeze via the Ozon adapter → one persistent-intent batch POST for the whole chunk.
 *
 * TypeScript never composes, serializes or hashes a Seller body: the native
 * core does, and Cloud freezes the canonical snapshot optimistically, then
 * checks its revision with CAS before committing the intent and job.
 * Anything refused before the POST is `blocked` (nothing was dispatched);
 * only the POST itself can end `unknown`.
 */
import { loadMaterial, type CategoryCoordinate, type NativeSchemaMaterial } from "@/bindings/listing-material-cache"
import type { WorkflowOperationRowResult } from "@/bindings/commands"
import type { ListingRowView } from "@/bindings/listing-projection"
import { cachedListingRow, readListingRowFresh, residentListingRow } from "@/bindings/listing-row-cache"
import { refuse } from "@/bindings/refusal"
import { sharedListingCore, type ListingCoreClient } from "@/listing-core/client"
import type { CardPayload as NativeCard, LeanRow, SchemaLoadInput } from "@/listing-core/types"
import { reportError } from "@/lib/diag-log"
import { createSessionCache } from "@/lib/session-cache"
import { positiveId } from "@/lib/utils"
import { openCardSession } from "../card/card-session"
import type { FrozenItem, PlatformIssue } from "../platforms/core"
import { createOzonAdapter, type OzonBody, type OzonFreezeCore } from "../platforms/ozon"
import { errorFields } from "../prepare/execution-context"
import { mapLimit } from "../source-batch"
import { blocked, cancelledResult, nativeRow, revisionMismatch, type RowPin } from "./send-local"
import { submitOzonChunk, type OzonSendContext } from "./send-ozon-transport"
import { capturePublishDiagnostic, diagnosticReferenceFrom, type DiagnosticRowResult, type PublishDiagnosticDispatch } from "../model/publish-diagnostic"

export type SendCore = OzonFreezeCore & { loadSchema(material: SchemaLoadInput): number | Promise<number> }

const ROW_READ_CONCURRENCY = 4
/** Failures of this code, not of the listing: reported once, never as a business refusal. */
const TECHNICAL = new Set(["core_unavailable", "build_failed"])

let productionCore: ListingCoreClient | undefined

/** One lazily instantiated `listing-core-wasm` per tab, loaded on the first send. */
export function defaultSendCore(bytes?: BufferSource): SendCore {
  productionCore ??= sharedListingCore(bytes)
  return productionCore
}

// ---- resident schema handles -------------------------------------------------

/** Registers with `invalidateAllSessionCaches`, so an identity switch retires every handle. */
const identity = createSessionCache<true>(async () => true)
const handles = new WeakMap<SendCore, Map<string, { handle: Promise<number>, current: () => boolean }>>()

/**
 * ponytail: retired handles are never `dropSchema`d; a tab keeps one per
 * material signature it sent with. Drop the replaced handle once sends are
 * refcounted if a long session's WASM memory ever matters.
 */
function schemaHandle(core: SendCore, material: NativeSchemaMaterial): Promise<number> {
  let resident = handles.get(core)
  if (!resident) handles.set(core, resident = new Map())
  const hit = resident.get(material.signature)
  if (hit?.current()) return hit.handle
  const entry = { handle: (async () => core.loadSchema(material.input))(), current: identity.captureFence("") }
  resident.set(material.signature, entry)
  entry.handle.catch(() => {
    if (resident.get(material.signature) === entry) resident.delete(material.signature)
    if (core === productionCore) productionCore = undefined
  })
  return entry.handle
}

function reportTechnical(code: string, stage: string): void {
  reportError("[listing-send]", { code }, { code }, { platform: "ozon", stage, rawPayload: null })
}

// ---- inputs -----------------------------------------------------------------

type Group = { cardId: string, coordinate: CategoryCoordinate, rows: Map<string, LeanRow> }

/** The row at exactly the click's revision: resident when possible, else one shared read. */
async function pinnedRow(rowId: string, revision: number): Promise<ListingRowView | WorkflowOperationRowResult> {
  const cached = cachedListingRow(rowId)
  const row = !cached ? await residentListingRow(rowId) : cached.revision < revision ? await readListingRowFresh(rowId) : cached
  return row.revision === revision ? row : revisionMismatch(rowId)
}

/** The click's pinned row plus its native payload, or the exact refusal that stopped it. */
export async function resolveNativeRow(
  rowId: string,
  revision: number,
): Promise<WorkflowOperationRowResult | { view: ListingRowView; row: LeanRow }> {
  const view = await pinnedRow(rowId, revision)
  if ("outcome" in view) return view
  const native = nativeRow(view)
  return "refusal" in native ? native.refusal : { view, row: native.row }
}

async function nativeCard(cardId: string): Promise<NativeCard> {
  const payload = (await openCardSession(cardId)).card().payload as Partial<NativeCard> | undefined
  if (!payload || !positiveId(payload.descriptionCategoryId) || !positiveId(payload.typeId) || typeof payload.aiFieldPolicy !== "object") {
    throw refuse("workflow_card_payload_invalid", "上架方案缺少类目信息，无法生成发送内容", "重新打开上架方案并确认类目后再发送")
  }
  return payload as NativeCard
}

async function nativeHandle(core: SendCore, material: NativeSchemaMaterial): Promise<number> {
  try {
    return await schemaHandle(core, material)
  } catch {
    reportTechnical("core_schema_load_failed", "schema_load")
    const detail = await capturePublishDiagnostic({ platform: "ozon", stage: "freeze", family: "control", code: "wasm_failed" })
    throw Object.assign(refuse("workflow_core_unavailable", "本地上架内核无法加载类目字段", "刷新页面后重试；仍失败请联系管理员"),
      detail?.event ? { publishDiagnostic: { diagnosticId: detail.diagnosticId, traceId: detail.event.trace_id } } : {})
  }
}

export function refusedBeforeDispatch(rowId: string, reason: unknown): DiagnosticRowResult {
  return { row_id: rowId, outcome: "blocked", blockers: [], error: errorFields(reason), publishDiagnostic: diagnosticReferenceFrom(reason) }
}

async function issuesResult(rowId: string, issues: readonly PlatformIssue[]): Promise<DiagnosticRowResult> {
  const first = issues[0]
  if (!first) return blocked(rowId, "ozon_build_refused", "本地未能生成该商品的发送内容", "刷新页面后重试")
  const messages = [...new Set(issues.map((issue) => issue.field ? `${issue.message}（${issue.field}）` : issue.message))]
  const result: DiagnosticRowResult = blocked(rowId, `ozon_${first.code}`, messages.join("；"), first.remediation)
  // Normalize native coordinates BEFORE the legacy error triple collapses them.
  for (const issue of issues) {
    const detail = await capturePublishDiagnostic(issue)
    if (detail?.event && !result.publishDiagnostic) result.publishDiagnostic = {
      eventKey: detail.diagnosticId, diagnosticId: detail.diagnosticId, traceId: detail.event.trace_id,
    }
  }
  return result
}

async function publishGroups(
  core: SendCore, groups: readonly Group[], context: OzonSendContext, force: boolean, nowMs: number,
): Promise<Map<string, WorkflowOperationRowResult>> {
  const out = new Map<string, WorkflowOperationRowResult>()
  const adapter = createOzonAdapter(core)
  const frozen: FrozenItem<OzonBody>[] = []
  for (const group of groups) {
    const rowIds = [...group.rows.keys()].filter((rowId) => {
      if (!context.shouldStop(rowId)) return true
      out.set(rowId, cancelledResult(rowId))
      return false
    })
    if (rowIds.length === 0) continue
    try {
      const card = await nativeCard(group.cardId)
      const material = await loadMaterial(group.coordinate, { force })
      const schemaHandle = await nativeHandle(core, material)
      const built = await adapter.build({ schemaHandle, card, nowMs, rows: rowIds.map((rowId) => ({ rowId, storeId: context.storeId, row: group.rows.get(rowId)! })) })
      for (const item of built.blocked) out.set(item.key, await issuesResult(item.key, item.issues))
      const technical = built.blocked.flatMap((item) => item.issues).find((issue) => TECHNICAL.has(issue.code))
      if (technical) reportTechnical(technical.code, "freeze")
      frozen.push(...built.frozen)
    } catch (reason) {
      for (const rowId of rowIds) out.set(rowId, refusedBeforeDispatch(rowId, reason))
    }
  }
  // All native groups join one legacy POST; no generic send/retry/readback API.
  await submitOzonChunk(context, frozen)
  return out
}

export type NativeChunk = {
  core: SendCore
  storeId: string
  rowIds: readonly string[]
  pins: ReadonlyMap<string, RowPin>
  shouldStop: (rowId: string) => boolean
  nowMs: number
  diagnostics?: PublishDiagnosticDispatch
}

/** One ≤100-row chunk for one Store. Never throws; every row gets a result. */
export async function sendNativeChunk({ core, storeId, rowIds, pins, shouldStop, nowMs, diagnostics }: NativeChunk): Promise<WorkflowOperationRowResult[]> {
  const results = new Map<string, WorkflowOperationRowResult>()
  const live = rowIds.filter((rowId) => {
    if (!shouldStop(rowId)) return true
    results.set(rowId, cancelledResult(rowId))
    return false
  })
  const groups = new Map<string, Group>()
  const resolved = await mapLimit(live, ROW_READ_CONCURRENCY, async (rowId) => {
    try {
      return await resolveNativeRow(rowId, pins.get(rowId)!.revision)
    } catch (reason) {
      return refusedBeforeDispatch(rowId, reason)
    }
  })
  live.forEach((rowId, index) => {
    const found = resolved[index]!
    if ("outcome" in found) return void results.set(rowId, found)
    const { descriptionCategoryId, typeId, language } = found.row
    const key = JSON.stringify([found.view.card_id, descriptionCategoryId, typeId, language])
    let group = groups.get(key)
    if (!group) groups.set(key, group = { cardId: found.view.card_id, coordinate: { descriptionCategoryId, typeId, language: language as CategoryCoordinate["language"] }, rows: new Map() })
    group.rows.set(rowId, found.row)
  })
  const context: OzonSendContext = { storeId, pins, shouldStop, diagnostics, results: new Map(), syncRequired: false, replayed: false }
  let built = await publishGroups(core, [...groups.values()], context, false, nowMs)
  if (context.syncRequired) {
    // Cloud proved nothing was written: refresh the material, freeze again, and
    // replay the original pins once. Rows are not re-read.
    context.syncRequired = false
    context.replayed = true
    built = await publishGroups(core, [...groups.values()], context, true, nowMs)
  }
  for (const [rowId, result] of [...built, ...context.results]) results.set(rowId, result)
  return rowIds.flatMap((rowId) => results.get(rowId) ?? [])
}
