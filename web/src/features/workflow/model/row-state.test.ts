import assert from "node:assert/strict"
import test from "node:test"
import type { ListingRowView } from "@/bindings/listing-projection"
import { listingProjection } from "../../../../tests/listing-row-fixture"
import { rowStatusView } from "./row-state"

const row = {
  id: "row-1", card_id: "card-1", revision: 7, view_revision: 12,
  content_state: "ready", media_state: "ready", validation_state: "passed", submission_state: "none",
  draft: { values: {}, complex_values: [] }, validation_issues: [],
  media: { images: [], videos: [] }, ai: { candidates: [] },
  source: { sha256: "source", fileName: "image.jpg" }, payload: {}, updated_at_ms: 1,
  build: { state: "stale", sources: [] },
  projection: listingProjection({
    stage: "outcome_unknown",
    readiness: { ready_to_publish: false, can_start_publish_attempt: false,
      blockers: ["outcome_unknown"], allowed_actions: ["reconcile"] },
  }),
} satisfies ListingRowView

test("the adapter renders Cloud's verdict even when raw preparation columns are ready", () => {
  const status = rowStatusView(row)
  assert.equal(status.lifecycle.stage, "outcome_unknown")
  assert.equal(status.lifecycle.revision, 7)
  assert.equal(status.lifecycle.view_revision, 12)
  assert.equal(status.lifecycle.source_asset_handle, "source/image.jpg")
  assert.equal(status.readiness, row.projection.readiness)
  assert.equal(status.draft, row.draft)
})

test("row reload preserves the exact batch receipt and never invents historical response data", () => {
  const receipt = { batch_id: "job-1", item_count: 100, http_status: 422,
    response_body: "ошибка\n<body>invalid</body>", received_at_ms: 1 }
  const reloaded = rowStatusView({ ...row, view_revision: 14,
    projection: listingProjection({ stage: "publish_rejected", submission_receipt: receipt, task_id: "42" }),
  })
  assert.deepEqual(reloaded.lifecycle.submissionReceipt, receipt)
  assert.equal(reloaded.lifecycle.taskId, "42")
  const historical = rowStatusView({ ...row,
    projection: listingProjection({ stage: "accepted", task_id: "41" }),
  })
  assert.equal(historical.lifecycle.taskId, "41")
  assert.equal(historical.lifecycle.submissionReceipt, undefined)
})

test("submission identity survives without reviving old preparation errors", () => {
  const status = rowStatusView({ ...row,
    projection: listingProjection({ stage: "accepted", run_id: "intent-1", sku: 555, product_id: 9001 }),
    payload: { failureLog: [
      { stage: "ai", code: "old", message: "旧失败", occurred_at_ms: 1 },
      { stage: "ai", code: "workflow_quota_exceeded", message: "钱包余额不足", occurred_at_ms: 2 },
    ] },
  })
  assert.equal(status.lifecycle.stage, "accepted")
  assert.equal(status.lifecycle.run_id, "intent-1")
  assert.equal(status.lifecycle.ozon_sku, 555)
  assert.equal(status.lifecycle.ozon_product_id, 9001)
  assert.equal(status.lifecycle.last_error_detail, undefined)
  assert.equal(status.lifecycle.last_error_code, undefined)
})


test("a full-looking draft does not invent sendability, and a blocked snapshot does not veto Cloud", async () => {
  const { sendBatchEligible } = await import("../batch-actions")
  const issue = { field_key: "name", code: "required" as const, message: "名称必填" }
  const blocked = rowStatusView({
    ...row,
    content_state: "ready",
    media_state: "ready",
    validation_state: "blocked",
    submission_state: "none",
    validation_issues: [issue],
    draft: {
      values: { name: { kind: "text", value: "看起来填满" } },
      complex_values: [],
    },
    projection: listingProjection({
      stage: "fields_invalid",
      fields: "invalid",
      readiness: {
        ready_to_publish: false,
        can_start_publish_attempt: false,
        blockers: ["fields_invalid"],
        allowed_actions: ["edit_fields"],
      },
    }),
  })
  assert.equal(blocked.validation_state, "invalid")
  assert.deepEqual(blocked.issues, [issue])
  assert.equal(blocked.readiness.can_start_publish_attempt, false)
  assert.equal(blocked.lifecycle.media, row.projection.media)
  const listingRow = { id: row.id, readiness: blocked.readiness } as never
  assert.equal(sendBatchEligible(listingRow, blocked.lifecycle), false)

  const allowed = rowStatusView({
    ...row,
    validation_state: "blocked",
    projection: listingProjection({
      stage: "fields_invalid",
      fields: "invalid",
      readiness: {
        ready_to_publish: true,
        can_start_publish_attempt: true,
        blockers: [],
        allowed_actions: ["publish"],
      },
    }),
  })
  assert.equal(allowed.validation_state, "invalid")
  assert.equal(
    sendBatchEligible({ id: row.id, readiness: allowed.readiness } as never, allowed.lifecycle),
    true,
  )

  const mediaHeld = rowStatusView({
    ...row,
    media_state: "pending",
    projection: listingProjection({
      stage: "ready_to_publish",
      media: "pending",
      readiness: {
        ready_to_publish: false,
        can_start_publish_attempt: false,
        blockers: ["media_pending"],
        allowed_actions: ["prepare"],
      },
    }),
  })
  assert.equal(mediaHeld.lifecycle.media, "pending")
  assert.equal(
    sendBatchEligible({ id: row.id, readiness: mediaHeld.readiness } as never, mediaHeld.lifecycle),
    false,
  )
})

