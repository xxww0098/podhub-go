import assert from "node:assert/strict"
import test from "node:test"
import type { WorkflowProductLifecycle } from "@/bindings/commands"
import {
  aiBatchEligible,
  aiBatchEligibleForced,
  deliverBatchEligible,
  guidedPreparationLanes,
  renderBatchEligible,
  sendBatchEligible,
} from "../batch-actions"
import type { ListingRow } from "../model/listing-row"
import {
  BUCKET_LABEL,
  bucketOf,
  PREPARE_UI_LABEL,
  prepareUiLabel,
  prepareUiPhase,
  workbenchRowTone,
  workbenchStatusLabel,
} from "../model/listing-row-lifecycle"
import {
  createPreparationTracks,
  NO_PREPARATION_ACTIVITY,
  preparationRunning,
  rowPreparing,
} from "../prepare/preparation-tracks"
import { idleLifecycle, readyToPublish, row, slice } from "./workbench-test-fixtures"

// ---------------------------------------------------------------------------
// Eligibility, buckets and tones
// ---------------------------------------------------------------------------

test("recognition skips rows that already have an answer unless forced", () => {
  const idle = NO_PREPARATION_ACTIVITY
  const imported = row(1)
  const recognised = { ...idleLifecycle, ai: "ready" as const }

  assert.equal(
    aiBatchEligible(imported, recognised, idle),
    false,
    "a recognised row must not be bought a second time by a plain click",
  )
  assert.equal(
    aiBatchEligibleForced(imported, recognised, idle),
    true,
    "the operator can still ask for a new answer",
  )
  // Forcing is about paying again, not about overriding Cloud's gates.
  assert.equal(
    aiBatchEligibleForced(imported, { ...idleLifecycle, ai: "running" }, idle),
    false,
    "a request already in flight is never duplicated",
  )
})

