import type {
  WorkflowDraftView,
  WorkflowProductLifecycle,
  WorkflowProductStatusView,
  WorkflowProductSaveResult,
} from "@/bindings/commands"
import { brandRepairEligible } from "./brand-repair"
import type { ListingRow } from "./model/listing-row"
import {
  bucketOf,
  lifecycleSealed,
  rowStatusFromLifecycle,
} from "./model/listing-row-lifecycle"
import { rowPreparing, trackBusy, type PreparationActivity } from "./prepare/preparation-tracks"
import { persistProductDraft } from "./product-instances"

/**
 * The four batch verbs.
 *
 * Each one spends something the operator cannot take back — an AI request, a
 * render slot, an S3 upload, an Ozon dispatch — so the renderer keeps exactly
 * one entry point per verb and this module holds what that entry point does.
 * Splitting it out of `workflow-screen.tsx` makes the Cloud HTTP contract
 * testable: a mocked fetch can watch the real routes and payloads go by.
 *
 * Recognition, slicing and uploading each hold a separate lane and the Product
 * lifecycle keeps `ai` and `media` apart. The one overlap refused is slicing
 * and uploading the same row at once, and `PreparationActivity` is what the
 * eligibility predicates below consult to keep that row out of both.
 */

export type BatchRowDeps = {
  feedbackContext?: { stage?: string; cardId?: string }
  /**
   * The live Product Instance map. A getter, not a snapshot: recognition writes
   * a draft back mid-run and the next read has to see it.
   */
  drafts: () => Record<string, WorkflowDraftView | undefined>
  patchRow: (rowId: string, patch: Partial<ListingRow>) => void
  /** Mark every admitted row before its Cloud call starts. */
  startRows: (rowIds: readonly string[], patch: Partial<ListingRow>) => void
  /**
   * Land one streamed row projection on its Product Instance — Draft values
   * included, merged over what the map holds.
   *
   * Without this the table kept the renderer's pre-recognition copy and 名称 /
   * 简介 stayed empty until the card was reopened, or until the batch's last
   * row settled. The executor streams the projection per leg precisely so the
   * table does not have to wait for either.
   */
  commitProduct: (draftId: string, status: WorkflowProductStatusView) => void
  /**
   * Re-read the Cloud ListingRowView onto one row. Every step ends here rather than
   * projecting what the renderer believes it just did — the lifecycle is the
   * only thing that survives a restart.
   */
  settleRow: (row: ListingRow, log: string, failed: boolean) => Promise<void>
  /**
   * Close the renderer's batch counter for one row, so finished work cannot
   * linger as「未结算」. A streamed row settles here the moment it lands; the
   * batch's own sweep then relies on the caller's outstanding set to not count
   * that row twice.
   */
  settleProgress: (rowId: string, failed: boolean) => void
  /**
   * Cooperative stop: unstarted work is skipped; in-flight Cloud calls finish.
   * Absent means the batch never stops of its own accord.
   */
  stopRequested?: () => boolean
}

/** A sealed row has a terminal Ozon receipt; Cloud refuses to touch it. */
export function preparationOpen(lifecycle?: WorkflowProductLifecycle): boolean {
  return !lifecycle || !lifecycleSealed(lifecycle)
}

/**
 * Rows recognition still owes. A row already recognised is skipped: every
 * request is bought, and a card of a thousand rows re-recognised by a stray
 * click spends a thousand more. Re-running one anyway is deliberate — see
 * [`aiBatchEligibleForced`].
 */
export function aiBatchEligible(
  row: ListingRow,
  lifecycle: WorkflowProductLifecycle | undefined,
  activity: PreparationActivity,
): boolean {
  return lifecycle?.ai !== "ready" && aiBatchEligibleForced(row, lifecycle, activity)
}

/**
 * Recognition targets including rows that already succeeded, for the operator
 * who wants a new answer for the whole selection and accepts paying for it.
 * Only a request already in flight is skipped.
 */
export function aiBatchEligibleForced(
  row: ListingRow,
  lifecycle: WorkflowProductLifecycle | undefined,
  activity: PreparationActivity,
): boolean {
  return (
    Boolean(row.source) &&
    preparationOpen(lifecycle) &&
    lifecycle?.ai !== "running" &&
    !trackBusy(activity, "ai", row.id)
  )
}

/**
 * Successful slices already on the Product — re-slice is 清空, not another
 * render. A failed render can retain an older manifest, so the current Cloud
 * phase decides whether slicing succeeded. Explicit slicing stays available
 * after an upload failure to recover missing local bytes.
 */