test("the adapter copies the current issue and safe detail from Cloud", () => {
  const issue = {
    phase: "submit", scope: "store" as const, code: "OZON_ACCESS_UNCLASSIFIED",
    summary: "访问被拒绝", remediation: "核查店铺后恢复", allowed_actions: ["check_store" as const, "resume" as const],
    trace_id: "job", endpoint: "/v3/product/import", safe_message: "unclassified refusal",
    dispatch_evidence: "rejected" as const, intent_id: "intent", input_revision: 7,
    request_hash: "digest", row_id: "row-1", store_id: "store", credential_revision: 1,
    retry_after_fallback: false, created_at_ms: 0,
  }
  const projection = listingProjection({ stage: "publish_rejected", submission_issue: issue,
    error_code: issue.code, error_detail: "访问被拒绝；核查店铺后恢复" })
  const status = rowStatusView({ ...row, projection })
  assert.equal(status.lifecycle.submission_issue, issue)
  assert.equal(status.lifecycle.last_error_code, projection.error_code)
  assert.equal(status.lifecycle.last_error_detail, projection.error_detail)
  assert.equal(status.readiness, projection.readiness)
})

test("Cloud media identity overrides residual images for both tracks and upload eligibility", async () => {
  const { renderTrackFromLifecycle, uploadTrackFromLifecycle } = await import("./listing-row-lifecycle")
  const { deliverBatchEligible } = await import("../batch-actions")
  const { NO_PREPARATION_ACTIVITY } = await import("../prepare/preparation-tracks")
  const residual = { ...row, media: { images: [{ phase: "public_ready" }] } }
  const failed = rowStatusView({ ...residual, projection: listingProjection({ media: "failed", media_failure_stage: "render", image_total: 0, image_completed: 0 }) }).lifecycle
  assert.equal(renderTrackFromLifecycle(failed), "failed")
  assert.equal(uploadTrackFromLifecycle(failed), "idle")
  assert.equal(deliverBatchEligible({ id: "row-1" } as never, failed, NO_PREPARATION_ACTIVITY), false)
  const upload = rowStatusView({ ...residual, projection: listingProjection({ media: "failed", media_failure_stage: "upload", image_total: 6, image_completed: 4 }) }).lifecycle
  assert.equal(renderTrackFromLifecycle(upload), "done")
  assert.equal(uploadTrackFromLifecycle(upload), "failed")
  assert.equal(upload.image_total, 6)
  assert.equal(upload.image_completed, 4)
  assert.equal(deliverBatchEligible({ id: "row-1" } as never, upload, NO_PREPARATION_ACTIVITY), true)
})

test("send-gate media repair can reconfirm old receipts without restarting OCR", async () => {
  const { guidedPreparationLanes } = await import("../batch-actions")
  const { NO_PREPARATION_ACTIVITY } = await import("../prepare/preparation-tracks")
  const lifecycle = rowStatusView({ ...row, media_state: "pending", projection: listingProjection({ stage: "publish_rejected", ai: "ready", media: "rendered", image_total: 8, image_completed: 8, error_code: "MEDIA_OBJECT_MISSING" }) }).lifecycle
  const lanes = guidedPreparationLanes([{ id: "row-1" } as never], () => lifecycle, NO_PREPARATION_ACTIVITY)
  assert.deepEqual(lanes.deliver, ["row-1"])
  assert.deepEqual(lanes.ai, [])
  assert.deepEqual(lanes.render, [])
})