test("each batch verb admits exactly the rows it can act on", () => {
  const idle = NO_PREPARATION_ACTIVITY
  const imported = row(1)
  assert.equal(aiBatchEligible(imported, idleLifecycle, idle), true)
  assert.equal(renderBatchEligible(imported, idleLifecycle, idle), true)
  assert.equal(
    deliverBatchEligible(imported, idleLifecycle, idle),
    false,
    "nothing to upload yet",
  )
  assert.equal(sendBatchEligible(imported), false)

  const restoredWithoutSource: ListingRow = {
    ...imported,
    source: undefined,
    readiness: readyToPublish,
  }
  assert.equal(
    sendBatchEligible(restoredWithoutSource),
    true,
    "a lost process-local source handle must not block already-uploaded media",
  )
  assert.equal(
    sendBatchEligible(
      { ...imported, readiness: undefined },
      { ...idleLifecycle, stage: "ready_to_publish", ai: "ready", media: "ready", fields: "valid" },
    ),
    true,
    "ready_to_publish is sendable even before ListingRow.readiness hydrates",
  )
  assert.equal(
    sendBatchEligible(
      { ...imported, readiness: undefined },
      { ...idleLifecycle, stage: "build_stale", ai: "ready", media: "ready", fields: "valid" },
    ),
    true,
    "a stale build stamp is sendable pre-hydration too — send restamps",
  )

  const repairedByLateDefault: ListingRow = {
    ...imported,
    readiness: {
      ready_to_publish: false, can_start_publish_attempt: false,
      blockers: ["fields_invalid"],
      allowed_actions: ["edit_fields"],
    },
  }
  assert.equal(
    sendBatchEligible(repairedByLateDefault),
    false,
    "Invalid cannot start a publish attempt; Dirty + preparation ready can",
  )

  const stalePublishing: ListingRow = {
    ...imported,
    status: "failed",
    readiness: {
      ready_to_publish: false, can_start_publish_attempt: false,
      blockers: [],
      allowed_actions: [],
    },
  }
  const conflicted: WorkflowProductLifecycle = {
    ...idleLifecycle,
    stage: "publish_rejected",
    ai: "ready",
    media: "ready",
    fields: "valid",
  }
  assert.equal(
    sendBatchEligible(stalePublishing, conflicted),
    false,
    "a currency / reconcile conflict must stay blocked after the in-flight readiness snapshot",
  )
  assert.equal(
    sendBatchEligible(
      {
        ...stalePublishing,
        readiness: {
          ready_to_publish: false, can_start_publish_attempt: true,
          blockers: ["publish_conflict"],
          allowed_actions: ["edit_fields", "publish"],
        },
      },
    ),
    true,
    "publish_conflict is a retry, not a sealed skip",
  )

  for (const stage of ["queued", "submitting", "outcome_unknown", "accepted"] as const) {
    assert.equal(
      sendBatchEligible({ ...imported, readiness: readyToPublish }, { ...idleLifecycle, stage }),
      false,
      `${stage} cannot send even with a stale ready report`,
    )
  }
  for (const stage of ["awaiting_content", "rendering", "fields_invalid"] as const) {
    assert.equal(
      sendBatchEligible({ ...imported, readiness: readyToPublish }, { ...idleLifecycle, stage }),
      true,
      `${stage} does not veto a Cloud publish permission`,
    )
  }
  assert.equal(
    sendBatchEligible(
      { ...imported, readiness: { ...readyToPublish, can_start_publish_attempt: false, allowed_actions: ["edit_fields"] } },
      { ...idleLifecycle, stage: "publish_rejected" },
    ),
    false,
    "rejected without an explicit publish action cannot send",
  )
  assert.equal(
    sendBatchEligible(
      { ...imported, readiness: { ...readyToPublish, can_start_publish_attempt: false, allowed_actions: ["edit_fields"] } },
      { ...idleLifecycle, stage: "ready_to_publish" },
    ),
    false,
    "ready lifecycle still obeys a blocking readiness report",
  )
  assert.equal(
    sendBatchEligible(
      { ...imported, readiness: { ...readyToPublish, allowed_actions: [] } },
      { ...idleLifecycle, stage: "ready_to_publish" },
    ),
    false,
    "a true readiness flag cannot replace Cloud publish permission",
  )

  const busy: WorkflowProductLifecycle = { ...idleLifecycle, ai: "running", media: "rendering" }
  assert.equal(aiBatchEligible(imported, busy, idle), false)
  assert.equal(renderBatchEligible(imported, busy, idle), false)

  const sliced: WorkflowProductLifecycle = { ...idleLifecycle, media: "rendered", image_total: 1, images: [slice(0)] }
  assert.equal(deliverBatchEligible(imported, sliced, idle), true)
  assert.equal(
    renderBatchEligible(imported, sliced, idle),
    false,
    "already sliced rows must not render twice",
  )
  const deliveryFailed: WorkflowProductLifecycle = {
    ...idleLifecycle,
    stage: "recognition_failed",
    ai: "ready",
    media: "failed", media_failure_stage: "upload", image_total: 1,
    images: [slice(0, { phase: "failed", error_code: "workflow_delivery_network" })],
  }
  assert.equal(
    renderBatchEligible(imported, deliveryFailed, idle),
    true,
    "a delivery failure must stay sliceable; leftover failed records are not success",
  )
  assert.equal(deliverBatchEligible(imported, deliveryFailed, idle), true)
  assert.deepEqual(
    guidedPreparationLanes([imported], () => deliveryFailed, idle),
    { ai: [], render: [], deliver: [imported.id] },
    "一键准备 retries upload on leftover slices, not a second PSD pass",
  )
  const publicReady: WorkflowProductLifecycle = {
    ...sliced,
    media: "ready",
    images: [slice(0, { phase: "public_ready", public_url: "https://cdn.example.test/0.jpg" })],
  }
  assert.equal(
    deliverBatchEligible(imported, publicReady, idle),
    false,
    "already delivered slices must not be uploaded twice",
  )
  assert.equal(
    renderBatchEligible(imported, publicReady, idle),
    false,
    "public-ready media must not spend another render slot",
  )

  // A terminal receipt seals the row: Cloud refuses to touch it, so offering
  // the verb would be a button that can only fail.
  for (const stage of ["accepted", "operator_attested", "outcome_unknown"] as const) {
    const sealed: WorkflowProductLifecycle = { ...sliced, stage }
    assert.equal(aiBatchEligible(imported, sealed, idle), false, `${stage} must be sealed`)
    assert.equal(renderBatchEligible(imported, sealed, idle), false, `${stage} must be sealed`)
    assert.equal(deliverBatchEligible(imported, sealed, idle), false, `${stage} must be sealed`)
  }
  // `conflict` and `rejected` are re-editable terminals, not sealed ones.
  assert.equal(renderBatchEligible(imported, { ...idleLifecycle, stage: "publish_rejected" }, idle), true)
  assert.equal(renderBatchEligible(imported, { ...idleLifecycle, stage: "publish_rejected" }, idle), true)
  assert.equal(
    renderBatchEligible(imported, { ...sliced, stage: "publish_rejected" }, idle),
    false,
    "existing slices stay skipped on a re-editable terminal",
  )

  // A row without a source image has nothing for the model or the renderer to
  // read, but its already-rendered slices can still be delivered.
  const sourceless = row(2, { source: undefined })
  assert.equal(aiBatchEligible(sourceless, idleLifecycle, idle), false)
  assert.equal(renderBatchEligible(sourceless, idleLifecycle, idle), false)
  assert.equal(deliverBatchEligible(sourceless, sliced, idle), true)
})

