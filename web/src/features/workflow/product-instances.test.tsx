import assert from "node:assert/strict"
import test from "node:test"
import type { FieldValueOrigin, WorkflowDraftView, WorkflowProductLifecycle } from "@/bindings/commands"
import { listingWorkbenchScope } from "./workbench/listing-workbench-store"
import { deleteProductInstances, rowsReadyForPreparation } from "./product-instances"
import { syncSavedFieldOrigins } from "./editing/use-card-autosave"
import { renderTrackFromLifecycle, rowStatusFromLifecycle, uploadTrackFromLifecycle } from "./model/listing-row-lifecycle"
import { pendingLifecycle, installFetch } from "./product-instances-test-fixtures"

test("saved template origins skip row HTTP while instance origins keep the row read", async () => {
  const stub = installFetch((call) => {
    assert.equal(call.method, "GET")
    assert.match(call.url, /^\/api\/listing\/rows\/row-1$/)
    return { payload: { fieldOrigins: [] } }
  })
  let origins: FieldValueOrigin[] = []
  const setOrigins = (next: FieldValueOrigin[] | ((current: FieldValueOrigin[]) => FieldValueOrigin[])) => {
    origins = typeof next === "function" ? next(origins) : next
  }
  const scope = listingWorkbenchScope()
  try {
    await syncSavedFieldOrigins(
      { kind: "template", draft_id: "card-1" } as WorkflowDraftView,
      scope,
      setOrigins,
    )
    assert.deepEqual(origins, [])
    assert.equal(stub.calls.length, 0)

    await syncSavedFieldOrigins(
      { kind: "instance", draft_id: "row-1" } as WorkflowDraftView,
      scope,
      setOrigins,
    )
    assert.equal(stub.calls.length, 1)
  } finally {
    stub.restore()
  }
})

test("confirmed preparation admits only rows whose Product Instance is durable", () => {
  const pickerInstance = {
    draft_id: "workflow_instance_picker_1",
    kind: "instance",
    parent_card_id: "workflow_template_1",
  } as import("@/bindings/commands").WorkflowDraftView
  const pathInstance = {
    draft_id: "workflow_instance_path_1",
    kind: "instance",
    parent_card_id: "workflow_template_1",
  } as import("@/bindings/commands").WorkflowDraftView
  const pickerRow = {
    id: "row-picker",
    draftId: pickerInstance.draft_id,
    imageName: "one.png",
    status: "pending",
    ai: "idle",
    render: "idle",
    upload: "idle",
    log: "已导入，等待确认后开始准备",
  } as import("./model/listing-row").ListingRow
  const pathRow = {
    ...pickerRow,
    id: "row-path",
    draftId: pathInstance.draft_id,
    imageName: "two.png",
  }

  const stale = rowsReadyForPreparation([pickerRow, pathRow], {})
  assert.deepEqual(stale.runnable.map((row) => row.id), [])
  assert.deepEqual(stale.missing.map((row) => row.id), ["row-picker", "row-path"])

  const both = rowsReadyForPreparation([pickerRow, pathRow], {
    [pickerInstance.draft_id]: pickerInstance,
    [pathInstance.draft_id]: pathInstance,
  })
  assert.deepEqual(both.runnable.map((row) => row.id), ["row-picker", "row-path"])
  assert.deepEqual(both.missing, [])

  const partial = rowsReadyForPreparation([pickerRow, pathRow], {
    [pickerInstance.draft_id]: pickerInstance,
  })
  assert.deepEqual(partial.runnable.map((row) => row.id), ["row-picker"])
  assert.deepEqual(partial.missing.map((row) => row.id), ["row-path"])
})

test("unknown and operator-attested Seller outcomes are exceptions, not active or sent", () => {
  assert.equal(
    rowStatusFromLifecycle({ ...pendingLifecycle, stage: "outcome_unknown" }),
    "exception",
  )
  assert.equal(
    rowStatusFromLifecycle({ ...pendingLifecycle, stage: "operator_attested" }),
    "exception",
  )
})

