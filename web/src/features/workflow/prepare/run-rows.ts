/**
 * The browser executor: the four preparation verbs, run from this tab.
 *
 * Cloud decides — every verb starts
 * with `POST /api/listing/rows/{id}/prepare`, which pins the row revision and
 * says `running` / `waiting` / `needs_review` / `prepared` / `blocked`. This
 * module only *carries out* a pinned job and writes the result back under that
 * pin; it never decides that work is needed, and it never invents a state.
 *
 * Independently scheduled stages:
 * - `ai.recognize` — source bytes from OPFS → `prepareAiImage` →
 *   `POST /api/ai/ocr/completions` → `POST …/rows/{id}/ai/settle`.
 * - `media.render` — commit a render manifest and ordered slices
 * - `media.upload` — confirm each public object against that manifest
 *   each slice through the Local Media Object Set (`media-objects.ts`: a
 *   digest Cloud already confirmed costs nothing, an unknown image is one PUT
 *   and never a probe) and `POST …/rows/{id}/media`. `slice` stops at the
 *   local artifact (`media_state = rendered`); `upload` delivers
 *   already-committed slices. listing-design.md: 切片 and 上传 are separate
 *   operator verbs.
 *
 * `prepare` and `recognize` admit only `AI_CONCURRENCY` rows at a time: `/prepare` pin is
 * owned by that active-row window, not the batch array. The pin frees when that
 * row's recognition finishes, so a slow upload does not hold the next row's
 * recognition. Slice and upload keep their own pools and the pending-upload
 * budget. `slice` / `upload` still walk `ROW_CHUNK` rows at a time; `prepare`
 * and `recognize` do not, so a chunk of uploads cannot fence the next recognition.
 * Only OCR claims Cloud execution through `POST /api/listing/jobs/claim-window`.
 * Media runs locally against its immutable input record, without a Cloud lease.
 *
 * There are no events. Cloud is the truth, and the caller re-reads rows. What
 * a verb does report, per row through `onRow`, is the row Cloud handed back
 * at each leg it settled, so progress streams per row instead of waiting for
 * the whole batch, and one failed row never aborts its siblings.
 */
import type { PreparationRequest } from "./ocr-model-routing"
import type { WorkflowOperationRowResult } from "@/bindings/commands"
import { diagLog, elapsedMs, PREPARE_LOG } from "@/lib/diag-log"
import { bindListingRows, flushListingLogs, listingLog, noteListingRow, offerIdText, psdIdOf, releaseListingBatch } from "@/lib/listing-log"
import { peekListingWorkbench } from "../workbench/listing-workbench-store"
import { currentMediaWorkspaceUuid } from "../media/media-objects"
import { renderClient } from "@/render/client"
import { AI_CONCURRENCY } from "./ai-job"
import { finishUploadBatch } from "./upload-transfer-log"
import { activeBatches, currentCardContext, pendingUploads, type AutomationExecutionScope, type PreparationVerb, type RowBatch } from "./execution-context"
import { mapLimit } from "../source-batch"
import { UPLOAD_CONCURRENCY } from "./media-job"
import { RENDER_ISOLATION_ERROR } from "./executor/capacity"
import { createClaimCoordinator } from "./executor/claim-coordinator"
import { runPreparationRow } from "./executor/row-execution"

/** `slice` and `upload` still settle one block before the next. `prepare` and `recognize` do not use it. */
const ROW_CHUNK = 64

