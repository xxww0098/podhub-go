import { listingHttp } from "@/bindings/http-listing"
import type {
  WorkflowDraftView,
  WorkflowProductSaveResult,
  WorkflowImportSourceBatchItemResult,
  CategorySchemaView,
} from "@/bindings/commands"
import { workflowActions } from "./workflow-actions"
import { stagedFile } from "@/bindings/file-picker"
import { dropRender } from "@/render/opfs"
import type { ListingRow } from "./model/listing-row"
import {
  aiTrackFromLifecycle,
  renderTrackFromLifecycle,
  rowStatusFromLifecycle,
  uploadTrackFromLifecycle,
} from "./model/listing-row-lifecycle"
import {
  commandError,
} from "./workflow-shared"
import { mapLimit } from "./source-batch"
import { openSourceImportBatch, stageSourcePaths } from "./source-import-actions"
import { recoverStagedSources, type SourceRecovery } from "./source-import-recovery"
import { listingScopeCurrent, listingWorkbenchScope } from "./workbench/listing-workbench-store"

export function composeBlockedBySignedOut(
  account: { session: { authenticated: boolean } } | undefined,
): boolean {
  return !account || !account.session.authenticated
}

export function publishFailureStaysOnRow(reason: unknown): boolean {
  return (
    typeof reason === "object" &&
    reason !== null &&
    "code" in reason &&
    (reason as { code?: unknown }).code === "workflow_publish_fields_invalid"
  )
}

export function fieldInvalidRowPatch(reason: unknown): {
  status: "failed"
  log: string
} {
  return {
    status: "failed",
    log: commandError(reason, "字段未通过 Listing 校验"),
  }
}

/** Split preparation targets by whether their Product Instance is in the draft map. */
export function rowsReadyForPreparation(
  rows: readonly ListingRow[],
  drafts: Record<string, WorkflowDraftView | undefined>,
): { runnable: ListingRow[]; missing: ListingRow[] } {
  const runnable: ListingRow[] = []
  const missing: ListingRow[] = []
  for (const row of rows) {
    if (drafts[row.draftId]) runnable.push(row)
    else missing.push(row)
  }
  return { runnable, missing }
}

export function resolveRunnerEntry(saved: WorkflowDraftView) {
  if (saved.kind !== "template") {
    throw new Error("只能打开上架方案，不能打开商品草稿。")
  }
  return saved
}

export function offerIdForSource(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "")
}

/**
 * The single durable write for a Product Instance draft.
 *
 * A row is not a card: it is `PATCH /api/listing/rows/{id}` with the Draft, and
 * the prompt, template and AI policy it inherits from its card are not the
 * row's to rewrite. The row `revision` is the CAS fence, so there is no second
 * token to carry.
 */
export async function persistProductDraft(
  view: WorkflowDraftView,
  baseline: WorkflowDraftView,
  fields?: import("./model/product-edit").ProductEditFields,
  known?: WorkflowDraftView,
): Promise<WorkflowProductSaveResult> {
  return workflowActions.listingRowSaveDraft(view, baseline, fields, known)
}

export type SourceImportResult = {
  rows: ListingRow[]
  products: Record<string, WorkflowDraftView>
  failures: string[]
  cancelled: number
  /** Loaded rows whose missing local source this batch restored, with no Cloud write. */
  restoredRows: number
  /** Picked files whose rows already showed that exact source; nothing was filed. */
  presentFiles: number
  /** New files `admitNew` held back; the gate owns the reason. */
  heldFiles: number
}

export type SourceImportItemOutcome = {
  inputIndex: number
  row?: ListingRow
  product?: WorkflowDraftView
  failure?: string
  cancelled?: boolean
  /** A loaded row already carries this exact file: restored locally, nothing filed. */
  recovered?: SourceRecovery
  held?: boolean
}

type SourceImportItem = {
  label: string
  path: string
}

