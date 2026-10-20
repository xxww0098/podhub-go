import assert from "node:assert/strict"
import test from "node:test"
import { createSendQueue } from "./send-queue"
import { finalQueueHarness, prepareQueueRows, queueAccepted } from "./send-test-support"
import type { SendCapability } from "./queue/types"

const basic = (): SendCapability => ({ prepare: prepareQueueRows, bytes: () => 1, send: async (_destination, items) => queueAccepted(items) })

test("two stores each ten blocks: A network failure on block 2 stops A3–10 while B completes", async () => {
  const { rows, repo, scope } = await finalQueueHarness(2000)
  for (let i = 1000; i < 2000; i++) rows.update(`r${i}`, (row) => ({ ...row, storeId: "s2" }))
  let active = 0
  let max = 0
  const counts: Record<string, number> = {}
  const capability: SendCapability = { ...basic(), async send(destination, items) {
    counts[destination] = (counts[destination] ?? 0) + 1
    active++; max = Math.max(max, active)
    assert.equal(items.length, 100)
    const stored = await repo.cardState(scope.workspaceUuid, scope.cardId)
    assert.ok(stored?.publish?.blocks.some((block) => block.state === "sending" && block.budget.submits > 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    active--
    if (destination === "s1" && counts.s1 === 2) throw new TypeError("response lost")
    return queueAccepted(items)
  } }
  const queue = createSendQueue({ rows, ...scope, current: () => true, capabilities: { third: capability } })
  try {
    const selection = [{ platform: "third", destination: "s1", rowIds: rows.all().slice(0, 1000).map((row) => row.id) },
      { platform: "third", destination: "s2", rowIds: rows.all().slice(1000).map((row) => row.id) }]
    const first = queue.start(selection)
    assert.equal(queue.start(selection), first, "double click shares one action")
    await first
    assert.deepEqual(counts, { s1: 2, s2: 10 })
    assert.ok(max <= 2)
    assert.equal(rows.get("r100")?.submission?.state, "unconfirmed")
    assert.equal(rows.get("r200")?.submission, undefined)
    assert.equal(rows.get("r1999")?.submission?.state, "accepted")
    await queue.continue()
    assert.deepEqual(counts, { s1: 2, s2: 10 })
  } finally { await rows.close() }
})

for (const refusal of ["store_unavailable", "submit_capacity_full", "offer_busy"] as const) test(`${refusal}: zero automatic retries; explicit retry preserves parent budget`, async () => {
  const { rows, scope } = await finalQueueHarness()
  let calls = 0
  const capability: SendCapability = { ...basic(), async send(_destination, items) {
    calls++
    return calls === 1 ? new Map(items.map((item) => [item.rowId, { state: "rejected", canResume: true, admission: refusal }])) : queueAccepted(items)
  } }
  const queue = createSendQueue({ rows, ...scope, current: () => true, capabilities: { third: capability } })
  try {
    await queue.start([{ platform: "third", destination: "s1", rowIds: ["r0"] }])
    assert.equal(calls, 1)
    const parent = rows.cardState()!.publish!.blocks[0]!
    assert.equal(parent.budget.submits, 1)
    const action = rows.cardState()!.publish!.actionId
    await queue.retry(parent.id)
    assert.equal(calls, 2)
    assert.equal(rows.cardState()!.publish!.blocks[0]!.budget.submits, 2)
    assert.equal(rows.cardState()!.publish!.actionId, action)
  } finally { await rows.close() }
})

test("schema/media repairs are each real, at most once and share the parent submit budget", async () => {
  const { rows, scope } = await finalQueueHarness()
  const repairs: string[] = []
  let calls = 0
  const capability: SendCapability = { ...basic(), async send(_destination, items) {
    calls++
    const code = calls === 1 ? "schema_stale" : calls === 2 ? "media_expired" : undefined
    return code ? new Map(items.map((item) => [item.rowId, { state: "rejected", canResume: true, code }])) : queueAccepted(items)
  }, async repair(kind, selected) {
    repairs.push(kind)
    for (const row of selected) rows.update(row.id, (value) => ({ ...value, row: { repaired: kind } }))
  } }
  const queue = createSendQueue({ rows, ...scope, current: () => true, capabilities: { third: capability } })
  try {
    await queue.start([{ platform: "third", destination: "s1", rowIds: ["r0"] }])
    assert.deepEqual(repairs, ["schema", "media"])
    assert.equal(calls, 3)
    assert.deepEqual(rows.cardState()!.publish!.blocks[0]!.budget, { submits: 3, schema: 1, media: 1 })
    assert.equal(rows.get("r0")?.submission?.state, "accepted")
  } finally { await rows.close() }
})

for (const refusal of ["store_unavailable", "submit_capacity_full", "offer_busy"] as const) test(`${refusal} never clears older unknown, queued or accepted rows selected alongside a new row`, async () => {
  const { rows, scope } = await finalQueueHarness(4)
  for (const [index, state] of (["unconfirmed", "queued", "accepted"] as const).entries()) {
    rows.update(`r${index}`, (row) => ({ ...row, submission: { state, storeId: "s1", intentId: `old-${index}` } }))
  }
  const previous = ["r0", "r1", "r2"].map((id) => structuredClone(rows.get(id)))
  let calls = 0
  const capability: SendCapability = { ...basic(), async send(_destination, items) {
    calls++
    assert.deepEqual(items.map((item) => item.rowId), ["r3"])
    return new Map(items.map((item) => [item.rowId, { state: "rejected", canResume: true, admission: refusal }]))
  } }
  const queue = createSendQueue({ rows, ...scope, current: () => true, capabilities: { third: capability } })
  try {
    await queue.start([{ platform: "third", destination: "s1", rowIds: rows.all().map((row) => row.id) }])
    assert.equal(calls, 1)
    assert.deepEqual(["r0", "r1", "r2"].map((id) => rows.get(id)), previous)
    assert.equal(rows.cardState()!.publish!.blocks[0]!.budget.submits, 1)
  } finally { await rows.close() }
})

test("unregistered send capability stays local and makes no transport call", async () => {
  const { rows, scope } = await finalQueueHarness()
  const queue = createSendQueue({ rows, ...scope, current: () => true, capabilities: {} })
  try {
    await queue.start([{ platform: "disabled", destination: "s1", rowIds: ["r0"] }])
    assert.equal(rows.get("r0")?.submission?.state, "rejected")
    assert.equal(rows.cardState()!.publish!.blocks[0]!.budget.submits, 0)
    assert.equal(queue.snapshot().counts.rejected, 1)
  } finally { await rows.close() }
})

test("first byte partition gets stable parents; later attempts spend those same parents", async () => {
  const { rows, scope } = await finalQueueHarness(3)
  const capability: SendCapability = { ...basic(), bytes: (_destination, items) => items.length * 4 * 1024 * 1024 }
  const queue = createSendQueue({ rows, ...scope, current: () => true, capabilities: { third: capability } })
  try {
    await queue.start([{ platform: "third", destination: "s1", rowIds: ["r0", "r1", "r2"] }])
    const blocks = rows.cardState()!.publish!.blocks
    assert.deepEqual(blocks.map((block) => [block.rowIds.length, block.budget.submits]), [[1, 1], [1, 1], [1, 1]])
    assert.equal(new Set(blocks.map((block) => block.id)).size, 3)
  } finally { await rows.close() }
})

test("three registered platforms share two destination slots and keep partial success", async () => {
  const { rows, scope } = await finalQueueHarness(3)
  let active = 0
  let maximum = 0
  const called: string[] = []
  const capability = (platform: string): SendCapability => ({ ...basic(), async send(_destination, items) {
    called.push(platform)
    active++; maximum = Math.max(maximum, active)
    await new Promise((resolve) => setTimeout(resolve, 0))
    active--
    if (platform === "second") throw new TypeError("response lost")
    return queueAccepted(items)
  } })
  const queue = createSendQueue({ rows, ...scope, current: () => true, capabilities: {
    first: capability("first"), second: capability("second"), third: capability("third"),
  } })
  try {
    await queue.start(["first", "second", "third"].map((platform, index) => ({ platform, destination: "s1", rowIds: [`r${index}`] })))
    assert.deepEqual(called.sort(), ["first", "second", "third"])
    assert.equal(maximum, 2)
    assert.deepEqual(queue.snapshot().counts, { accepted: 2, pending: 0, rejected: 0, unknown: 1 })
    assert.equal(queue.snapshot().haltedDestinations.length, 1)
  } finally { await rows.close() }
})
