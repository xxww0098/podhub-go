import assert from "node:assert/strict"
import test from "node:test"
import { preparationBatch } from "./preparation-batch"
import { createPreparationTracks } from "./preparation-tracks"
import { peekListingWorkbench, resetListingWorkbench, listingWorkbenchScope } from "../workbench/listing-workbench-store"
import { runRows } from "./run-rows"
import { record, ROW, withStubbedDevice } from "./executor-test-support"

test("recognition and guided preparation ignore saved model choices and let the server choose", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => key === "podhub.ocr-model.v2" ? JSON.stringify({ primary_model: "old-choice" }) : null,
    setItem() {}, removeItem() {},
  } })
  resetListingWorkbench()
  const batch = preparationBatch({ preparationTracks: { current: createPreparationTracks() },
    guidedPreparationLock: { current: false }, activeWork: { current: new Set() },
    pendingFailures: { current: { ai: [], render: [], deliver: [] } },
    pendingFailureScope: { current: listingWorkbenchScope() } })
  const stub = record(call => call.url.endsWith("/prepare") ? { outcome: "blocked", jobs: [], issues: [] } : ROW)
  try {
    assert.equal("modelRouting" in peekListingWorkbench(), false)
    const work = batch.beginPrepareWork([])
    for (const verb of ["recognize", "prepare"] as const) {
      await withStubbedDevice(() => batch.prepareAction(work, (request, onRow) => runRows(request, verb, onRow))(
        { row_ids: ["a", "b"], expected_revisions: [] }, () => undefined,
      ))
    }
    const plans = stub.calls.filter(call => call.url.endsWith("/prepare"))
    assert.equal(plans.length, 4)
    for (const plan of plans) assert.equal("model_routing" in (plan.body as object), false)
    assert.equal(stub.calls.some(call => call.url.endsWith("/prices") || call.url.endsWith("/ocr/completions")), false)
  } finally {
    stub.restore()
    if (previous) Object.defineProperty(globalThis, "localStorage", previous)
    else Reflect.deleteProperty(globalThis, "localStorage")
    resetListingWorkbench()
  }
})