export type ImportPaintScheduler = {
  push: (item: SourceImportItemOutcome) => void
  flush: () => void
}

function defaultImportPaintSchedule(flush: () => void) {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(flush)
    return
  }
  queueMicrotask(flush)
}

/**
 * Collapse a burst of import results into one workbench commit.
 * Two hundred per-item `setState`s are what made a large drop stutter.
 */
export function createImportPaintScheduler(
  paint: (batch: SourceImportItemOutcome[]) => void,
  schedule: (flush: () => void) => void = defaultImportPaintSchedule,
): ImportPaintScheduler {
  let pending: SourceImportItemOutcome[] = []
  let scheduled = false
  const run = () => {
    scheduled = false
    const batch = pending
    pending = []
    if (batch.length) paint(batch)
  }
  return {
    push(item) {
      pending.push(item)
      if (scheduled) return
      scheduled = true
      schedule(run)
    },
    flush() {
      if (!pending.length && !scheduled) return
      scheduled = false
      run()
    },
  }
}

/**
 * Insert one newly imported row after the pre-import prefix, ordered by
 * queue position. Completion order must not reshuffle the durable queue.
 */
export function upsertImportedListingRow(
  current: readonly ListingRow[],
  prefixDraftIds: ReadonlySet<string>,
  row: ListingRow,
  queuePositionByDraftId: ReadonlyMap<string, number>,
): ListingRow[] {
  if (current.some((candidate) => candidate.draftId === row.draftId)) {
    return current as ListingRow[]
  }
  const prefix = current.filter((candidate) => prefixDraftIds.has(candidate.draftId))
  const imported = [
    ...current.filter((candidate) => !prefixDraftIds.has(candidate.draftId)),
    row,
  ].sort((left, right) => {
    const leftPos = queuePositionByDraftId.get(left.draftId) ?? Number.MAX_SAFE_INTEGER
    const rightPos = queuePositionByDraftId.get(right.draftId) ?? Number.MAX_SAFE_INTEGER
    if (leftPos !== rightPos) return leftPos - rightPos
    return left.draftId.localeCompare(right.draftId)
  })
  return [...prefix, ...imported]
}

export function attachCardSchema(
  product: WorkflowDraftView,
  cardSchema: CategorySchemaView,
): WorkflowDraftView {
  if (product.schema.fields.length) return product
  return { ...product, schema: cardSchema }
}

function listingRowFromImport(
  stored: WorkflowDraftView,
  source: NonNullable<WorkflowImportSourceBatchItemResult["source"]>,
  readiness: WorkflowImportSourceBatchItemResult["status"],
  importedLog: string,
): ListingRow {
  return {
    id: stored.draft_id,
    draftId: stored.draft_id,
    imageName: source.file_name,
    source,
    status: rowStatusFromLifecycle(stored.lifecycle),
    ai: aiTrackFromLifecycle(stored.lifecycle),
    render: renderTrackFromLifecycle(stored.lifecycle),
    upload: uploadTrackFromLifecycle(stored.lifecycle),
    readiness: readiness?.readiness,
    log: importedLog,
  }
}

/**
 * One batch result as a workbench outcome. Exported for the same-design
 * coordinator (`source-import-same-design.ts`), which files one Card at a time
 * through the same per-card path and must map its answers the same way.
 */
export function mapImportItemResult(
  result: WorkflowImportSourceBatchItemResult,
  items: readonly SourceImportItem[],
  importedLog: string,
): SourceImportItemOutcome {
  const label = items[result.input_index]?.label ?? "未知图片"
  if (result.error?.code === "workflow_source_import_cancelled") {
    return { inputIndex: result.input_index, cancelled: true }
  }
  if (result.error || !result.product || !result.source) {
    return {
      inputIndex: result.input_index,
      failure: `${label}：${commandError(result.error, "图片导入失败")}`,
    }
  }
  return {
    inputIndex: result.input_index,
    product: result.product,
    row: listingRowFromImport(result.product, result.source, result.status, importedLog),
  }
}