export function slicesAlreadySucceeded(
  lifecycle?: WorkflowProductLifecycle,
): boolean {
  return Boolean(
    lifecycle &&
      ["rendered", "uploading", "ready"].includes(lifecycle.media),
  )
}

/** Slicing needs the source image, a free media track, and no successful slices. */
export function renderBatchEligible(
  row: ListingRow,
  lifecycle: WorkflowProductLifecycle | undefined,
  activity: PreparationActivity,
): boolean {
  return (
    Boolean(row.source) &&
    preparationOpen(lifecycle) &&
    !slicesAlreadySucceeded(lifecycle) &&
    lifecycle?.media !== "rendering" &&
    lifecycle?.media !== "uploading" &&
    !trackBusy(activity, "render", row.id)
  )
}

/**
 * Delivery reconfirms an existing manifest. A submit gate can invalidate
 * media readiness while every image still carries its old public receipt.
 *
 * A row this session is still slicing has no deliverable slices yet even when
 * the renderer's cached lifecycle still lists the previous run's: `activity`
 * answers from the live claim, so an upload started next to a running slice
 * batch picks up the rows that finished and leaves the rest alone.
 */
export function deliverBatchEligible(
  row: ListingRow,
  lifecycle: WorkflowProductLifecycle | undefined,
  activity: PreparationActivity,
): boolean {
  return Boolean(
    lifecycle &&
      (lifecycle.media === "rendered" || lifecycle.media === "uploading" ||
        (lifecycle.media === "failed" && lifecycle.media_failure_stage === "upload")) &&
      preparationOpen(lifecycle) &&
      lifecycle.image_total > 0 &&
      (lifecycle.media === "rendered" || lifecycle.image_total > lifecycle.image_completed) &&
      !trackBusy(activity, "deliver", row.id),
  )
}

/** Send follows Cloud readiness. In-flight submission phases stay closed; a field snapshot does not. */
const CLOSED_SUBMISSION_STAGES = [
  "queued",
  "submitting",
  "accepted",
  "outcome_unknown",
  "operator_attested",
] as const

export function sendBatchEligible(
  row: ListingRow,
  lifecycle?: WorkflowProductLifecycle,
): boolean {
  if (
    lifecycle &&
    CLOSED_SUBMISSION_STAGES.includes(lifecycle.stage as (typeof CLOSED_SUBMISSION_STAGES)[number])
  ) {
    return false
  }
  if (row.readiness) {
    return (
      row.readiness.can_start_publish_attempt &&
      row.readiness.allowed_actions.includes("publish")
    )
  }
  // Pre-hydration fallback mirrors Cloud's send gate: readiness is not cleared
  // by a stale build stamp, so build_stale is sendable here too (send restamps).
  return lifecycle?.stage === "ready_to_publish" || lifecycle?.stage === "build_stale"
}

/**
 * Which prepare lanes 一键准备 still owes. Recognition re-runs only when it is
 * not already ready; a row whose slices are public skips both render and
 * delivery so the click spends one AI request and nothing else.
 */
export function guidedPreparationLanes(
  rows: readonly ListingRow[],
  lifecycleOf: (row: ListingRow) => WorkflowProductLifecycle | undefined,
  activity: PreparationActivity,
): { ai: string[]; render: string[]; deliver: string[] } {
  const ai: string[] = []
  const render: string[] = []
  const deliver: string[] = []
  for (const row of rows) {
    const lifecycle = lifecycleOf(row)
    if (aiBatchEligible(row, lifecycle, activity)) ai.push(row.id)
    // Leftover slices after a delivery failure: retry upload. An explicit 切片
    // click still goes through renderBatchEligible; 一键准备 must not spend a
    // second PSD pass on every failed row.
    if (
      renderBatchEligible(row, lifecycle, activity) &&
      !(lifecycle?.media === "failed" && lifecycle.media_failure_stage === "upload")
    ) {
      render.push(row.id)
    }
    if (deliverBatchEligible(row, lifecycle, activity)) deliver.push(row.id)
  }
  return { ai, render, deliver }
}

// Browser executor Jobs: `workflowSlice` commits slices, `workflowUpload`
// records each public image.

/**
 * The durable write behind one edited cell.
 *
 * There is no second "mark changed" call any more, and no second read either:
 * `PATCH /api/listing/rows/{id}` with a `draft` re-runs the invalidation graph
 * and the validator inside the one CAS write and answers with the row it wrote
 * (`listing_api/rows.rs::write_draft`), so the verdict and the lifecycle both
 * come out of that one response.
 */
export async function persistRowEdit(
  view: WorkflowDraftView,
  baseline: WorkflowDraftView,
  fields?: import("./model/product-edit").ProductEditFields,
  known?: WorkflowDraftView,
): Promise<WorkflowProductSaveResult> {
  return persistProductDraft(view, baseline, fields, known)
}

