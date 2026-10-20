import assert from "node:assert/strict"
import test from "node:test"
import { route } from "@/api/routes"
import { createOzonSendCapability } from "../platforms/ozon"
import { createSendQueue } from "./send-queue"
import { finalQueueHarness, golden, goldenSchema, nativePayload, refusal, serve, wasmCore } from "./send-test-support"

async function nativeHarness(count = 400) {
  const h = await finalQueueHarness(count)
  const core = await wasmCore(), handle = core.loadSchema({ snapshot: goldenSchema })
  for (let i = 0; i < count; i++) h.rows.update(`r${i}`, (row) => ({ ...row, storeId: i < 200 ? "s1" : "s2", row: nativePayload(row.id) }))
  await h.rows.flush()
  const capability = createOzonSendCapability({ core, schemaHandle: () => handle, card: () => golden.card, cardId: h.scope.cardId })
  const selection = ["s1", "s2"].map((destination) => ({ platform: "ozon", destination, rowIds: h.rows.all().filter((row) => row.storeId === destination).map((row) => row.id) }))
  return { ...h, capability, selection }
}
function accepted(body: { store_id: string; items: { rowId: string }[] }) {
  return { server_schema_revision: goldenSchema.schema_revision, items: body.items.map(({ rowId }) => ({ row_id: rowId, outcome: "created", intent: {
    id: `i-${rowId}`, listing_row_id: rowId, store_id: body.store_id, row_revision: 9, client_operation_id: `server-${rowId}`,
    state: "accepted", external_task_id: "42", can_resume: false, current_issue_status: "absent", submission_issues: [], submission_receipt_status: "absent", updated_at_ms: 1,
  } })) }
}

for (const code of ["store_unavailable", "submit_capacity_full", "offer_busy"] as const) test(`${code} halts A1 durably, leaves A2 unsent, and B completes; only explicit retry preserves original credits`, async () => {
  const h = await nativeHarness()
  let allowed = false
  const mock = serve(({ url, method, body }) => {
    assert.equal(url, route("listingSubmit")); assert.equal(method, "POST")
    return body.store_id === "s1" && !allowed ? refusal(409, code) : accepted(body)
  })
  const options = { rows: h.rows, ...h.scope, current: () => true, capabilities: { ozon: h.capability } }
  let queue = createSendQueue(options)
  try {
    await queue.start(h.selection)
    const before = h.rows.cardState()!.publish!, a = before.blocks.filter((block) => block.destination === "s1")
    assert.equal(mock.calls.filter((call) => call.body.store_id === "s1").length, 1)
    assert.equal(mock.calls.filter((call) => call.body.store_id === "s2").length, 2)
    assert.deepEqual(a.map((block) => [block.state, block.budget.submits, block.remainingRowIds.length]), [["halted", 1, 100], ["pending", 0, 100]])
    assert.equal(a[0]!.haltReason?.code, code)
    assert.equal(queue.snapshot().counts.accepted, 200)
    assert.ok(h.rows.all().filter((row) => row.storeId === "s1" && row.position >= 100).every((row) => !row.submission))
    assert.deepEqual((await h.repo.cardState(h.scope.workspaceUuid, h.scope.cardId))!.publish, before)
    await queue.continue()
    const result = await queue.reconcile({ platform: "ozon", destination: "s1", blockId: a[0]!.id })
    assert.equal(result.status, "invalid_selection"); assert.equal(mock.calls.length, 3)
    queue = createSendQueue(options); await queue.continue()
    assert.equal(mock.calls.length, 3)
    assert.equal(queue.snapshot().halts[0]!.reason.code, code)
    allowed = true
    await queue.retry(a[0]!.id)
    const after = h.rows.cardState()!.publish!
    assert.equal(after.actionId, before.actionId)
    assert.deepEqual(after.blocks.map((block) => block.id), before.blocks.map((block) => block.id))
    assert.deepEqual(after.blocks.filter((block) => block.destination === "s1").map((block) => block.budget), [{ submits: 2, schema: 0, media: 0 }, { submits: 1, schema: 0, media: 0 }])
    const sentA = mock.calls.filter((call) => call.body.store_id === "s1")
    assert.deepEqual(sentA[0]!.body.items.map((item: { rowId: string }) => item.rowId), sentA[1]!.body.items.map((item: { rowId: string }) => item.rowId))
    assert.equal(queue.snapshot().counts.accepted, 400)
    assert.deepEqual(queue.snapshot().halts, [])
  } finally { mock.restore(); await h.rows.close() }
})