test("guided preparation only spends AI when slices are already public", () => {
  const target = row(1, { ai: "failed", status: "failed" })
  const publicReady: WorkflowProductLifecycle = {
    ...idleLifecycle,
    ai: "failed",
    media: "ready",
    images: [slice(0, { phase: "public_ready", public_url: "https://cdn.example.test/0.jpg" })],
  }
  const lanes = guidedPreparationLanes(
    [target],
    () => publicReady,
    NO_PREPARATION_ACTIVITY,
  )
  assert.deepEqual(lanes, { ai: [target.id], render: [], deliver: [] })
})

// ---------------------------------------------------------------------------
// 识别 / 切片 / 上传 run at the same time
// ---------------------------------------------------------------------------

test("a verb only withholds the rows it already holds, never the other verbs", () => {
  const first = row(1)
  const second = row(2)
  const sliced: WorkflowProductLifecycle = {
    ...idleLifecycle,
    media: "rendered", image_total: 1,
    images: [slice(0)],
  }
  const tracks = createPreparationTracks()

  assert.deepEqual(tracks.claim("ai", [first.id, second.id]), [first.id, second.id])
  const recognising = tracks.snapshot()
  // Recognition holds both rows, and it is the only verb that stops there.
  assert.equal(aiBatchEligible(first, idleLifecycle, recognising), false)
  assert.equal(renderBatchEligible(first, idleLifecycle, recognising), true)
  assert.equal(deliverBatchEligible(first, sliced, recognising), true)

  // 切片 and 上传 are one lifecycle track: RenderStarted clears the slices
  // DeliveryStarted requires, so a row inside one is refused by the other.
  assert.deepEqual(tracks.claim("render", [first.id]), [first.id])
  const alsoRendering = tracks.snapshot()
  assert.equal(deliverBatchEligible(first, sliced, alsoRendering), false)
  assert.equal(
    deliverBatchEligible(second, sliced, alsoRendering),
    true,
    "the rows that finished slicing can upload while the rest still render",
  )
  assert.deepEqual(
    tracks.claim("deliver", [first.id, second.id]),
    [second.id],
    "a second click admits nothing the media track already holds",
  )

  tracks.release("render", [first.id])
  const afterRender = tracks.snapshot()
  assert.equal(deliverBatchEligible(first, sliced, afterRender), true)
  assert.equal(aiBatchEligible(first, idleLifecycle, afterRender), false, "AI still holds it")
  assert.equal(preparationRunning(afterRender), true)
  assert.equal(rowPreparing(afterRender, first.id), true)

  tracks.release("ai", [first.id, second.id])
  tracks.release("deliver", [second.id])
  assert.equal(preparationRunning(tracks.snapshot()), false)
  tracks.release("ai", [first.id])
  assert.equal(
    preparationRunning(tracks.snapshot()),
    false,
    "releasing twice is not an error; every settle releases its own row",
  )
})


