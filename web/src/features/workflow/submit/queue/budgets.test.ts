import assert from "node:assert/strict"
import test from "node:test"
import { spendBusy, spendRepair, spendSubmit, waitForAdmission } from "./budgets"
import type { PublishQueueState } from "../../rows/types"

test("parent budgets survive cloning, subsets and byte repartition; busy is action/destination bounded", async () => {
  let budget = { submits: 0, schema: 0, media: 0 }
  assert.equal(spendRepair(budget, "schema"), true)
  budget = structuredClone(budget)
  assert.equal(spendRepair(budget, "schema"), false)
  assert.equal(spendRepair(budget, "media"), true)
  for (let i = 0; i < 6; i++) assert.equal(spendSubmit(budget), true)
  assert.equal(spendSubmit(budget), false)
  const state: PublishQueueState = { actionId: "a", phase: "paused", blocks: [], locks: [], busy: {}, evidence: [] }
  for (let i = 0; i < 3; i++) assert.equal(spendBusy(state, "destination", 1000), true)
  assert.equal(spendBusy(structuredClone(state), "destination", 1001), false)
  assert.equal(spendBusy(state, "second", 1000), true)
  assert.equal(spendBusy(state, "second", 31_000), false)
  const stop = new AbortController()
  const before = performance.now()
  const waiting = waitForAdmission(30_000, stop.signal)
  stop.abort()
  await waiting
  assert.ok(performance.now() - before < 100)
})

test("busy retries wait 5/10/15 seconds and permit the fourth submit at the inclusive 30-second boundary", async () => {
  const { createSendQueue } = await import("../send-queue")
  const { finalQueueHarness, prepareQueueRows, queueAccepted } = await import("../send-test-support")
  const { rows, scope } = await finalQueueHarness()
  let now = 1000
  const waits: number[] = [], dispatches: number[] = [], deadlines: number[] = []
  const queue = createSendQueue({ rows, ...scope, current: () => true, now: () => now,
    wait: async (ms, signal) => { assert.equal(signal.aborted, false); waits.push(ms); now += ms },
    capabilities: { third: { prepare: prepareQueueRows, bytes: () => 1,
      async send(_destination, items, request) {
        dispatches.push(now); deadlines.push(request.deadlineAt)
        if (dispatches.length < 4) return new Map(items.map((item) => [item.rowId, { state: "rejected", canResume: true, admission: "store_busy" }]))
        return queueAccepted(items)
      },
    } },
  })
  try {
    await queue.start([{ platform: "third", destination: "s1", rowIds: ["r0"] }])
    assert.deepEqual(waits, [5000, 10000, 15000])
    assert.deepEqual(dispatches, [1000, 6000, 16000, 31000])
    assert.deepEqual(deadlines, dispatches.map((at) => at + 150_000))
    const state = rows.cardState()!.publish!
    assert.equal(state.blocks[0]!.budget.submits, 4)
    assert.equal(Object.values(state.busy)[0]!.attempts, 3)
    await queue.continue(); await queue.retry(state.blocks[0]!.id)
    assert.equal(dispatches.length, 4, "accepted rows cannot gain a fifth admission")
  } finally { await rows.close() }
})
