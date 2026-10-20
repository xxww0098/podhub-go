/** Real callbacks and HTTP adapter; SSR supplies refs, without mounting effects. */
import assert from "node:assert/strict"
import test from "node:test"
import { setImmediate as tick } from "node:timers/promises"
import { patchListingWorkbench, peekListingWorkbench } from "../workbench/listing-workbench-store"
import { workflowActions } from "../workflow-actions"
import { prepared, refusal, reply, setup } from "./use-preparation-test-harness"

test("stop cancels active Cloud rows and skips unstarted pins, retaining its receipt", async () => {
  const ids = ["a", "b", "c", "d", "e", "f"]
  const f = setup(ids)
  try {
    const running = f.start("runAiRows", ids)
    assert.equal(f.pins.length, 4)
    f.hook.stopPreparation()
    for (const pin of f.pins) pin.resolve(prepared())
    await running
    assert.equal(f.pins.length, 4)
    assert.equal(f.tracks.current.snapshot().ai.size, 0)
    assert.equal(peekListingWorkbench().preparationProgress.ai?.active, false)
    assert.equal(peekListingWorkbench().guidedPreparation.stopRequested, true)
    assert.match(
      peekListingWorkbench().guidedPreparation.stopMessage ?? "",
      /未开始的商品不会消耗 AI 额度/,
    )
  } finally { await f.restore() }
})

test("repeat Stop on a pending cohort shares one cancel; a settled failure can be retried", async () => {
  const f = setup(["a", "b"])
  patchListingWorkbench({ selectedIds: ["b"] })
  const localStop = workflowActions.workflowAnalyzeAssetsStop
  const localStops: string[][] = []
  workflowActions.workflowAnalyzeAssetsStop = async (ids) => { localStops.push([...ids]); return localStop(ids) }
  try {
    const held = f.holdResponse()
    f.setCancelReply(() => held.promise)
    const first = f.hook.stopPreparation()
    assert.equal(f.hook.stopPreparation(), first, "a repeat click joins the pending Stop")
    await tick()
    assert.deepEqual([f.cancels, localStops], [["b"], [["b"]]])
    held.resolve(refusal())
    await first
    assert.equal(peekListingWorkbench().guidedPreparation.stopFailed, true)
    f.setCancelReply(async () => reply({ jobs: [{ id: "cancelled-job" }] }))
    await f.hook.stopPreparation()
    assert.deepEqual([f.cancels, localStops], [["b", "b"], [["b"], ["b"]]])
    assert.equal(peekListingWorkbench().guidedPreparation.stopFailed, false)
    assert.match(peekListingWorkbench().guidedPreparation.stopMessage ?? "", /未开始的商品不会消耗 AI 额度/)
  } finally {
    workflowActions.workflowAnalyzeAssetsStop = localStop
    await f.restore()
  }
})

test("an older cohort's late failure neither frees nor poisons the current cohort's Stop", async () => {
  const f = setup(["a", "b"])
  patchListingWorkbench({ selectedIds: ["b"] })
  try {
    const late = f.holdResponse()
    f.setCancelReply(() => late.promise)
    const older = f.hook.stopPreparation()
    patchListingWorkbench({ selectedIds: ["a"] })
    const current = f.holdResponse()
    f.setCancelReply(() => current.promise)
    const newer = f.hook.stopPreparation()
    await tick()
    assert.deepEqual(f.cancels, ["b", "a"])
    late.resolve(refusal())
    await older
    assert.equal(peekListingWorkbench().guidedPreparation.stopFailed, false)
    assert.equal(f.hook.stopPreparation(), newer, "the older settle must not remove the newer pending entry")
    await tick()
    assert.deepEqual(f.cancels, ["b", "a"])
    // A stale stopFailed would suppress this receipt.
    current.resolve(reply({ jobs: [{ id: "cancelled-job" }] }))
    await newer
    assert.equal(peekListingWorkbench().guidedPreparation.stopFailed, false)
    assert.match(peekListingWorkbench().guidedPreparation.stopMessage ?? "", /未开始的商品不会消耗 AI 额度/)
  } finally { await f.restore() }
})

test("cleanup drains held and not-yet-admitted preparation before restoring fetch", async () => {
  const original = globalThis.fetch
  const escaped: string[] = []
  globalThis.fetch = async (input) => { escaped.push(String(input)); throw new Error("escaped fixture") }
  const f = setup(["a", "b", "c", "d", "e", "f"])
  try {
    const ai = f.start("runAiRows", ["a", "b", "c", "d", "e", "f"])
    const render = f.start("runRenderRows", ["a"])
    assert.equal(f.pins.length, 4)
    const late = f.holdResponse()
    f.setCancelReply(() => late.promise)
    f.hook.stopPreparation()
    await f.restore()
    await Promise.all([ai, render])
    await tick()
    assert.deepEqual(escaped, [])
    assert.equal(f.tracks.current.snapshot().ai.size + f.tracks.current.snapshot().render.size, 0)
  } finally {
    await f.restore()
    globalThis.fetch = original
  }
})