test("the publish column sorts a row into one of five buckets with one tone each", () => {
  const bucket = (
    stage: WorkflowProductLifecycle["stage"],
    overrides: Partial<WorkflowProductLifecycle> = {},
  ) => bucketOf({ ...idleLifecycle, stage, ...overrides })

  assert.equal(bucket("awaiting_content"), "pending")
  assert.equal(bucket("rendering"), "pending")
  assert.equal(
    bucket("build_stale"),
    "ready",
    "a stale stamp is still sendable; the column reads 可发送",
  )
  assert.equal(bucket("ready_to_publish"), "ready")
  assert.equal(bucket("submitting"), "inFlight")
  assert.equal(bucket("accepted"), "sent")
  assert.equal(
    bucket("accepted", { ozon_sku: 1 }),
    "sent",
  )
    assert.equal(bucket("accepted"), "sent")
  assert.equal(
    bucket("operator_attested"),
    "exceptions",
    "operator attestation seals an evidence gap; it does not prove a live offer",
  )
  for (const stage of ["publish_rejected", "fields_invalid", "recognition_failed", "media_failed"] as const) {
    assert.equal(bucket(stage), "exceptions")
  }
  // Result Unknown is an exception, never "still running": filing it under work
  // in flight tells the operator to keep waiting when the only way out is a
  // reconciliation.
  assert.equal(bucket("outcome_unknown"), "exceptions")
  assert.equal(bucket("recognition_failed", { ai: "failed" }), "exceptions")
  assert.equal(bucket("media_failed", { media: "failed" }), "exceptions")

  const ui = (
    stage: WorkflowProductLifecycle["stage"],
    overrides: Partial<WorkflowProductLifecycle> = {},
  ) => prepareUiPhase({ ...idleLifecycle, stage, ...overrides })
  assert.equal(ui("awaiting_content"), "unprepared")
  assert.equal(ui("recognizing"), "preparing")
  assert.equal(ui("rendering"), "preparing")
  assert.equal(ui("uploading"), "preparing")
  assert.equal(ui("build_stale"), "ready")
  assert.equal(ui("candidates_pending"), "attention")
  assert.equal(ui("ready_to_publish"), "ready")
  assert.equal(ui("queued"), "sending")
  assert.equal(ui("submitting"), "sending")
  assert.equal(ui("accepted"), "sent")
  assert.equal(ui("accepted", { ozon_sku: 1 }), "sent")
  assert.equal(ui("outcome_unknown"), "attention")
  assert.equal(prepareUiLabel({ ...idleLifecycle, stage: "awaiting_content" }), PREPARE_UI_LABEL.unprepared)
  assert.equal(prepareUiLabel({ ...idleLifecycle, stage: "queued" }), "正在提交")
  assert.equal(prepareUiLabel({ ...idleLifecycle, stage: "build_stale" }), PREPARE_UI_LABEL.ready)
  assert.equal(prepareUiLabel({ ...idleLifecycle, stage: "publish_rejected" }), BUCKET_LABEL.exceptions)

  const tone = (
    stage: WorkflowProductLifecycle["stage"],
    overrides: Partial<WorkflowProductLifecycle> = {},
  ) => workbenchRowTone({ ...idleLifecycle, stage, ...overrides })

  assert.equal(tone("awaiting_content"), "idle")
  assert.equal(tone("recognizing"), "idle")
  assert.equal(tone("build_stale"), "flight")
  assert.equal(tone("ready_to_publish"), "flight")
  assert.equal(tone("submitting"), "flight")
  assert.equal(tone("accepted"), "good")
  assert.equal(tone("publish_rejected"), "bad", "a live conflict is a failure hue, never a success one")
  assert.equal(tone("fields_invalid"), "bad")
  assert.equal(tone("recognition_failed"), "bad")
  assert.equal(tone("media_failed"), "bad")
  assert.equal(tone("outcome_unknown"), "unknown", "Result Unknown is not an error")
  assert.equal(tone("operator_attested"), "attest")
  assert.equal(tone("media_failed", { media: "failed" }), "bad")

  assert.deepEqual(Object.keys(BUCKET_LABEL), [
    "pending",
    "ready",
    "inFlight",
    "sent",
    "exceptions",
  ])
})

test("the publish column uses submission language", () => {
  assert.equal(workbenchStatusLabel({ ...idleLifecycle, stage: "queued" }, "inFlight"), "正在提交")
  assert.equal(workbenchStatusLabel({ ...idleLifecycle, stage: "submitting" }, "inFlight"), "正在提交")
  assert.equal(workbenchStatusLabel({ ...idleLifecycle, stage: "accepted" }, "inFlight"), "已提交")
  assert.equal(workbenchStatusLabel({ ...idleLifecycle, stage: "accepted" }, "inFlight"), "已提交")
})
