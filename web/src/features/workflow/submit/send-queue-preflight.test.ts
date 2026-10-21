import assert from "node:assert/strict"
import test from "node:test"
import { createSendQueue } from "./send-queue"
import { finalQueueHarness, prepareQueueRows, queueAccepted } from "./send-test-support"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

for (const change of ["revision", "store", "delete", "receipt"] as const) {
  for (const peers of [0, 1]) test(`durable preflight ${change} never dispatches the old row, with ${peers} unchanged peer`, async () => {
    const { rows, repo, scope } = await finalQueueHarness(1 + peers)
    const entered = deferred()
    const release = deferred()
    const flush = rows.flush.bind(rows)
    let held = false
    rows.flush = async () => {
      const hold = !held && rows.cardState()?.publish?.blocks.some((block) => block.state === "sending")
      if (hold) held = true
      await flush()
      if (hold) { entered.resolve(); await release.promise }
    }
    const sent: string[][] = []
    const queue = createSendQueue({ rows, ...scope, current: () => true, capabilities: { third: {
      prepare: prepareQueueRows, bytes: () => 1,
      async send(_destination, items) { sent.push(items.map((item) => item.rowId)); return queueAccepted(items) },
    } } })
    try {
      const sending = queue.start([{ platform: "third", destination: "s1", rowIds: rows.all().map((row) => row.id) }])
      await Promise.race([entered.promise, sending.then(() => { throw new Error("The durable admission was not held") })])
      assert.equal(sent.length, 0)
      const admitted = (await repo.cardState(scope.workspaceUuid, scope.cardId))!.publish!
      assert.equal(admitted.blocks[0]!.budget.submits, 1)
      assert.equal(admitted.locks.length, 1 + peers)
      if (change === "revision") rows.update("r0", (row) => ({ ...row, row: { edited: true } }))
      if (change === "store") rows.update("r0", (row) => ({ ...row, storeId: "s2" }))
      if (change === "delete") rows.remove(["r0"])
      if (change === "receipt") rows.update("r0", (row) => ({ ...row, submission: {
        ...row.submission!, state: "accepted", intentId: "newer-intent", clientOperationId: "newer-operation",
      } }))
      const changed = structuredClone(rows.get("r0"))
      release.resolve()
      await sending
      assert.deepEqual(sent, peers ? [["r1"]] : [], "a freeze does not authorize dispatch after its row changes")
      if (change === "delete" || change === "receipt") assert.deepEqual(rows.get("r0"), changed)
      else {
        assert.deepEqual(rows.get("r0")?.row, changed!.row)
        assert.equal(rows.get("r0")?.storeId, changed!.storeId)
        assert.equal(rows.get("r0")?.submission?.state, "rejected", "an unsent admission cannot strand the edited row as submitting")
        const receipt = rows.get("r0")!.submission!.receipt as { code: string }
        assert.equal(receipt.code, "row_changed_before_dispatch")
      }
      if (peers) assert.equal(rows.get("r1")?.submission?.state, "accepted")
      const final = rows.cardState()!.publish!
      assert.equal(final.actionId, admitted.actionId)
      assert.deepEqual(final.blocks[0]!.budget, admitted.blocks[0]!.budget, "a local refusal cannot refund submit or repair credits")
      assert.equal(final.locks.some((lock) => lock.rowId === "r0"), false, "only this unsent admission's lock is removed")
      assert.deepEqual((await repo.cardState(scope.workspaceUuid, scope.cardId))!.publish, final)
      assert.deepEqual(await repo.rowsOfCard(scope.workspaceUuid, scope.cardId), rows.all())
    } finally {
      release.resolve(); await queue.settled(); rows.flush = flush; await rows.close()
    }
  })
}

for (const change of ["edit", "stop"] as const) test(`the final queue notification cannot dispatch after a subscriber's ${change}`, async () => {
  const { rows, scope } = await finalQueueHarness()
  let requests = 0
  let notified = false
  const queue = createSendQueue({ rows, ...scope, current: () => true, capabilities: { third: {
    prepare: prepareQueueRows, bytes: () => 1,
    async send(_destination, items) { requests++; return queueAccepted(items) },
  } } })
  const unsubscribe = queue.subscribe(() => {
    if (notified || queue.snapshot().inFlight !== 1) return
    notified = true
    if (change === "edit") rows.update("r0", (row) => ({ ...row, row: { edited: true } }))
    else queue.stop()
  })
  try {
    await queue.start([{ platform: "third", destination: "s1", rowIds: ["r0"] }])
    assert.equal(notified, true)
    assert.equal(requests, 0)
    assert.equal(queue.snapshot().inFlight, 0)
    assert.deepEqual(queue.snapshot().deadlines, [])
    assert.equal(rows.cardState()!.publish!.locks.length, 0)
    assert.equal(rows.get("r0")?.submission?.state, "rejected")
    if (change === "edit") assert.deepEqual(rows.get("r0")?.row, { edited: true })
    else assert.equal(queue.snapshot().phase, "paused")
  } finally { unsubscribe(); await queue.settled(); await rows.close() }
})