test("persistent busy makes exactly four attempts at 0/5/15/30s, halts A2, and retains exhaustion across refresh/Continue/explicit retry", async () => {
  const h = await nativeHarness()
  let now = Date.now(), allowed = false
  const first = now, waits: number[] = [], times: number[] = []
  const mock = serve(({ body }) => {
    if (body.store_id === "s1") { times.push(now); if (!allowed) return refusal(409, "store_busy") }
    return accepted(body)
  })
  const options = { rows: h.rows, ...h.scope, current: () => true, capabilities: { ozon: h.capability }, now: () => now,
    wait: async (ms: number, signal: AbortSignal) => { assert.equal(signal.aborted, false); waits.push(ms); now += ms } }
  let queue = createSendQueue(options)
  try {
    await queue.start(h.selection)
    const before = h.rows.cardState()!.publish!, a = before.blocks.filter((block) => block.destination === "s1")
    assert.deepEqual(waits, [5000, 10000, 15000]); assert.deepEqual(times, [first, first + 5000, first + 15000, first + 30000])
    assert.deepEqual(a.map((block) => [block.state, block.budget.submits]), [["halted", 4], ["pending", 0]])
    assert.equal(a[0]!.haltReason?.cause, "retries_exhausted")
    assert.equal(queue.snapshot().counts.accepted, 200)
    assert.equal(Object.values(before.busy)[0]!.attempts, 3)
    queue = createSendQueue(options); await queue.continue()
    assert.equal(times.length, 4)
    await queue.retry(a[0]!.id)
    assert.equal(times.length, 5, "explicit retry permits one new request, never replenishes busy retries")
    assert.deepEqual(waits, [5000, 10000, 15000])
    assert.equal(h.rows.cardState()!.publish!.blocks[0]!.budget.submits, 5)
    allowed = true; await queue.retry(a[0]!.id)
    assert.equal(queue.snapshot().counts.accepted, 400)
    assert.equal(h.rows.cardState()!.publish!.actionId, before.actionId)
    assert.equal(h.rows.cardState()!.publish!.blocks[0]!.budget.submits, 6)
    assert.deepEqual(h.rows.cardState()!.publish!.busy, before.busy)
  } finally { mock.restore(); await h.rows.close() }
})

test("busy deadline expiring after a wait halts without a second request or settling the pending parent", async () => {
  const h = await nativeHarness()
  let now = Date.now()
  const mock = serve(({ body }) => body.store_id === "s1" ? refusal(409, "store_busy") : accepted(body))
  const queue = createSendQueue({ rows: h.rows, ...h.scope, current: () => true, capabilities: { ozon: h.capability }, now: () => now,
    wait: async () => { now += 30_001 } })
  try {
    await queue.start(h.selection)
    const a = h.rows.cardState()!.publish!.blocks.filter((block) => block.destination === "s1")
    assert.equal(mock.calls.filter((call) => call.body.store_id === "s1").length, 1)
    assert.deepEqual(a.map((block) => [block.state, block.budget.submits, block.remainingRowIds.length]), [["halted", 1, 100], ["pending", 0, 100]])
    assert.equal(a[0]!.haltReason?.cause, "deadline_exhausted")
    assert.equal(queue.snapshot().counts.accepted, 200)
    await queue.continue(); assert.equal(mock.calls.length, 3)
  } finally { mock.restore(); await h.rows.close() }
})

