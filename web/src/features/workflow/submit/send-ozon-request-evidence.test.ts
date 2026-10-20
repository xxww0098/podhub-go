import assert from "node:assert/strict"
import test from "node:test"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"
import type { RequestEvidence } from "@/api/client-options"
import { cachedListingRow } from "@/bindings/listing-row-cache"
import type { FrozenItem } from "../platforms/core"
import type { OzonBody } from "../platforms/ozon"
import { submitOzonChunk, type OzonSendContext } from "./send-ozon-transport"

const endpoint = route("listingSubmit")
const ids = ["w8-row-a", "w8-row-b"]
const items: FrozenItem<OzonBody>[] = ids.map((key) => ({
  key, body: { rowId: key, storeId: "fixture-store", offerId: key, import: { name: "local preview never sent" },
    evidence: { digest: "preview", card_defaults_digest: "fixture-defaults", sources: [] } },
  digest: "preview", clientOperationId: `local-${key}`, provenance: [],
}))

function context(onRequestEvidence?: (evidence: RequestEvidence) => void): OzonSendContext {
  return { storeId: "fixture-store", pins: new Map(ids.map((id, i) => [id, { revision: i + 1 }])),
    shouldStop: () => false, results: new Map(), syncRequired: false, replayed: false, onRequestEvidence }
}

for (const observerThrows of [false, true]) {
  test(`legacy batch ${observerThrows ? "throwing" : "normal"} observer preserves actual row pins and mixed authority settlement`, async () => {
    const original = globalThis.fetch
    const observed: RequestEvidence[] = [], calls: string[] = []
    const receipt: components["schemas"]["ListingSubmissionReceipt"] = {
      batch_id: "server-batch", task_id: 42, item_count: 1, http_status: 200, response_body: "private receipt response", received_at_ms: 1,
    }
    const accepted: components["schemas"]["ListingIntentView"] = {
      id: "server-intent", listing_row_id: ids[0]!, store_id: "fixture-store", row_revision: 1, client_operation_id: "server-operation",
      state: "accepted", can_resume: false, current_issue_status: "absent", submission_issues: [],
      external_task_id: "42", submission_receipt_status: "valid", submission_receipt: receipt, updated_at_ms: 1,
    }
    const data: components["schemas"]["SubmitListingBatchData"] = { items: [
      { row_id: ids[0]!, created: true, intent: accepted },
      { row_id: ids[1]!, created: false, skipped: "waiting", intent: { ...accepted, id: "pending-intent", listing_row_id: ids[1]!, row_revision: 2,
        state: "queued", external_task_id: null, submission_receipt_status: "absent", submission_receipt: null } },
    ] }
    let actual: string | undefined
    const sizesAtObservation: number[] = []
    const sending = context((evidence) => {
      sizesAtObservation.push(sending.results.size)
      observed.push(evidence)
      if (observerThrows) throw new Error("fixture observer failed after observing accepted response")
    })
    globalThis.fetch = async (input, init) => {
      calls.push(String(input))
      assert.equal(String(input), endpoint, "no diagnostic delivery or Cloud row reads")
      assert.equal(init?.method, "POST")
      assert.equal(typeof init?.body, "string")
      actual = String(init?.body)
      return Response.json({ data }, { headers: { "x-request-id": "batch-http-trace" } })
    }
    try {
      await submitOzonChunk(sending, items)
      assert.equal(actual, JSON.stringify({ storeId: "fixture-store", row_ids: ids }))
      assert.deepEqual(observed, [{ jsonText: actual, traceId: "batch-http-trace" }])
      assert.deepEqual(sizesAtObservation, [0], "HTTP evidence precedes row projection")
      assert.doesNotMatch(observed[0]!.jsonText!, /preview|private receipt|server-intent/)
      assert.equal(Object.isFrozen(observed[0]), true)
      const first = sending.results.get(ids[0]!)!, second = sending.results.get(ids[1]!)!
      assert.equal(first.outcome, "start")
      assert.equal(first.job_id, accepted.id)
      assert.equal(first.taskId, "42")
      assert.deepEqual(first.submissionReceipt, receipt)
      assert.equal(second.outcome, "noop")
      assert.equal(second.noop_reason, "waiting")
      assert.equal(second.taskId, undefined)
      assert.equal(second.submissionReceipt, undefined)
      assert.equal(Object.hasOwn(first, "requestEvidence"), false)
      assert.deepEqual(calls, [endpoint])
      // Responses deliberately contain no Cloud rows: the real resident cache stays untouched.
      assert.equal(cachedListingRow(ids[0]!), undefined)
      assert.equal(cachedListingRow(ids[1]!), undefined)
    } finally { globalThis.fetch = original }
  })
}

test("legacy HTTP refusal evidence remains request-scoped and observer failure cannot change blocked authority", async () => {
  const original = globalThis.fetch
  const observed: RequestEvidence[] = []
  let calls = 0
  const sending = context((evidence) => { observed.push(evidence); throw new Error("fixture observer failed") })
  globalThis.fetch = async (input) => {
    calls++
    assert.equal(String(input), endpoint)
    return Response.json({ code: "offer_busy", message: "response text is not request evidence" },
      { status: 409, headers: { "x-request-id": "refusal-trace" } })
  }
  try {
    await submitOzonChunk(sending, items)
    assert.equal(calls, 1)
    assert.equal(observed.length, 1)
    assert.equal(observed[0]!.traceId, "refusal-trace")
    assert.doesNotMatch(observed[0]!.jsonText!, /response text/)
    for (const id of ids) {
      const result = sending.results.get(id)!
      assert.equal(result.outcome, "blocked")
      assert.equal(result.error!.code, "cloud_offer_busy")
      assert.deepEqual(result.error!.requestCause, { kind: "request_refusal", scope: "request", storeId: "fixture-store",
        rowIds: ids, status: 409, serverCode: "offer_busy", traceId: "refusal-trace", admission: "offer_busy" })
      assert.equal(result.submissionReceipt, undefined)
    }
  } finally { globalThis.fetch = original }
})