/** What each ribbon verb would act on, plus the counts the ribbon prints. */
export type WorkbenchScopes = {
  picked: ListingRow[]
  unsent: ListingRow[]
  sentCount: number
  aiReadyCount: number
  mediaReadyCount: number
  awaitingReceiptCount: number
  unknownOutcomeCount: number
  exceptionCount: number
  aiTargets: ListingRow[]
  renderTargets: ListingRow[]
  deliverTargets: ListingRow[]
  prepareTargets: ListingRow[]
  clearTargets: ListingRow[]
  sendTargets: ListingRow[]
  repairTargets: ListingRow[]
  /** Rows whose send went unanswered; only an operator release reopens them. */
  releaseTargets: ListingRow[]
}

/**
 * Which rows a verb would act on, decided next to the eligibility predicates
 * it composes. A second copy of these filters in the screen is how a button
 * ends up counting rows the verb then skips.
 */
export function workbenchScopes(
  rows: ListingRow[],
  productDrafts: Record<string, { lifecycle?: WorkflowProductLifecycle }>,
  selectedRowIds: ReadonlySet<string>,
  activity: PreparationActivity,
  queueRunning: boolean,
  queuePaused: boolean,
): WorkbenchScopes {
  const picked: ListingRow[] = []
  const unsent: ListingRow[] = []
  let sentCount = 0
  let aiReadyCount = 0
  let mediaReadyCount = 0
  let unknownOutcomeCount = 0
  let exceptionCount = 0
  for (const row of rows) {
    if (selectedRowIds.has(row.id)) picked.push(row)
    const lifecycle = productDrafts[row.draftId]?.lifecycle
    const sent = lifecycle ? rowStatusFromLifecycle(lifecycle) === "sent" : row.status === "sent"
    if (sent) sentCount += 1
    else unsent.push(row)
    if (lifecycle?.ai === "ready") aiReadyCount += 1
    if (lifecycle?.media === "ready") mediaReadyCount += 1
    const unknown = (row.stage ?? productDrafts[row.draftId]?.lifecycle?.stage) === "outcome_unknown"
    if (unknown) unknownOutcomeCount += 1
    if (unknown && (queueRunning || queuePaused)) continue
    if (lifecycle && bucketOf(lifecycle) === "exceptions") {
      exceptionCount += 1
    }
  }
  const scope = picked.length ? picked : unsent
  const aiTargets: ListingRow[] = []
  const renderTargets: ListingRow[] = []
  const deliverTargets: ListingRow[] = []
  const prepareTargets: ListingRow[] = []
  const clearTargets: ListingRow[] = []
  for (const row of scope) {
    const lifecycle = productDrafts[row.draftId]?.lifecycle
    if (aiBatchEligible(row, lifecycle, activity)) aiTargets.push(row)
    if (renderBatchEligible(row, lifecycle, activity)) renderTargets.push(row)
    if (deliverBatchEligible(row, lifecycle, activity)) deliverTargets.push(row)
    if (
      row.source &&
      (!lifecycle || !lifecycleSealed(lifecycle)) &&
      (lifecycle?.ai !== "ready" || lifecycle?.media !== "ready")
    ) {
      prepareTargets.push(row)
    }
    if (
      lifecycle &&
      !lifecycleSealed(lifecycle) &&
      row.status !== "running" &&
      !rowPreparing(activity, row.id)
    ) {
      clearTargets.push(row)
    }
  }
  const sendTargets: ListingRow[] = []
  for (const row of unsent) {
    if (sendBatchEligible(row, productDrafts[row.draftId]?.lifecycle)) sendTargets.push(row)
  }
  const repairTargets = scope.filter((row) =>
    brandRepairEligible(row, productDrafts[row.draftId]?.lifecycle, row.readiness, activity),
  )
  const releaseTargets = queueRunning || queuePaused
    ? []
    : (picked.length ? picked : rows).filter((row) =>
      (row.stage ?? productDrafts[row.draftId]?.lifecycle?.stage) === "outcome_unknown")
  return {
    picked,
    unsent,
    sentCount,
    aiReadyCount,
    mediaReadyCount,
    awaitingReceiptCount: queueRunning ? unknownOutcomeCount : 0,
    unknownOutcomeCount: queuePaused ? unknownOutcomeCount : 0,
    exceptionCount,
    aiTargets,
    renderTargets,
    deliverTargets,
    prepareTargets,
    clearTargets,
    sendTargets,
    repairTargets,
    releaseTargets,
  }
}