function collectImportResult(
  items: readonly SourceImportItem[],
  byIndex: ReadonlyMap<number, SourceImportItemOutcome>,
): SourceImportResult {
  const rows: ListingRow[] = []
  const products: Record<string, WorkflowDraftView> = {}
  const failures: string[] = []
  let cancelled = 0
  let restoredRows = 0
  let presentFiles = 0
  let heldFiles = 0
  for (const [index, item] of items.entries()) {
    const mapped = byIndex.get(index)
    if (!mapped) {
      failures.push(`${item.label}：图片导入后台任务没有返回结果`)
      continue
    }
    if (mapped.cancelled) {
      cancelled += 1
      continue
    }
    if (mapped.recovered) {
      restoredRows += mapped.recovered.restoredRows
      if (!mapped.recovered.restoredRows) presentFiles += 1
      continue
    }
    if (mapped.held) {
      heldFiles += 1
      continue
    }
    if (mapped.failure) failures.push(mapped.failure)
    if (mapped.row) rows.push(mapped.row)
    if (mapped.product) products[mapped.product.draft_id] = mapped.product
  }
  return { rows, products, failures, cancelled, restoredRows, presentFiles, heldFiles }
}

/**
 * Turn picked source files into the open Card's rows: restore what it already
 * holds, file one durable Product Instance per genuinely new file.
 *
 * Every file is staged to OPFS once, first. A file whose exact identity a
 * loaded row of this Card carries restores that row's local source and ends
 * there — a batch of only such files makes no request at all
 * (`source-import-recovery.ts`). The rest pass `admitNew` (the caller's gates
 * for new rows) and then the normal Card / Schema / create contract, reusing
 * the staged identity. One import batch owns Product Instance creation, source
 * binding, Listing projection and queue order. Results stay in input order and
 * a failed item has no durable Product Instance. A workbench scope change
 * while staging or gating fences both the restore and every later create.
 */
export async function importSourcePaths({
  paths,
  cardTemplateId,
  importedLog,
  storeResolver,
  onItem,
  admitNew,
}: {
  paths: readonly string[]
  cardTemplateId: string
  importedLog: string
  /** Optional target Store resolver by the index among the admitted new files. */
  storeResolver?: (batchIndex: number) => string
  onItem?: (item: SourceImportItemOutcome) => void
  /**
   * Called once, only when new files exist, after every restore is on the
   * workbench; answers how many of them (in input order) may reach Cloud.
   * Omitted: all of them.
   */
  admitNew?: (count: number) => Promise<number>
}): Promise<SourceImportResult> {
  const scope = listingWorkbenchScope()
  const stopRequested = openSourceImportBatch()
  const stopped = () => stopRequested() || !listingScopeCurrent(scope)
  // The label is the file the operator picked, and a browser "path" is a
  // staging handle rather than a name — the staging table is where the name
  // still is (`bindings/file-picker.ts`).
  const items: SourceImportItem[] = paths.map((path) => ({
    path,
    label: stagedFile(path)?.name ?? path.split(/[\\/]/).pop() ?? path,
  }))
  const byIndex = new Map<number, SourceImportItemOutcome>()
  const settle = (mapped: SourceImportItemOutcome) => {
    if (byIndex.has(mapped.inputIndex)) return
    byIndex.set(mapped.inputIndex, mapped)
    if (!mapped.cancelled && !mapped.held) onItem?.(mapped)
  }
  const stages = await stageSourcePaths(paths, stopped)
  const recoveries = listingScopeCurrent(scope)
    ? recoverStagedSources(stages.map((stage) => stage.staged), { cardId: cardTemplateId, scope })
    : []
  const fresh: number[] = []
  for (const [index, stage] of stages.entries()) {
    const recovered = recoveries[index]
    if (recovered) settle({ inputIndex: index, recovered })
    else if (stage.staged) {
      // Import preflight mirrors listing-core/validate/scalar.rs; publish keeps
      // the authoritative check. Restore existing sources before this gate:
      // their manually edited offer_id need not match the original filename.
      const offerId = offerIdForSource(stage.staged.fileName).trim()
      if (!/^[A-Za-z0-9_-]{1,50}$/.test(offerId)) {
        settle({
          inputIndex: index,
          failure: `${items[index]!.label}：文件名（不含扩展名）将作为货号，须为 1–50 个英文字母、数字、短横线 - 或下划线 _；请重命名后重新导入`,
        })
      } else fresh.push(index)
    }
    else settle(mapImportItemResult({ input_index: index, error: stage.error }, items, importedLog))
  }
  let admitted = fresh.length
  if (fresh.length && !stopped() && admitNew) {
    admitted = Math.max(0, Math.min(fresh.length, await admitNew(fresh.length)))
    for (const index of fresh.slice(admitted)) settle({ inputIndex: index, held: true })
  }
  const filed = fresh.slice(0, admitted)
  if (filed.length) {
    // Results come back indexed within `filed`; the batch reports input order.
    const settleFiled = (result: WorkflowImportSourceBatchItemResult) =>
      settle(mapImportItemResult({ ...result, input_index: filed[result.input_index]! }, items, importedLog))
    const results = await workflowActions.workflowImportSourceAssets({
      card_draft_id: cardTemplateId,
      items: filed.map((index, batchIndex) => ({
        path: items[index]!.path,
        target_store_id: storeResolver?.(batchIndex) ?? "",
      })),
    }, settleFiled, { staged: filed.map((index) => stages[index]!), stopped })
    for (const result of results) settleFiled(result)
  }
  return collectImportResult(items, byIndex)
}