test("legacy network failure emits one attempted body and keeps every dispatched row unconfirmed", async () => {
  const original = globalThis.fetch
  const observed: RequestEvidence[] = []
  let calls = 0, actual: string | undefined
  globalThis.fetch = async (input, init) => {
    calls++
    assert.equal(String(input), endpoint)
    actual = String(init?.body)
    throw new TypeError("fixture disconnected")
  }
  const sending = context((evidence) => observed.push(evidence))
  try {
    await submitOzonChunk(sending, items)
    assert.deepEqual(observed, [{ jsonText: actual, traceId: null }])
    assert.equal(calls, 1)
    for (const id of ids) {
      const result = sending.results.get(id)!
      assert.equal(result.outcome, "unknown")
      assert.equal(result.noop_reason, "result_unconfirmed")
      assert.equal(result.error!.requestCause!.kind, "result_unconfirmed")
      assert.equal(result.submissionReceipt, undefined)
    }
  } finally { globalThis.fetch = original }
})

test("legacy schema-sync replay observes each actual request independently with the actual replay subset", async () => {
  const original = globalThis.fetch
  const observed: RequestEvidence[] = [], actual: string[] = []
  let calls = 0
  globalThis.fetch = async (input, init) => {
    calls++
    assert.equal(String(input), endpoint)
    actual.push(String(init?.body))
    return calls === 1
      ? Response.json({ code: "schema_sync_required", message: "fixture schema cold" }, { status: 409, headers: { "x-request-id": "first-trace" } })
      : Response.json({ data: { items: [{ row_id: ids[1], created: false, skipped: "blocked" }] } }, { headers: { "x-request-id": "replay-trace" } })
  }
  const sending = context((evidence) => observed.push(evidence))
  try {
    await submitOzonChunk(sending, items)
    assert.equal(sending.syncRequired, true)
    assert.equal(sending.results.size, 0)
    assert.equal(calls, 1, "schema refusal does not trigger an automatic request here")
    sending.replayed = true
    sending.syncRequired = false
    await submitOzonChunk(sending, [items[1]!])
    assert.deepEqual(observed, [{ jsonText: actual[0], traceId: "first-trace" }, { jsonText: actual[1], traceId: "replay-trace" }])
    assert.notEqual(observed[0], observed[1])
    assert.notEqual(actual[0], actual[1])
    assert.deepEqual(JSON.parse(actual[1]!), { storeId: "fixture-store", row_ids: [ids[1]] })
    assert.equal(sending.results.get(ids[1]!)!.outcome, "blocked")
    assert.equal(calls, 2, "only the explicit caller replay sends again")
  } finally { globalThis.fetch = original }
})

test("legacy Stop before admission produces no request and no submitted evidence", async () => {
  const original = globalThis.fetch
  const observed: RequestEvidence[] = []
  let calls = 0
  const sending = context((evidence) => observed.push(evidence))
  sending.shouldStop = () => true
  globalThis.fetch = async () => { calls++; throw new Error("Stop must close admission") }
  try {
    await submitOzonChunk(sending, items)
    assert.equal(calls, 0)
    assert.deepEqual(observed, [])
    for (const id of ids) assert.equal(sending.results.get(id)!.noop_reason, "cancelled")
  } finally { globalThis.fetch = original }
})

test("legacy in-flight Stop leaves the dispatched signal alive and observes evidence only at body settlement", async () => {
  const original = globalThis.fetch
  const observed: RequestEvidence[] = []
  let reading!: () => void, release!: () => void, signal: AbortSignal | undefined, calls = 0, stopped = false
  const started = new Promise<void>((resolve) => { reading = resolve })
  const held = new Promise<void>((resolve) => { release = resolve })
  const sending = context((evidence) => observed.push(evidence))
  sending.shouldStop = () => stopped
  globalThis.fetch = async (input, init) => {
    calls++
    assert.equal(String(input), endpoint)
    signal = init?.signal ?? undefined
    const response = Response.json({ data: { items: ids.map((rowId) => ({ row_id: rowId, created: false, skipped: "waiting" })) } },
      { headers: { "x-request-id": "stopped-body-trace" } })
    const text = response.text.bind(response)
    response.text = async () => { reading(); await held; return text() }
    return response
  }
  try {
    const pending = submitOzonChunk(sending, items)
    await started
    assert.equal(observed.length, 0)
    stopped = true
    assert.ok(signal)
    assert.equal(signal.aborted, false)
    assert.equal(sending.results.size, 0)
    release()
    await pending
    assert.equal(observed.length, 1)
    assert.equal(observed[0]!.traceId, "stopped-body-trace")
    assert.equal(signal.aborted, false)
    assert.equal(calls, 1)
    for (const id of ids) assert.equal(sending.results.get(id)!.noop_reason, "waiting")
  } finally { release(); globalThis.fetch = original }
})
