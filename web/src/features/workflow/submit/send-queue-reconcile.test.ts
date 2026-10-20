import assert from "node:assert/strict"
import test from "node:test"
import { route } from "@/api/routes"
import type { ListingIntent } from "@/bindings/http-listing-intents"
import { createOzonSendCapability } from "../platforms/ozon"
import { createSendQueue } from "./send-queue"
import { finalQueueHarness, golden, goldenSchema, nativePayload, serve, wasmCore } from "./send-test-support"

async function pendingHarness(count = 200) {
  const h = await finalQueueHarness(count)
  const core = await wasmCore(), handle = core.loadSchema({ snapshot: goldenSchema })
  for (const row of h.rows.all()) h.rows.update(row.id, (current) => ({ ...current, row: nativePayload(row.id) }))
  const capability = createOzonSendCapability({ core, schemaHandle: () => handle, card: () => golden.card, cardId: h.scope.cardId })
  const intents = new Map<string, ListingIntent>()
  const options = { rows: h.rows, ...h.scope, current: () => true, capabilities: { ozon: capability } }
  const queue = createSendQueue(options)
  const mock = serve(({ url, method, body }) => {
    assert.equal(url, route("listingSubmit")); assert.equal(method, "POST")
    return { server_schema_revision: goldenSchema.schema_revision, items: body.items.map(({ rowId }: { rowId: string }) => {
      const intent: ListingIntent = { id: `i-${rowId}`, listing_row_id: rowId, row_revision: 9, store_id: body.store_id,
        client_operation_id: `server-${rowId}`, state: "queued", can_resume: false, current_issue_status: "absent", submission_issues: [], submission_receipt_status: "absent", updated_at_ms: 1 }
      intents.set(intent.id, intent)
      return { row_id: rowId, outcome: "created", intent }
    }) }
  })
  try { await queue.start([{ platform: "ozon", destination: "s1", rowIds: h.rows.all().map((row) => row.id) }]) }
  catch (error) { await h.rows.close(); throw error }
  finally { mock.restore() }
  const refreshed = createSendQueue(options)
  await refreshed.continue() // Persist the conservative refresh projection; all parents are already settled, so zero fetches.
  return { ...h, options, intents, queue: refreshed }
}
function selected(url: string) {
  const parsed = new URL(url, "http://fixture.invalid")
  assert.equal(parsed.pathname, route("listingIntents"))
  assert.equal(parsed.searchParams.get("storeId"), "s1")
  assert.equal(parsed.searchParams.get("limit"), "100")
  assert.equal(parsed.searchParams.get("latestPerRow"), "true")
  assert.deepEqual([...parsed.searchParams.keys()].sort(), ["intentIds", "latestPerRow", "limit", "storeId"])
  const ids = parsed.searchParams.get("intentIds")!.split(",")
  assert.ok(ids.length <= 100); return ids
}

test("200 known pending locks can be reconciled in two explicit 100-row choices without paging, submitting, or changing unselected locks", async () => {
  const h = await pendingHarness()
  const batches: string[][] = []
  const before = h.rows.cardState()!.publish!
  const mock = serve(({ url, method }) => {
    assert.equal(method, "GET")
    const ids = selected(url); batches.push(ids)
    return { items: ids.map((id) => ({ ...h.intents.get(id)!, state: "accepted", externalTaskId: "42" })) }
  })
  try {
    const first = await h.queue.reconcile({ platform: "ozon", destination: "s1", blockId: before.blocks[0]!.id })
    assert.equal(first.status, "read"); assert.equal(first.mode, "identities"); assert.equal(first.appliedRowIds.length, 100)
    assert.equal(mock.calls.length, 1)
    const halfway = h.rows.cardState()!.publish!
    assert.deepEqual(halfway.locks.filter((lock) => Number(lock.rowId.slice(1)) >= 100), before.locks.filter((lock) => Number(lock.rowId.slice(1)) >= 100))
    assert.ok(h.rows.all().slice(100).every((row) => row.submission?.state === "queued"))
    const second = await h.queue.reconcile({ platform: "ozon", destination: "s1", rowIds: h.rows.all().slice(100).map((row) => row.id) })
    assert.equal(second.appliedRowIds.length, 100); assert.equal(mock.calls.length, 2)
    assert.deepEqual(batches, [Array.from({ length: 100 }, (_, i) => `i-r${i}`), Array.from({ length: 100 }, (_, i) => `i-r${i + 100}`)])
    assert.equal(h.queue.snapshot().counts.accepted, 200)
    assert.deepEqual(h.rows.cardState()!.publish!.blocks, before.blocks)
    assert.equal(h.rows.cardState()!.publish!.actionId, before.actionId)
    assert.ok(h.rows.cardState()!.publish!.locks.every((lock) => lock.state === "accepted"))
    assert.doesNotMatch(JSON.stringify(second), /submissionIssues|updatedAtMs|currentIssueStatus|"receipt"/)
  } finally { mock.restore(); await h.rows.close() }
})