test("render, upload, and AI project independently before candidate review", () => {
  const uploading: WorkflowProductLifecycle = {
    ...pendingLifecycle,
    revision: 3,
    view_revision: 3,
    stage: "rendering",
    ai: "ready",
    media: "uploading",
    images: [{
      index: 0,
      file_name: "slice.jpg",
      content_hash: "sha256:slice",
      group_name: "主图",
      width: 900,
      height: 1200,
      phase: "uploading",
    }],
  }
  assert.equal(renderTrackFromLifecycle(uploading), "done")
  assert.equal(uploadTrackFromLifecycle(uploading), "running")
  assert.equal(rowStatusFromLifecycle(uploading), "running")

  const review: WorkflowProductLifecycle = {
    ...uploading,
    revision: 4,
    view_revision: 4,
    stage: "candidates_pending",
    media: "ready",
    images: [{ ...uploading.images[0]!, phase: "public_ready" }],
    ai_candidates: [{
      address: { kind: "plain", field_key: "name" },
      value: { kind: "text", value: "Poster" },
      source: "vision",
      state: "proposed",
    }],
  }
  assert.equal(rowStatusFromLifecycle(review), "review")
  assert.equal(uploadTrackFromLifecycle(review), "done")
  assert.equal(
    rowStatusFromLifecycle({
      ...review,
      stage: "ready_to_publish",
      ai_candidates: [{ ...review.ai_candidates[0]!, state: "confirmed" }],
    }),
    "ready",
  )
})

test("durable deletion reports removed Product Instance IDs", async () => {
  const persistedDrafts = new Set(["workflow_instance_delete_1"])
  const result = await deleteProductInstances(
    [{ id: "row-1", draftId: "workflow_instance_delete_1" }],
    ["row-1"],
    async (draftId) => {
      assert.equal(persistedDrafts.has(draftId), true)
      persistedDrafts.delete(draftId)
    },
  )

  assert.deepEqual(result.deletedRowIds, ["row-1"])
  assert.deepEqual(result.deletedDraftIds, ["workflow_instance_delete_1"])
  assert.equal(persistedDrafts.has("workflow_instance_delete_1"), false)
})

test("a failed durable delete reports the failure without claiming deletion", async () => {
  const reason = new Error("delete refused")
  const result = await deleteProductInstances(
    [{ id: "row-1", draftId: "workflow_instance_delete_1" }],
    ["row-1"],
    async () => {
      throw reason
    },
  )

  assert.deepEqual(result.deletedRowIds, [])
  assert.deepEqual(result.deletedDraftIds, [])
  assert.deepEqual(result.failures, [
    {
      rowId: "row-1",
      draftId: "workflow_instance_delete_1",
      reason,
    },
  ])
})

test("deletes Product Instances with bounded concurrency and stable partial results", async () => {
  const rows = Array.from({ length: 5 }, (_, index) => ({
    id: `row-${index}`,
    draftId: `workflow_instance_delete_${index}`,
  }))
  let active = 0
  let maximum = 0
  let started = 0
  let releaseFirstWave!: () => void
  const firstWave = new Promise<void>((resolve) => { releaseFirstWave = resolve })
  const reason = new Error("delete refused")
  const result = await deleteProductInstances(rows, rows.map((row) => row.id), async (draftId) => {
    active += 1
    maximum = Math.max(maximum, active)
    started += 1
    if (started === 3) releaseFirstWave()
    if (Number(draftId.at(-1)) < 3) await firstWave
    active -= 1
    if (draftId.endsWith("_2")) throw reason
  })

  assert.equal(maximum, 3)
  assert.deepEqual(result.deletedRowIds, ["row-0", "row-1", "row-3", "row-4"])
  assert.deepEqual(result.deletedDraftIds, [
    "workflow_instance_delete_0",
    "workflow_instance_delete_1",
    "workflow_instance_delete_3",
    "workflow_instance_delete_4",
  ])
  assert.deepEqual(result.failures, [{ rowId: "row-2", draftId: "workflow_instance_delete_2", reason }])
})

test("an imported instance is pending until preparation starts", () => {
  assert.equal(rowStatusFromLifecycle(pendingLifecycle), "pending")
  assert.equal(renderTrackFromLifecycle(pendingLifecycle), "idle")
  assert.equal(uploadTrackFromLifecycle(pendingLifecycle), "idle")
})


