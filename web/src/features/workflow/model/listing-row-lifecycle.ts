import type {
  FieldLayerView,
  RowStage,
  WorkflowProductLifecycle,
  WorkflowReadinessReport,
} from "@/bindings/commands"
import { toneFor, type StateTone } from "@/lib/receipt-state"
import type { ListingRow } from "./listing-row"

/** The one-row-stage label the workbench badge shows (06 vocabulary). */
export const STAGE_LABEL: Record<RowStage, string> = {
  awaiting_content: "待导入",
  recognizing: "识别中",
  recognition_failed: "识别失败",
  rendering: "切片中",
  uploading: "上传中",
  media_failed: "媒体失败",
  candidates_pending: "待审候选",
  // A stale stamp is not a broken row: content and media are already ready,
  // send is open, and send restamps. The badge matches 可发送.
  build_stale: "可发送",
  fields_invalid: "字段未通过",
  ready_to_publish: "可发送",
  queued: "已排队",
  submitting: "发送中",
  outcome_unknown: "核对中",
  accepted: "已受理",
  publish_rejected: "发送未完成",
  operator_attested: "人工封存",
}

export function rowStatusFromLifecycle(
  lifecycle: WorkflowProductLifecycle,
): ListingRow["status"] {
  switch (lifecycle.stage) {
    case "accepted":
      return "sent"
    case "outcome_unknown":
    case "operator_attested":
      return "exception"
    case "recognition_failed":
    case "media_failed":
    case "fields_invalid":
    case "publish_rejected":
      return "failed"
    case "recognizing":
    case "rendering":
    case "uploading":
    case "submitting":
    case "queued":
      return "running"
    case "candidates_pending":
      return "review"
    case "build_stale":
    case "ready_to_publish":
      return "ready"
    default:
      return "pending"
  }
}

export function aiTrackFromLifecycle(
  lifecycle: WorkflowProductLifecycle,
): ListingRow["ai"] {
  if (lifecycle.ai === "ready") return "done"
  if (lifecycle.ai === "running") return "running"
  if (lifecycle.ai === "failed") return "failed"
  return "idle"
}

export function renderTrackFromLifecycle(
  lifecycle: WorkflowProductLifecycle,
): ListingRow["render"] {
  if (lifecycle.media === "rendering") return "running"
  if (["rendered", "uploading", "ready"].includes(lifecycle.media)) return "done"
  if (lifecycle.media === "failed") {
    if (lifecycle.media_failure_stage === "render") return "failed"
    if (lifecycle.media_failure_stage === "upload") return "done"
  }
  return "idle"
}

export function uploadTrackFromLifecycle(
  lifecycle: WorkflowProductLifecycle,
): ListingRow["upload"] {
  if (lifecycle.media === "ready") return "done"
  if (lifecycle.media === "uploading") return "running"
  if (lifecycle.media === "failed" && lifecycle.media_failure_stage === "upload") return "failed"
  return "idle"
}

/**
 * The five buckets the batch workbench sorts a row into. They answer "what does
 * this row need from me next", which is a different question from
 * `rowStatusFromLifecycle`'s "what is this row doing" — the queue runner still
 * owns the latter.
 */
export type WorkbenchBucket = "pending" | "ready" | "inFlight" | "sent" | "exceptions"

export const BUCKET_LABEL: Record<WorkbenchBucket, string> = {
  pending: "待处理",
  ready: "可发送",
  inFlight: "发送处理中",
  sent: "已提交",
  exceptions: "请求有误",
}

export function workbenchStatusLabel(
  lifecycle: WorkflowProductLifecycle,
  bucket: WorkbenchBucket,
): string {
  if (bucket !== "inFlight") return BUCKET_LABEL[bucket]
  if (lifecycle.stage === "queued") return "正在提交"
  if (lifecycle.stage === "submitting") return "正在提交"
  return "已提交"
}

/**
 * The row-level Cloud cancel endpoint only accepts queued/submitting intents.
 * The frontend's submitting stage also covers an already-dispatched request,
 * so showing 取消发送 there creates a false affordance. Queued is the only
 * stage whose cancelability is unambiguous from the row projection.
 */
export function canCancelPublishIntent(lifecycle: WorkflowProductLifecycle): boolean {
  return lifecycle.stage === "queued"
}

/** Prepare UI cut from the ListingRowView. Not stored; five-bucket grouping stays. */
export type PrepareUiPhase = "unprepared" | "preparing" | "attention" | "ready" | "sending" | "sent"

export const PREPARE_UI_LABEL: Record<PrepareUiPhase, string> = {
  unprepared: "未准备",
  preparing: "准备中",
  attention: "需处理",
  ready: "可发送",
  sending: "发送中",
  sent: "已提交",
}

export function prepareUiPhase(
  lifecycle: WorkflowProductLifecycle,
): PrepareUiPhase {
  switch (lifecycle.stage) {
    case "accepted":
      return "sent"
    case "queued":
    case "submitting":
      return "sending"
    case "ready_to_publish":
    case "build_stale":
      return "ready"
    case "recognizing":
    case "rendering":
    case "uploading":
      return "preparing"
    case "awaiting_content":
      return "unprepared"
    default:
      return "attention"
  }
}