test("invalid, duplicate, foreign and mixed-identity selections perform zero history requests and leave every lock intact", async () => {
  const h = await pendingHarness(2)
  const before = h.rows.cardState()!.publish!
  const mock = serve(() => { throw new Error("selection must not reach transport") })
  try {
    for (const rowIds of [[], ["r0", "r0"], [" r0"], ["missing"], Array.from({ length: 101 }, (_, i) => `r${i}`)]) {
      assert.equal((await h.queue.reconcile({ platform: "ozon", destination: "s1", rowIds })).status, "invalid_selection")
    }
    assert.equal((await h.queue.reconcile({ platform: "ozon", destination: "other", rowIds: ["r0"] })).status, "invalid_selection")
    assert.equal((await h.queue.reconcile({ platform: "foreign", destination: "s1", rowIds: ["r0"] })).status, "invalid_selection")
    h.rows.update("r1", (row) => ({ ...row, submission: { ...row.submission!, intentId: undefined, clientOperationId: undefined, serverRevision: undefined } }))
    h.rows.updateCardState((state) => ({ ...state!, publish: { ...state!.publish!, locks: state!.publish!.locks.map((lock) => lock.rowId === "r1" ? { ...lock, intentId: undefined, serverOperationId: undefined } : lock) } }))
    const refreshed = createSendQueue(h.options)
    assert.equal((await refreshed.reconcile({ platform: "ozon", destination: "s1", rowIds: ["r0", "r1"] })).status, "mixed_identity")
    assert.equal(mock.calls.length, 0)
    assert.deepEqual(h.rows.cardState()!.publish!.blocks, before.blocks)
    assert.equal(h.rows.cardState()!.publish!.locks.length, 2)
  } finally { mock.restore(); await h.rows.close() }
})

for (const change of ["error", "missing", "identity", "server-revision", "truncated", "local-revision", "local-identity", "scope", "stop", "cancelled", "store", "read-only"] as const) test(`reconciliation ${change} retains uncertainty, locks and credits with zero submit/release`, async () => {
  const h = await pendingHarness(2)
  let current = true, started!: () => void, respond!: () => void
  const seen = new Promise<void>((resolve) => { started = resolve })
  const gate = new Promise<void>((resolve) => { respond = resolve })
  const queue = createSendQueue({ ...h.options, current: () => current })
  const before = h.rows.cardState()!.publish!
  const beforeRows = structuredClone(h.rows.all())
  const mock = serve(async ({ url, method }) => {
    assert.equal(method, "GET"); const ids = selected(url); started(); await gate
    if (change === "error") throw new TypeError("mock read failed")
    const items = change === "missing" ? [] : ids.map((id) => ({ ...h.intents.get(id)!, state: "accepted", external_task_id: "42",
      ...(change === "identity" ? { client_operation_id: "different-operation" } : {}), ...(change === "server-revision" ? { row_revision: 10 } : {}) }))
    return { items, next_cursor: change === "truncated" ? "more" : null }
  })
  try {
    const read = queue.reconcile({ platform: "ozon", destination: "s1", rowIds: ["r0"] }); await seen
    if (change === "local-revision") h.rows.update("r0", (row) => ({ ...row, row: nativePayload("changed") }))
    if (change === "local-identity") h.rows.update("r0", (row) => ({ ...row, submission: { ...row.submission!, clientOperationId: "new-server-operation" } }))
    if (change === "cancelled") h.rows.update("r0", (row) => ({ ...row, submission: { ...row.submission!, state: "cancelled" } }))
    if (change === "store") h.rows.update("r0", (row) => ({ ...row, storeId: "other" }))
    if (change === "scope") current = false
    if (change === "read-only") await h.rows.close()
    if (change === "stop") queue.stop()
    assert.equal((await queue.reconcile({ platform: "ozon", destination: "s1", rowIds: ["r1"] })).status, "busy")
    await queue.retry(before.blocks[0]!.id); await queue.continue()
    respond()
    if (change === "error") await assert.rejects(read)
    else {
      const result = await read
      assert.deepEqual(result.appliedRowIds, [])
      if (change === "stop") {
        assert.equal(result.status, "stale")
        assert.equal(result.platform, "ozon"); assert.equal(result.destination, "s1")
        assert.deepEqual(result.rowIds, ["r0"])
        assert.deepEqual(h.rows.all(), beforeRows)
        assert.deepEqual(h.rows.cardState()!.publish, before)
        assert.deepEqual((await h.repo.cardState(h.scope.workspaceUuid, h.scope.cardId))!.publish, before)
      }
    }
    assert.equal(mock.calls.length, 1)
    assert.equal(mock.calls.filter((call) => call.url === route("listingSubmit")).length, 0)
    assert.equal(mock.calls.filter((call) => call.url === route("listingIntentsReleaseUnknown")).length, 0)
    assert.deepEqual(h.rows.cardState()!.publish!.locks, before.locks)
    assert.deepEqual(h.rows.cardState()!.publish!.blocks, before.blocks)
    assert.notEqual(h.rows.get("r0")?.submission?.state, "accepted")
    assert.equal(h.rows.get("r1")?.submission?.state, "queued")
  } finally { respond(); mock.restore(); await h.rows.close() }
})

test("selection and identities are captured before await; changing the caller's array cannot select a second row", async () => {
  const h = await pendingHarness(2)
  const ids = ["r0"]
  const mock = serve(async ({ url }) => {
    const selectedIds = selected(url); ids[0] = "r1"
    await Promise.resolve()
    return { items: selectedIds.map((id) => ({ ...h.intents.get(id)!, state: "accepted", externalTaskId: "42" })) }
  })
  try {
    const result = await h.queue.reconcile({ platform: "ozon", destination: "s1", rowIds: ids })
    assert.deepEqual(result.rowIds, ["r0"]); assert.deepEqual(result.appliedRowIds, ["r0"])
    assert.equal(mock.calls.length, 1)
    assert.equal(h.rows.get("r1")?.submission?.state, "queued")
    assert.equal(h.rows.cardState()!.publish!.locks.find((lock) => lock.rowId === "r1")!.state, "unknown")
  } finally { mock.restore(); await h.rows.close() }
})