/** Planning and each effect have separate bounded pools. Results retain input order. */
export async function runRows(
  request: PreparationRequest, verb: PreparationVerb,
  onRow?: (row: WorkflowOperationRowResult) => void,
  automationScope?: AutomationExecutionScope,
): Promise<WorkflowOperationRowResult[]> {
  if (verb === "slice" && !currentCardContext().psdTemplateSha256) {
    return request.row_ids.map((row_id) => ({ row_id, outcome: "blocked", blockers: ["missing_template"] }))
  }
  if (verb === "slice" && globalThis.crossOriginIsolated === false) {
    return request.row_ids.map((row_id) => ({ row_id, outcome: "blocked", blockers: [], error: RENDER_ISOLATION_ERROR }))
  }
  diagLog(PREPARE_LOG, "batch", { verb, rows: request.row_ids.length, ai: AI_CONCURRENCY, render: renderClient.maxLanes, upload: UPLOAD_CONCURRENCY })
  const listingBatchId = crypto.randomUUID()
  const listingStarted = performance.now()
  bindListingRows(listingBatchId, request.row_ids, { psdId: psdIdOf(currentCardContext().psdTemplateSha256) })
  const drafts = peekListingWorkbench().productDrafts
  for (const rowId of request.row_ids) {
    const offerId = offerIdText(drafts[rowId]?.draft.values.offer_id)
    if (offerId) noteListingRow(rowId, { offerId })
  }
  listingLog({ module: "prepare", event: "batch.start", correlation: { batchId: listingBatchId }, fields: { verb, rows: request.row_ids.length } })
  const workspaceUuid = currentMediaWorkspaceUuid()
  const batch: RowBatch = { rows: new Set(request.row_ids), cancelled: new Set(), pinned: new Set(), verb }
  batch.modelRouting = request.modelRouting ? { ...request.modelRouting } : undefined
  const claims = createClaimCoordinator()
  const workers = renderClient.createBatch()
  let renderHolders = verb === "slice" || verb === "prepare" ? request.row_ids.length : 0
  if (renderHolders === 0) workers.disposeRender()
  const releaseRenderHolder = () => {
    if (renderHolders <= 0) return
    renderHolders -= 1
    if (renderHolders === 0) workers.disposeRender()
  }
  const run = async (rowId: string, releasePin?: () => void) => {
    if ((verb === "recognize" || verb === "prepare") && batch.cancelled.has(rowId)) {
      releaseRenderHolder()
      releasePin?.()
      const cancelled = { row_id: rowId, outcome: "noop" as const, blockers: [], noop_reason: "cancelled" }
      onRow?.(cancelled)
      return cancelled
    }
    const result = await runPreparationRow(rowId, verb, {
      shouldStop: () => batch.cancelled.has(rowId) || Boolean(workspaceUuid && currentMediaWorkspaceUuid() !== workspaceUuid),
      workers, onRow, onRenderSettled: releaseRenderHolder, batch, claims, onPinReleased: releasePin, automationScope,
    })
    onRow?.(result)
    return result
  }
  activeBatches.add(batch)
  try {
    const pinned = verb === "recognize" || verb === "prepare"
    const settlePinned = async (ids: readonly string[]) => {
      const works: Array<Promise<{ status: "fulfilled", value: WorkflowOperationRowResult } | { status: "rejected", reason: unknown }>> = []
      await mapLimit(ids, AI_CONCURRENCY, async (rowId, index) => {
        let released = false
        let resolvePin = () => {}
        const pin = new Promise<void>((resolve) => { resolvePin = resolve })
        const releasePin = () => {
          if (released) return
          released = true
          resolvePin()
        }
        works[index] = (async () => {
          try {
            return { status: "fulfilled" as const, value: await run(rowId, releasePin) }
          } catch (reason) {
            return { status: "rejected" as const, reason }
          } finally {
            releasePin()
          }
        })()
        await pin
      })
      return Promise.all(works)
    }
    const results: WorkflowOperationRowResult[] = []
    let rejection: unknown
    let failed = false
    const take = async (ids: readonly string[], offset: number) => {
      const settled = pinned ? await settlePinned(ids) : await Promise.allSettled(ids.map((rowId) => run(rowId)))
      for (let index = 0; index < settled.length; index++) {
        const item = settled[index]!
        if (item.status === "rejected") {
          if (!failed) {
            failed = true
            rejection = item.reason
          }
        } else {
          results[offset + index] = item.value
        }
      }
    }
    if (pinned) {
      await take(request.row_ids, 0)
    } else {
      for (let offset = 0; offset < request.row_ids.length; offset += ROW_CHUNK) {
        await take(request.row_ids.slice(offset, offset + ROW_CHUNK), offset)
      }
    }
    if (failed) throw rejection
    return results
  } finally {
    finishUploadBatch(batch)
    claims.dispose()
    pendingUploads.releaseAll(request.row_ids)
    activeBatches.delete(batch)
    workers.dispose()
    listingLog({ module: "prepare", event: "batch.end", durationMs: elapsedMs(listingStarted), correlation: { batchId: listingBatchId }, fields: { verb, rows: request.row_ids.length } })
    flushListingLogs("batch")
    releaseListingBatch(listingBatchId)
  }
}
