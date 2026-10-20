import assert from "node:assert/strict"
import test from "node:test"
import type { ListingIntent } from "@/bindings/http-listing-intents"
import { route } from "@/api/routes"
import { createSendQueue } from "../submit/send-queue"
import { finalQueueHarness, golden, goldenSchema, nativePayload, serve, wasmCore } from "../submit/send-test-support"
import { createOzonSendCapability } from "./ozon"

async function fixture() {
  const h = await finalQueueHarness(1, "actual-store")
  h.rows.update("r0", (row) => ({ ...row, row: nativePayload(row.id) }))
  const core = await wasmCore(), handle = core.loadSchema({ snapshot: goldenSchema })
  const capability = createOzonSendCapability({ core, schemaHandle: () => handle, card: () => golden.card, cardId: h.scope.cardId })
  const queue = createSendQueue({ rows: h.rows, ...h.scope, current: () => true, capabilities: { ozon: capability } })
  const intent: ListingIntent = { id: "i-r0", listing_row_id: "r0", store_id: "actual-store", row_revision: 9, client_operation_id: "server-r0",
    state: "accepted", external_task_id: "42", can_resume: false, current_issue_status: "absent", submission_issues: [], submission_receipt_status: "absent", updated_at_ms: 1 }
  return { ...h, capability, queue, intent, selection: { platform: "ozon", destination: "actual-store", rowIds: ["r0"] } }
}
function query(url: string, key: "rowIds" | "intentIds") {
  const parsed = new URL(url, "http://fixture.invalid")
  assert.equal(parsed.pathname, route("listingIntents"))
  assert.deepEqual([...parsed.searchParams.keys()].sort(), [key, "latestPerRow", "limit", "storeId"].sort())
  assert.equal(parsed.searchParams.get("storeId"), "actual-store")
  assert.equal(parsed.searchParams.get("limit"), "100"); assert.equal(parsed.searchParams.get("latestPerRow"), "true")
  assert.equal(parsed.searchParams.get(key), key === "rowIds" ? "r0" : "i-r0")
}

for (const history of ["post-commit-loss", "pre-server-empty", "old", "multiple", "truncated", "queued", "submitting", "superseded"] as const) test(`wholly lost Ozon response: ${history} returns manual history through the final queue, never invents authority or releases/resends`, async () => {
  const h = await fixture()
  let submits = 0
  const mock = serve(({ url, method }) => {
    if (method === "POST") {
      assert.equal(url, route("listingSubmit")); submits++
      throw new TypeError(history === "pre-server-empty" ? "failed before server" : "response lost after commit")
    }
    query(url, "rowIds")
    const candidate = { ...h.intent, ...(history === "old" ? { client_operation_id: "old-operation", row_revision: 1, updated_at_ms: 0 } : {}),
      ...(["queued", "submitting", "superseded"].includes(history) ? { state: history } : {}) }
    return { items: history === "pre-server-empty" ? [] : history === "multiple" ? [candidate, { ...candidate, id: "second", client_operation_id: "different-operation" }] : [candidate],
      next_cursor: history === "truncated" ? "more" : null }
  })
  try {
    await h.queue.start([h.selection])
    assert.equal(h.rows.get("r0")?.submission?.intentId, undefined)
    const before = h.rows.cardState()!.publish!, rowBefore = structuredClone(h.rows.get("r0"))
    const result = await h.queue.reconcile(h.selection)
    assert.equal(result.status, "read"); assert.equal(result.mode, "history")
    assert.equal(result.complete, history !== "truncated")
    assert.deepEqual(result.appliedRowIds, [])
    assert.equal(result.rows[0]!.candidates.length, history === "pre-server-empty" ? 0 : history === "multiple" ? 2 : 1)
    assert.equal(result.rows[0]!.fact, undefined)
    if (history === "old") assert.equal(result.rows[0]!.candidates[0]!.serverOperationId, "old-operation")
    assert.deepEqual(h.rows.get("r0"), rowBefore)
    assert.deepEqual(h.rows.cardState()!.publish!.locks, before.locks)
    await h.queue.releaseUnknown("ozon", "actual-store", ["i-r0"])
    await h.queue.retry(before.blocks[0]!.id); await h.queue.continue()
    assert.equal(submits, 1); assert.equal(mock.calls.length, 2)
    assert.equal(h.queue.snapshot().counts.unknown, 1)
    assert.doesNotMatch(JSON.stringify(result), /submissionIssues|currentIssueStatus|updatedAtMs|"receipt"/)
  } finally { mock.restore(); await h.rows.close() }
})

