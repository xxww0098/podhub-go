import assert from "node:assert/strict"
import test from "node:test"
import { openCardRows } from "./card-rows"
import { memoryRowRepo } from "./row-repo"

const scope = { workspaceUuid: "ws", cardId: "card" }
const lock = (writable = true) => async () => ({ writable, onChange: () => () => {}, release() {} })
const state = { ...scope, queue: { frozenRowIds: [], nextPosition: 0, paused: true, stopAfterCurrent: false } }

test("card state uses the same writer lock and reaches storage only through flush", async () => {
  const repo = memoryRowRepo()
  const rows = await openCardRows(repo, scope, lock())
  rows.updateCardState(() => state)
  assert.equal(await repo.cardState("ws", "card"), undefined)
  await rows.flush()
  assert.deepEqual(await repo.cardState("ws", "card"), state)
  assert.throws(() => rows.updateCardState(() => ({ ...state, cardId: "elsewhere" })), /scope/)
  const copy = rows.cardState()!
  copy.queue.paused = false
  assert.equal(rows.cardState()!.queue.paused, true)
  await rows.close()
  const readonly = await openCardRows(repo, scope, lock(false))
  assert.throws(() => readonly.updateCardState(() => state), /read-only/)
  await readonly.close()
})

test("failed state persistence keeps the writer and retries the same state", async () => {
  const repo = memoryRowRepo()
  let fail = true
  const rows = await openCardRows({ ...repo, async putCardState(value) { if (fail) throw new Error("quota"); await repo.putCardState(value) } }, scope, lock())
  rows.updateCardState(() => state)
  await assert.rejects(rows.flush(), /quota/)
  assert.equal(rows.cardState()?.queue.paused, true)
  fail = false
  await rows.flush()
  assert.deepEqual(await repo.cardState("ws", "card"), state)
  await rows.close()
})

test("workspace offer locks survive card switches and are isolated from another workspace", async () => {
  const repo = memoryRowRepo()
  const rows = await openCardRows(repo, scope, lock())
  const captured = { platform: "third", destination: "store", rowId: "deleted", offerId: "same", state: "unknown" as const }
  rows.updateCardState(() => ({ ...state, publish: { actionId: "a", phase: "paused", blocks: [], busy: {}, evidence: [], locks: [captured] } }))
  await rows.flush()
  await rows.close()
  const otherCard = await openCardRows(repo, { ...scope, cardId: "other-card" }, lock())
  assert.deepEqual(await otherCard.knownOfferLocks(), [captured])
  assert.deepEqual(await repo.offerLocks("other-workspace"), [])
  await otherCard.close()
})
