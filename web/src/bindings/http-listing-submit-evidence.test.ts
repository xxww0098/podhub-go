import assert from "node:assert/strict"
import test from "node:test"
import type { RequestEvidence } from "@/api/client-options"
import { route } from "@/api/routes"
import { submitListingDrafts, type DraftSubmitRequest } from "./http-listing-submit"
import type { ListingIntent } from "./http-listing-intents"

const body: DraftSubmitRequest = { card_id: "fixture-card", store_id: "fixture-store", items: [{ rowId: "r1", schemaRevision: "schema" }] }
const queued: ListingIntent = {
  id: "intent1", listing_row_id: "r1", store_id: "fixture-store", row_revision: 1, client_operation_id: "server-operation",
  state: "queued", can_resume: false, current_issue_status: "absent", submission_issues: [], submission_receipt_status: "absent", updated_at_ms: 1,
}

for (const valid of [true, false]) {
  test(`Draft submit exposes exact HTTP evidence before ${valid ? "validated result" : "2xx contract rejection"}`, async () => {
    const original = globalThis.fetch
    const observed: RequestEvidence[] = [], calls: string[] = [], order: string[] = []
    let actualBody: string | undefined
    const data = { server_schema_revision: "schema", items: [{ row_id: "r1", outcome: "created", intent: valid ? queued : { id: "intent1" } }] }
    globalThis.fetch = async (input, init) => {
      calls.push(String(input))
      assert.equal(String(input), route("listingSubmit"), "no diagnostics, Cloud row reads or retries")
      assert.equal(init?.method, "POST")
      assert.equal(init?.credentials, "include")
      assert.equal(typeof init?.body, "string")
      actualBody = String(init?.body)
      const response = Response.json({ data }, { headers: { "x-request-id": "submit-trace" } })
      const text = response.text.bind(response)
      response.text = async () => { const result = await text(); order.push("body"); return result }
      return response
    }
    try {
      const pending = submitListingDrafts(body, Date.now() + 150_000, (evidence) => { observed.push(evidence); order.push("evidence") })
      if (valid) {
        assert.deepEqual(await pending, data)
        order.push("resolved")
      } else await assert.rejects(pending, (reason: unknown) => {
        assert.ok(reason instanceof Error)
        assert.equal(Reflect.get(reason, "code"), "listing_contract_invalid")
        assert.equal(observed.length, 1, "HTTP success evidence survives later binding validation failure")
        order.push("rejected")
        return true
      })
      assert.equal(actualBody, JSON.stringify(body))
      assert.deepEqual(observed, [{ jsonText: actualBody, traceId: "submit-trace" }])
      assert.equal(Object.isFrozen(observed[0]), true)
      assert.deepEqual(order, ["body", "evidence", valid ? "resolved" : "rejected"])
      assert.deepEqual(calls, [route("listingSubmit")])
    } finally { globalThis.fetch = original }
  })
}

test("Draft local admission failures make zero HTTP calls and emit no submitted evidence", async () => {
  const original = globalThis.fetch
  const observed: RequestEvidence[] = []
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error("local refusal must not fetch") }
  try {
    for (const invalid of [
      { ...body, items: [] }, { ...body, store_id: "" }, { ...body, items: [...body.items, ...body.items] },
    ]) {
      await assert.rejects(submitListingDrafts(invalid, Date.now() + 150_000, (evidence) => observed.push(evidence)), { code: "listing_contract_invalid" })
    }
    await assert.rejects(submitListingDrafts(body, Date.now() - 1, (evidence) => observed.push(evidence)), { code: "listing_contract_invalid" })
    assert.equal(calls, 0)
    assert.deepEqual(observed, [])
  } finally { globalThis.fetch = original }
})

test("Draft observer failure preserves queued authority without granting Seller acceptance or retrying", async () => {
  const original = globalThis.fetch
  let calls = 0, observations = 0
  globalThis.fetch = async (input) => {
    calls++
    assert.equal(String(input), route("listingSubmit"))
    return Response.json({ data: { server_schema_revision: "schema", items: [{ row_id: "r1", outcome: "created", intent: queued }] } })
  }
  try {
    const result = await submitListingDrafts(body, Date.now() + 150_000, () => { observations++; throw new Error("fixture observer failed") })
    assert.equal(result.items[0]!.intent!.state, "queued")
    assert.equal(result.items[0]!.intent!.external_task_id, undefined)
    assert.equal(result.items[0]!.intent!.submission_receipt, undefined)
    assert.equal(calls, 1)
    assert.equal(observations, 1)
    assert.equal(Object.hasOwn(result, "requestEvidence"), false)
    assert.equal(Object.hasOwn(result.items[0]!, "requestEvidence"), false)
  } finally { globalThis.fetch = original }
})

test("Draft evidence adds no serialization beyond the existing byte check and actual request body", async () => {
  const original = globalThis.fetch
  const observed: RequestEvidence[] = []
  let serializations = 0, calls = 0, actual: string | undefined
  const input = Object.assign({ ...body }, { toJSON() {
    serializations++
    return { ...body, cardId: `fixture-card-${serializations}` }
  } })
  globalThis.fetch = async (url, init) => {
    calls++
    assert.equal(String(url), route("listingSubmit"))
    actual = String(init?.body)
    return Response.json({ data: { server_schema_revision: "schema", items: [] } }, { headers: { "x-request-id": "actual-body-trace" } })
  }
  try {
    await submitListingDrafts(input, Date.now() + 150_000, (evidence) => observed.push(evidence))
    assert.equal(serializations, 2, "one existing admission byte check, one API serialization, zero observer copies")
    assert.equal(JSON.parse(actual!).cardId, "fixture-card-2", "the byte-check snapshot is not submitted evidence")
    assert.deepEqual(observed, [{ jsonText: actual, traceId: "actual-body-trace" }])
    assert.equal(calls, 1)
  } finally { globalThis.fetch = original }
})

test("Draft dispatch is after local admission, directly before fetch, and observer failure cannot alter queued authority", async () => {
  const before = globalThis.fetch
  const order: string[] = []
  globalThis.fetch = async () => {
    order.push("fetch")
    return Response.json({ data: { server_schema_revision: "schema", items: [{ row_id: "r1", outcome: "created", intent: queued }] } })
  }
  try {
    const dispatch = () => { order.push("dispatch"); throw new Error("observer only") }
    await assert.rejects(submitListingDrafts({ ...body, items: [] }, Date.now() + 150_000, undefined, dispatch))
    assert.equal(order.length, 0, "local admission opens no window and fetches nothing")
    const result = await submitListingDrafts(body, Date.now() + 150_000, () => order.push("evidence"), dispatch)
    assert.equal(result.items[0]?.intent?.state, "queued")
    assert.deepEqual(order, ["dispatch", "fetch", "evidence"])
  } finally { globalThis.fetch = before }
})
