import assert from "node:assert/strict"
import test from "node:test"
import { offerLocked, releaseOfferLock } from "./unknown-locks"
import { createSendQueue } from "../send-queue"
import { finalQueueHarness, prepareQueueRows } from "../send-test-support"
import type { PublishOfferLock } from "../../rows/types"

test("superseded readback, wrong release ID and truncated reads cannot unlock an unknown offer", () => {
  const captured: PublishOfferLock = { platform: "third", destination: "s", rowId: "a", offerId: "same", state: "unknown", intentId: "i1" }
  const locks = [captured]
  assert.equal(offerLocked(locks, "third", "s", "same"), true)
  assert.equal(offerLocked(locks, "other", "s", "same"), false)
  for (const [ids, complete, unresolved] of [[[], true, []], [["other"], true, []], [["i1"], false, []], [["i1"], true, ["i2"]]] as [string[], boolean, string[]][]) {
    assert.deepEqual(releaseOfferLock(locks, captured, ids, { complete, unresolvedIntentIds: unresolved }), locks)
  }
  assert.deepEqual(releaseOfferLock(locks, captured, ["i1"], { complete: true, unresolvedIntentIds: [] }), [])
})

test("unknown row A locks another row B with the same offer across new explicit actions", async () => {
  const { rows, scope } = await finalQueueHarness(2)
  let calls = 0
  const queue = createSendQueue({ rows, ...scope, current: () => true, capabilities: { third: {
    async prepare(selected, signal) {
      const result = await prepareQueueRows(selected, signal)
      return { ...result, items: result.items.map((item) => ({ ...item, offerId: "same" })) }
    }, bytes: () => 1, async send() { calls++; throw new TypeError("lost response") },
  } } })
  try {
    await queue.start([{ platform: "third", destination: "s1", rowIds: ["r0"] }])
    await queue.start([{ platform: "third", destination: "s1", rowIds: ["r1"] }])
    assert.equal(calls, 1)
    assert.equal(rows.get("r0")?.submission?.state, "unconfirmed")
    assert.equal(rows.get("r1")?.submission, undefined)
  } finally { await rows.close() }
})