for (const read of ["accepted", "queued", "submitting", "superseded", "operation-mismatch", "revision-mismatch", "row-mismatch", "foreign-store", "foreign-id", "truncated", "empty"] as const) test(`captured Ozon identity ${read}: exactly one bounded identity read, and only exact authority can advance the pinned row`, async () => {
  const h = await fixture()
  const mock = serve(({ url, method }) => {
    if (method === "POST") {
      assert.equal(url, route("listingSubmit"))
      return { server_schema_revision: goldenSchema.schema_revision, items: [{ row_id: "r0", outcome: "created", intent: { ...h.intent, state: "outcome_unknown", external_task_id: null } }] }
    }
    query(url, "intentIds")
    const intent = { ...h.intent,
      ...(["queued", "submitting", "superseded"].includes(read) ? { state: read } : {}),
      ...(read === "operation-mismatch" ? { client_operation_id: "other" } : {}), ...(read === "revision-mismatch" ? { row_revision: 10 } : {}),
      ...(read === "row-mismatch" ? { listing_row_id: "other" } : {}), ...(read === "foreign-store" ? { store_id: "foreign" } : {}),
      ...(read === "foreign-id" ? { id: "foreign" } : {}) }
    return { items: read === "empty" ? [] : [intent], next_cursor: read === "truncated" ? "more" : null }
  })
  try {
    await h.queue.start([h.selection])
    const before = h.rows.cardState()!.publish!
    const reading = h.queue.reconcile(h.selection)
    if (read === "foreign-store" || read === "foreign-id") await assert.rejects(reading)
    else {
      const result = await reading
      assert.equal(result.mode, "identities")
      assert.deepEqual(result.appliedRowIds, ["accepted", "queued", "submitting"].includes(read) ? ["r0"] : [])
    }
    assert.equal(mock.calls.length, 2)
    assert.equal(mock.calls.filter((call) => call.method === "POST").length, 1)
    assert.equal(h.rows.get("r0")?.submission?.state, read === "accepted" ? "accepted" : read === "queued" || read === "submitting" ? "queued" : "unconfirmed")
    assert.equal(h.rows.cardState()!.publish!.locks.length, 1, "pending/accepted locks are retained; history is never a release")
    assert.deepEqual(h.rows.cardState()!.publish!.blocks.map((block) => block.budget), before.blocks.map((block) => block.budget))
  } finally { mock.restore(); await h.rows.close() }
})

test("real Ozon read capability rejects an invalid or mixed batch before any HTTP call", async () => {
  const h = await fixture()
  const pin = { rowId: "r0", revision: 1 }, known = { ...pin, rowId: "r1", identity: { intentId: "i-r1", serverOperationId: "server-r1", serverRevision: 0 } }
  const mock = serve(() => { throw new Error("invalid batch reached HTTP") })
  try {
    for (const pins of [[], [pin, pin], Array.from({ length: 101 }, (_, i) => ({ ...pin, rowId: `r${i}` })), [pin, known]]) {
      await assert.rejects(h.capability.reconcile!("actual-store", pins, new AbortController().signal))
    }
    assert.equal(mock.calls.length, 0)
  } finally { mock.restore(); await h.rows.close() }
})