test("Stop during busy wait preserves its pending rows and reserved credit; refresh waits the remainder and never resets the 30s deadline", async () => {
  const h = await nativeHarness(200)
  let now = Date.now(), waiting!: () => void
  const seen = new Promise<void>((resolve) => { waiting = resolve })
  const mock = serve(() => refusal(409, "store_busy"))
  const options = { rows: h.rows, ...h.scope, current: () => true, capabilities: { ozon: h.capability }, now: () => now }
  let queue = createSendQueue({ ...options, wait: async (_ms, signal) => {
    waiting(); await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
  } })
  try {
    const sending = queue.start(h.selection); await seen
    now += 1000; queue.stop(); await sending
    const before = h.rows.cardState()!.publish!
    assert.equal(mock.calls.length, 1)
    assert.deepEqual(before.blocks.map((block) => [block.state, block.remainingRowIds.length, block.budget.submits]), [["pending", 100, 1], ["pending", 100, 0]])
    assert.equal(Object.values(before.busy)[0]!.attempts, 1)
    const waits: number[] = []
    queue = createSendQueue({ ...options, wait: async (ms) => { waits.push(ms); now += ms } })
    await queue.continue()
    assert.deepEqual(waits, [4000, 10000, 15000])
    assert.equal(mock.calls.length, 4)
    assert.equal(h.rows.cardState()!.publish!.blocks[1]!.budget.submits, 0)
    assert.equal(h.rows.cardState()!.publish!.actionId, before.actionId)
    assert.equal(Object.values(h.rows.cardState()!.publish!.busy)[0]!.startedAt, Object.values(before.busy)[0]!.startedAt)
  } finally { mock.restore(); await h.rows.close() }
})

