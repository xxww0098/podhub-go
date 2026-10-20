import assert from "node:assert/strict"
import test from "node:test"
import { createSendQueue } from "./send-queue"
import { finalQueueHarness, prepareQueueRows, queueAccepted } from "./send-test-support"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

for (const end of ["accepted", "network", "scope", "revision", "delete"] as const) test(`Stop keeps the current request alive and settles ${end} safely`, async () => {
  const { rows, scope } = await finalQueueHarness(101)
  const started = deferred()
  const response = deferred()
  let current = true
  let requests = 0
  const queue = createSendQueue({ rows, ...scope, current: () => current, now: () => 1234, capabilities: { third: {
    prepare: prepareQueueRows, bytes: () => 1,
    async send(_destination, items) {
      requests++; started.resolve(); await response.promise
      if (end === "network") throw new TypeError("response lost")
      return queueAccepted(items)
    },
  } } })
  try {
    const sending = queue.start([{ platform: "third", destination: "s1", rowIds: rows.all().map((row) => row.id) }])
    await started.promise
    const originalDeadlines = queue.snapshot().deadlines
    assert.deepEqual(originalDeadlines, [151234], "one original 150-second submit deadline")
    const at = performance.now()
    queue.stop(); queue.stop()
    assert.equal(queue.snapshot().phase, "stopping")
    assert.equal(queue.snapshot().inFlight, 1)
    assert.ok(performance.now() - at < 100)
    assert.equal(queue.snapshot().deadlines.length, 1)
    assert.deepEqual(queue.snapshot().deadlines, originalDeadlines, "Stop preserves the already-dispatched request's original deadline")
    assert.equal(queue.start([{ platform: "third", destination: "s1", rowIds: ["r100"] }]), sending)
    assert.equal(queue.continue(), sending, "continue while draining cannot replace the current request or its deadline")
    assert.equal(requests, 1)
    if (end === "scope") current = false
    if (end === "revision") rows.update("r0", (row) => ({ ...row, row: { newer: true } }))
    if (end === "delete") rows.remove(["r0"])
    response.resolve(); await sending
    assert.equal(requests, 1)
    assert.equal(rows.get("r100")?.submission, undefined)
    assert.equal(queue.snapshot().phase, "paused")
    if (end === "accepted") assert.equal(rows.get("r0")?.submission?.state, "accepted")
    if (end === "network") assert.equal(rows.get("r0")?.submission?.state, "unconfirmed")
    if (end === "revision" || end === "scope") assert.equal(rows.get("r0")?.submission?.state, "submitting")
    if (end === "delete") assert.equal(rows.get("r0"), undefined)
    assert.equal(rows.cardState()!.publish!.evidence.length, 100)
  } finally { response.resolve(); await rows.close() }
})

test("Stop in the start frame prevents the first admission", async () => {
  const { rows, scope } = await finalQueueHarness()
  let requests = 0
  const queue = createSendQueue({ rows, ...scope, current: () => true, capabilities: { third: {
    prepare: prepareQueueRows, bytes: () => 1, async send(_destination, items) { requests++; return queueAccepted(items) },
  } } })
  try {
    const sending = queue.start([{ platform: "third", destination: "s1", rowIds: ["r0"] }])
    queue.stop()
    await sending
    assert.equal(requests, 0)
    assert.equal(queue.snapshot().phase, "paused")
    assert.equal(rows.cardState()!.publish!.blocks[0]!.budget.submits, 0)
  } finally { await rows.close() }
})

test("Stop interrupts a store-busy wait without another dispatch or resetting its credits", async () => {
  const { rows, scope } = await finalQueueHarness()
  const seen = deferred()
  let requests = 0
  const queue = createSendQueue({ rows, ...scope, current: () => true, capabilities: { third: {
    prepare: prepareQueueRows, bytes: () => 1,
    async send(_destination, items) { requests++; seen.resolve(); return new Map(items.map((item) => [item.rowId, { state: "rejected" as const, canResume: true, admission: "store_busy" as const }])) },
  } } })
  try {
    const sending = queue.start([{ platform: "third", destination: "s1", rowIds: ["r0"] }])
    await seen.promise
    await new Promise((resolve) => setTimeout(resolve, 0))
    const at = performance.now()
    queue.stop(); await sending
    assert.ok(performance.now() - at < 100)
    assert.equal(requests, 1)
    const state = rows.cardState()!.publish!
    assert.equal(state.blocks[0]!.budget.submits, 1)
    assert.equal(Object.values(state.busy)[0]!.attempts, 1)
    assert.equal(state.blocks[0]!.state, "pending")
  } finally { await rows.close() }
})