export function prepareUiLabel(
  lifecycle: WorkflowProductLifecycle,
): string {
  const phase = prepareUiPhase(lifecycle)
  if (phase === "sending") return workbenchStatusLabel(lifecycle, "inFlight")
  if (bucketOf(lifecycle) === "exceptions") return BUCKET_LABEL.exceptions
  return PREPARE_UI_LABEL[phase]
}

const SEALED_STAGES: readonly RowStage[] = [
  "accepted",
  "operator_attested",
  "outcome_unknown",
]

/**
 * Stages Cloud refuses to edit (`reject_terminal`). `publish_rejected` is
 * deliberately absent: it is a re-editable terminal.
 */
export function lifecycleSealed(lifecycle: WorkflowProductLifecycle): boolean {
  return SEALED_STAGES.includes(lifecycle.stage)
}

/** Why an editable cell refuses a write, or null when it may. */
export function proseCellSkip(
  row: { ai: string },
  product?: { draft?: unknown; lifecycle: WorkflowProductLifecycle },
): "sealed" | "ai" | "publishing" | "missing" | null {
  if (!product?.draft) return "missing"
  if (lifecycleSealed(product.lifecycle)) return "sealed"
  if (row.ai === "running" || product.lifecycle.ai === "running") return "ai"
  if (product.lifecycle.stage === "submitting" || product.lifecycle.stage === "queued") {
    return "publishing"
  }
  return null
}

/**
 * The tone vocabulary has exactly one table (`lib/receipt-state.ts`). This is a
 * narrow alias from the row stage into a status word that table already knows,
 * so a stage can never invent a seventh tone.
 */
const STAGE_STATUS_ALIAS: Record<RowStage, string> = {
  awaiting_content: "draft",
  recognizing: "queued",
  rendering: "queued",
  uploading: "queued",
  recognition_failed: "failed",
  media_failed: "failed",
  candidates_pending: "queued",
  build_stale: "planned",
  fields_invalid: "failed",
  ready_to_publish: "planned",
  queued: "queued",
  submitting: "dispatching",
  outcome_unknown: "result_unknown",
  accepted: "succeeded",
  publish_rejected: "failed",
  operator_attested: "operator_attested",
}

export function stageTone(stage: RowStage): StateTone {
  return toneFor(STAGE_STATUS_ALIAS[stage])
}

/** Tone comes only from the row stage. */
export function workbenchRowTone(lifecycle: WorkflowProductLifecycle): StateTone {
  return stageTone(lifecycle.stage)
}

/**
 * Bucket from the ListingRowView stage only. A stale build stamp sits with
 * 可发送: the row is prepared and send restamps. A returned import receipt
 * ends the send.
 */
export function bucketOf(
  lifecycle: WorkflowProductLifecycle,
): WorkbenchBucket {
  const stage = lifecycle.stage
  if (stage === "accepted") {
    return "sent"
  }
  if (stage === "queued" || stage === "submitting") {
    return "inFlight"
  }
  if (
    [
      "publish_rejected",
      "fields_invalid",
      "recognition_failed",
      "media_failed",
      "outcome_unknown",
      "operator_attested",
    ].includes(stage)
  ) {
    return "exceptions"
  }
  if (stage === "ready_to_publish" || stage === "build_stale") return "ready"
  return "pending"
}

/** The row fields one ListingRowView lifecycle decides; `readiness` only when it came along. */
export function listingRowLifecyclePatch(
  lifecycle: WorkflowProductLifecycle,
  readiness?: WorkflowReadinessReport,
  sourceLayers?: Record<string, FieldLayerView>,
): Pick<ListingRow, "status" | "ai" | "render" | "upload" | "candidates" | "stage" | "sourceLayers" | "readiness"> {
  return {
    status: rowStatusFromLifecycle(lifecycle),
    ai: aiTrackFromLifecycle(lifecycle),
    render: renderTrackFromLifecycle(lifecycle),
    upload: uploadTrackFromLifecycle(lifecycle),
    candidates: lifecycle.ai_candidates,
    stage: lifecycle.stage,
    ...(sourceLayers ? { sourceLayers } : {}),
    ...(readiness ? { readiness } : {}),
  }
}

const FENCED_PUBLISH_STAGES = new Set(["outcome_unknown", "queued", "submitting", "operator_attested"])

export function projectListingRowLifecycle(
  row: ListingRow,
  lifecycle: WorkflowProductLifecycle,
  readiness?: WorkflowReadinessReport,
  sourceLayers?: Record<string, FieldLayerView>,
): ListingRow {
  const next = { ...row, ...listingRowLifecyclePatch(lifecycle, readiness, sourceLayers) }
  // A server stage that is no longer a fence clears the local lock. The lock
  // used to survive every refresh, so another device (or an automatic probe)
  // could not unlock the browser that sent.
  if (row.publishUnconfirmed && !FENCED_PUBLISH_STAGES.has(lifecycle.stage)) {
    return { ...next, publishUnconfirmed: false, publishRequestEvidence: undefined }
  }
  return next
}