for (const resume of ["expired", "timely"] as const) test(`Stop during persisted busy preflight keeps its original reservation for ${resume} Continue and refresh`, async () => {
  const h = await nativeHarness()
  let now = Date.now(), held = false, entered!: () => void, release!: () => void
  const first = now, waits: number[] = []
  const seen = new Promise<void>((resolve) => { entered = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const flush = h.rows.flush.bind(h.rows)
  h.rows.flush = async () => {
    const block = h.rows.cardState()?.publish?.blocks.find((entry) => entry.destination === "s1" && entry.rowIds.includes("r0"))
    const preflight = !held && block?.state === "sending" && block.budget.submits === 2
    if (preflight) held = true
    await flush() // Real queue, locks and row pins are saved before delaying the preflight return.
    if (preflight) { entered(); await gate }
  }
  let dispatchedA = 0
  const mock = serve(({ url, method, body }) => {
    assert.equal(url, route("listingSubmit")); assert.equal(method, "POST")
    if (body.store_id === "s1" && ++dispatchedA === 1) return refusal(409, "store_busy")
    return accepted(body)
  })
  const options = { rows: h.rows, ...h.scope, current: () => true, capabilities: { ozon: h.capability }, now: () => now,
    wait: async (ms: number, signal: AbortSignal) => { assert.equal(signal.aborted, false); waits.push(ms); now += ms } }
  let queue = createSendQueue(options)
  try {
    const sending = queue.start(h.selection)
    await Promise.race([seen, sending.then(() => { throw new Error("Busy retry completed without the held preflight flush") })])
    const preflight = (await h.repo.cardState(h.scope.workspaceUuid, h.scope.cardId))!.publish!
    const a = preflight.blocks.filter((block) => block.destination === "s1")
    assert.deepEqual(waits, [5000]); assert.equal(now, first + 5000)
    assert.equal(dispatchedA, 1, "the second submit credit is persisted, but no second request was dispatched")
    assert.deepEqual(a.map((block) => [block.state, block.budget.submits, block.remainingRowIds.length]), [["sending", 2, 100], ["pending", 0, 100]])
    assert.equal(a[0]!.busyRetryAt, first + 5000)
    assert.deepEqual(Object.values(preflight.busy), [{ attempts: 1, startedAt: first }])
    const aLocks = preflight.locks.filter((lock) => lock.destination === "s1")
    assert.deepEqual(aLocks.map((lock) => [lock.rowId, lock.state]), a[0]!.rowIds.map((id) => [id, "pending"]))
    const savedRows = (await h.repo.rowsOfCard(h.scope.workspaceUuid, h.scope.cardId)).filter((row) => row.storeId === "s1")
    assert.deepEqual(savedRows, h.rows.all().filter((row) => row.storeId === "s1"))
    assert.ok(savedRows.slice(0, 100).every((row) => row.submission?.state === "submitting"
      && row.submission.logicalBlockId === a[0]!.id && row.submission.sendActionId === preflight.actionId))
    assert.ok(savedRows.slice(100).every((row) => !row.submission))
    queue.stop(); release(); await sending
    const paused = h.rows.cardState()!.publish!, pausedA = paused.blocks.filter((block) => block.destination === "s1")
    const pausedRows = structuredClone(h.rows.all().filter((row) => row.storeId === "s1"))
    assert.equal(dispatchedA, 1)
    assert.equal(paused.phase, "paused"); assert.equal(paused.actionId, preflight.actionId)
    assert.deepEqual(paused.busy, preflight.busy)
    assert.deepEqual(pausedA.map((block) => [block.state, block.budget.submits, block.remainingRowIds.length]), [["pending", 2, 100], ["pending", 0, 100]])
    assert.equal(pausedA[0]!.busyRetryAt, a[0]!.busyRetryAt)
    assert.deepEqual(paused.blocks.map((block) => block.id), preflight.blocks.map((block) => block.id))
    assert.equal(paused.locks.filter((lock) => lock.destination === "s1").length, 0)
    assert.ok(pausedRows.slice(0, 100).every((row) => row.submission?.state === "rejected"
      && (row.submission.receipt as { code?: string }).code === "stopped_before_dispatch"
      && row.submission.logicalBlockId === a[0]!.id && row.submission.sendActionId === preflight.actionId))
    assert.deepEqual(pausedRows.slice(100), savedRows.slice(100))
    assert.deepEqual((await h.repo.cardState(h.scope.workspaceUuid, h.scope.cardId))!.publish, paused)
    if (resume === "timely") queue = createSendQueue(options)
    now = first + (resume === "expired" ? 30_001 : 6000)
    await queue.continue()
    const after = h.rows.cardState()!.publish!, afterA = after.blocks.filter((block) => block.destination === "s1")
    assert.equal(after.actionId, preflight.actionId); assert.deepEqual(after.busy, preflight.busy)
    assert.deepEqual(after.blocks.map((block) => block.id), preflight.blocks.map((block) => block.id))
    assert.equal(mock.calls.filter((call) => call.body.store_id === "s2").length, 2, "the other destination completes independently")
    assert.ok(h.rows.all().filter((row) => row.storeId === "s2").every((row) => row.submission?.state === "accepted"))
    if (resume === "expired") {
      assert.equal(dispatchedA, 1); assert.deepEqual(waits, [5000])
      assert.deepEqual(afterA.map((block) => [block.state, block.budget.submits, block.remainingRowIds.length]), [["halted", 2, 100], ["pending", 0, 100]])
      assert.deepEqual(afterA[0]!.haltReason, { code: "store_busy", cause: "deadline_exhausted", at: now })
      assert.deepEqual(h.rows.all().filter((row) => row.storeId === "s1"), pausedRows)
      assert.equal(queue.snapshot().counts.accepted, 200)
    } else {
      assert.equal(dispatchedA, 3); assert.deepEqual(waits, [5000, 0])
      assert.deepEqual(afterA.map((block) => block.budget), [{ submits: 3, schema: 0, media: 0 }, { submits: 1, schema: 0, media: 0 }])
      assert.equal(afterA[0]!.busyRetryAt, undefined)
      assert.equal(queue.snapshot().counts.accepted, 400)
      const requests = mock.calls.filter((call) => call.body.store_id === "s1")
      assert.deepEqual(requests[0]!.body.items.map((item: { rowId: string }) => item.rowId), requests[1]!.body.items.map((item: { rowId: string }) => item.rowId))
    }
    assert.deepEqual((await h.repo.cardState(h.scope.workspaceUuid, h.scope.cardId))!.publish, after)
    const beforeRefreshRows = structuredClone(h.rows.all()), dispatches = mock.calls.length
    queue = createSendQueue(options); await queue.continue()
    assert.equal(mock.calls.length, dispatches)
    assert.deepEqual(h.rows.all(), beforeRefreshRows)
    assert.deepEqual(h.rows.cardState()!.publish, after)
    assert.deepEqual((await h.repo.cardState(h.scope.workspaceUuid, h.scope.cardId))!.publish, after)
  } finally { queue.stop(); release(); await queue.settled(); h.rows.flush = flush; mock.restore(); await h.rows.close() }
})

test("per-item offer_busy is distinct from a request admission halt and does not stop the next logical block", async () => {
  const h = await nativeHarness(200)
  const mock = serve(({ body }) => body.items[0].rowId === "r0"
    ? { server_schema_revision: goldenSchema.schema_revision, items: body.items.map((item: { rowId: string }) => ({ row_id: item.rowId, outcome: "skipped", skip_reason: "offer_busy", issues: [] })) }
    : accepted(body))
  const queue = createSendQueue({ rows: h.rows, ...h.scope, current: () => true, capabilities: { ozon: h.capability } })
  try {
    await queue.start(h.selection)
    assert.equal(mock.calls.length, 2)
    assert.equal(queue.snapshot().counts.rejected, 100); assert.equal(queue.snapshot().counts.accepted, 100)
    assert.deepEqual(queue.snapshot().halts, [])
  } finally { mock.restore(); await h.rows.close() }
})

test("read-only reconciliation of an older pending operation cannot clear a typed halt; mismatched history and explicit retry leave its unknown lock untouched", async () => {
  const h = await nativeHarness(500)
  for (let i = 200; i < 300; i++) h.rows.update(`r${i}`, (row) => ({ ...row, storeId: "s1" }))
  const selection = ["s1", "s2"].map((destination) => ({ platform: "ozon", destination, rowIds: h.rows.all().filter((row) => row.storeId === destination).map((row) => row.id) }))
  let matched = false, allowed = false
  const mock = serve(({ url, method, body }) => {
    if (method === "GET") {
      const query = new URL(url, "http://fixture.invalid")
      assert.equal(query.pathname, route("listingIntents")); assert.equal(query.searchParams.get("storeId"), "s1")
      assert.equal(query.searchParams.get("limit"), "100"); assert.equal(query.searchParams.get("latestPerRow"), "true")
      const ids = query.searchParams.get("intentIds")!.split(",")
      assert.equal(ids.length, 100)
      return { items: ids.map((id) => ({ ...accepted({ store_id: "s1", items: [{ rowId: id.slice(2) }] }).items[0]!.intent,
        ...(!matched ? { client_operation_id: "old-foreign-operation" } : {}) })) }
    }
    assert.equal(url, route("listingSubmit"))
    if (body.store_id === "s1" && body.items[0].rowId === "r0") {
      const result = accepted(body)
      for (const item of result.items) { item.intent.state = "queued"; item.intent.external_task_id = "" }
      return result
    }
    return body.store_id === "s1" && !allowed ? refusal(409, "store_unavailable") : accepted(body)
  })
  const options = { rows: h.rows, ...h.scope, current: () => true, capabilities: { ozon: h.capability } }
  let queue = createSendQueue(options)
  try {
    await queue.start(selection)
    queue = createSendQueue(options); await queue.continue()
    const before = h.rows.cardState()!.publish!, halted = before.blocks.find((block) => block.haltReason)!
    const olderRows = structuredClone(h.rows.all().filter((row) => row.position < 100))
    const unresolved = await queue.reconcile({ platform: "ozon", destination: "s1", blockId: before.blocks[0]!.id })
    assert.deepEqual(unresolved.appliedRowIds, [])
    await queue.retry(halted.id)
    assert.equal(mock.calls.filter((call) => call.method === "POST").length, 4)
    assert.deepEqual(h.rows.all().filter((row) => row.position < 100), olderRows)
    assert.equal(h.rows.cardState()!.publish!.blocks.find((block) => block.id === halted.id)!.budget.submits, 1)
    assert.equal(h.rows.cardState()!.publish!.locks.filter((lock) => lock.state === "unknown").length, 100)
    matched = true
    const resolved = await queue.reconcile({ platform: "ozon", destination: "s1", blockId: before.blocks[0]!.id })
    assert.equal(resolved.appliedRowIds.length, 100)
    assert.equal(queue.snapshot().halts[0]!.reason.code, "store_unavailable")
    await queue.continue(); assert.equal(mock.calls.filter((call) => call.method === "POST").length, 4)
    allowed = true; await queue.retry(halted.id)
    assert.equal(h.rows.cardState()!.publish!.blocks.find((block) => block.id === halted.id)!.budget.submits, 2)
    assert.equal(h.rows.cardState()!.publish!.actionId, before.actionId)
    assert.ok(h.rows.all().filter((row) => row.position < 100).every((row) => row.submission?.state === "accepted"))
  } finally { mock.restore(); await h.rows.close() }
})
