import assert from "node:assert/strict"
import test from "node:test"
import { preparationBatch } from "./preparation-batch"
import { createPreparationTracks } from "./preparation-tracks"
import { rememberOcrCatalogue } from "./ocr-model-routing"
import { patchListingWorkbench, resetListingWorkbench, listingWorkbenchScope } from "../workbench/listing-workbench-store"
import { runRows } from "./run-rows"
import { record, ROW, withStubbedDevice } from "./executor-test-support"

test("beginPrepareWork snapshots routing, which reaches each recognition and guided prepare HTTP call", async () => {
  resetListingWorkbench()
  const selection = { primary_model: "first", backup_model: "second" }
  patchListingWorkbench({ modelRouting: selection })
  const batch = preparationBatch({ preparationTracks: { current: createPreparationTracks() },
    guidedPreparationLock: { current: false }, activeWork: { current: new Set() },
    pendingFailures: { current: { ai: [], render: [], deliver: [] } },
    pendingFailureScope: { current: listingWorkbenchScope() } })
  const work = batch.beginPrepareWork([])
  selection.primary_model = "changed"
  patchListingWorkbench({ modelRouting: { primary_model: "later" } })
  const stub = record(call => call.url.endsWith("/prepare") ? { outcome: "blocked", jobs: [], issues: [] } : ROW)
  try {
    for (const verb of ["recognize", "prepare"] as const) {
      await withStubbedDevice(() => batch.prepareAction(work, (request, onRow) => runRows(request, verb, onRow))(
        { row_ids: ["a", "b"], expected_revisions: [] }, () => undefined,
      ))
    }
    const plans = stub.calls.filter(call => call.url.endsWith("/prepare"))
    assert.equal(plans.length, 4)
    for (const plan of plans) assert.deepEqual((plan.body as { model_routing: unknown }).model_routing,
      { primary_model: "first", backup_model: "second" })
    await withStubbedDevice(() => runRows({ row_ids: ["c"], expected_revisions: [] }, "recognize"))
    assert.equal("model_routing" in (stub.calls.filter(call => call.url.endsWith("/prepare")).at(-1)!.body as object), false)
    assert.equal(stub.calls.some(call => call.url.endsWith("/ocr/completions")), false)
  } finally { stub.restore(); resetListingWorkbench() }
})

test("system default is pinned from the loaded catalogue when a task is created", async () => {
  const previous = globalThis.localStorage
  const items = new Map<string, string>()
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value) },
    removeItem: (key: string) => { items.delete(key) },
  } })
  resetListingWorkbench()
  rememberOcrCatalogue({
    prices: [],
    ocr_models: ["deepseek/deepseek-v4.1-flash"],
    default_ocr_model: "deepseek/deepseek-v4.1-flash",
  })
  const batch = preparationBatch({ preparationTracks: { current: createPreparationTracks() },
    guidedPreparationLock: { current: false }, activeWork: { current: new Set() },
    pendingFailures: { current: { ai: [], render: [], deliver: [] } },
    pendingFailureScope: { current: listingWorkbenchScope() } })
  const stub = record(call => call.url.endsWith("/prepare") ? { outcome: "blocked", jobs: [], issues: [] } : ROW)
  try {
    const work = batch.beginPrepareWork([])
    await withStubbedDevice(() => batch.prepareAction(work, (request, onRow) => runRows(request, "recognize", onRow))(
      { row_ids: ["a"], expected_revisions: [] }, () => undefined,
    ))
    const body = stub.calls.find(call => call.url.endsWith("/prepare"))!.body as { model_routing: Record<string, unknown> }
    assert.deepEqual(body.model_routing, { primary_model: "deepseek/deepseek-v4.1-flash" })
    assert.equal("backup_model" in body.model_routing, false)
    assert.equal("priceVersion" in body.model_routing, false)
  } finally {
    stub.restore()
    rememberOcrCatalogue(undefined)
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: previous })
    resetListingWorkbench()
  }
})