export type ProductInstanceDeleteFailure = {
  rowId: string
  draftId: string
  reason: unknown
}

export type ProductInstanceDeleteResult = {
  deletedRowIds: string[]
  deletedDraftIds: string[]
  failures: ProductInstanceDeleteFailure[]
}

const PRODUCT_INSTANCE_DELETE_CONCURRENCY = 3

export async function deleteProductInstances(
  rows: readonly Pick<ListingRow, "id" | "draftId">[],
  rowIds: readonly string[],
  // A workbench row is a Product Instance, so this is `DELETE
  // /api/listing/rows/{id}`. Cloud keeps the intent ledger when deleting a row
  // whose publish attempt is still moving.
  deleteSavedDraft: (draftId: string) => Promise<void> = listingHttp.listingRowDelete,
): Promise<ProductInstanceDeleteResult> {
  const requestedIds = new Set(rowIds)
  const deletedRowIds: string[] = []
  const deletedDraftIds: string[] = []
  const failures: ProductInstanceDeleteFailure[] = []
  const outcomes = await mapLimit(
    rows.filter((candidate) => requestedIds.has(candidate.id)),
    PRODUCT_INSTANCE_DELETE_CONCURRENCY,
    async (row) => {
      try {
        await deleteSavedDraft(row.draftId)
        // The row is gone, so its OPFS render is unreachable by any key that
        // still exists (`render/opfs.ts` eviction policy rule 1). Cleanup never
        // un-deletes the row: a failure here leaves bytes for the ceiling.
        await dropRender(row.draftId).catch(() => undefined)
        return { row, deleted: true as const }
      } catch (reason) {
        return { row, deleted: false as const, reason }
      }
    },
  )
  for (const outcome of outcomes) {
    if (outcome.deleted) {
      deletedRowIds.push(outcome.row.id)
      deletedDraftIds.push(outcome.row.draftId)
    } else {
      failures.push({ rowId: outcome.row.id, draftId: outcome.row.draftId, reason: outcome.reason })
    }
  }
  return { deletedRowIds, deletedDraftIds, failures }
}
