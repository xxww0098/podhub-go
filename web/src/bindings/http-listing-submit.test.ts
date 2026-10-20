import assert from "node:assert/strict"
import test from "node:test"
import { submitListingDrafts, draftAdmissionRefusal } from "./http-listing-submit"

const body = { card_id: "c1", store_id: "s1", items: [{ rowId: "r1", schemaRevision: "schema" }] }

test("only exact G1 admission status/code pairs are safe; no automatic retry", async () => {
  const original = globalThis.fetch
  try {
    for (const code of ["store_busy", "store_unavailable", "submit_capacity_full", "offer_busy"]) {
      let calls = 0
      globalThis.fetch = async () => { calls++; return Response.json({ code, message: "refused" }, { status: 409 }) }
      const failure = await submitListingDrafts(body).catch((error: unknown) => error)
      assert.equal(draftAdmissionRefusal(failure), code)
      assert.equal(calls, 1)
    }
    for (const [status, code] of [[500, "offer_busy"], [409, "future_code"], [409, 12], [409, " OFFER_BUSY "]] as const) {
      globalThis.fetch = async () => Response.json({ code }, { status })
      const failure = await submitListingDrafts(body).catch((error: unknown) => error)
      assert.equal(draftAdmissionRefusal(failure), undefined)
    }
  } finally { globalThis.fetch = original }
})

test("missing items stay missing; bad outcome, future skip and malformed Intent reject", async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = async () => Response.json({ data: { server_schema_revision: "s", items: [] } })
    assert.deepEqual((await submitListingDrafts(body)).items, [])
    for (const item of [
      { row_id: "r1", outcome: "skipped", skip_reason: "future" },
      { row_id: "r1", outcome: "created", intent: { id: "i1" } },
      { row_id: "r1", outcome: {} },
    ]) {
      globalThis.fetch = async () => Response.json({ data: { server_schema_revision: "s", items: [item] } })
      await assert.rejects(submitListingDrafts(body), { code: "listing_contract_invalid" })
    }
  } finally { globalThis.fetch = original }
})

test("future field codes are preserved as local evidence without dropping sibling items", async () => {
  const original = globalThis.fetch
  const issue = { code: "future_field_rule", field_key: "name", address: { kind: "plain", field_key: "name" }, severity: "blocking", message: "server summary", remediation: "server next step", parameters: {} }
  globalThis.fetch = async () => Response.json({ data: { server_schema_revision: "s", items: [
    { row_id: "r1", outcome: "skipped", skip_reason: "blocked", issues: [issue] },
    { row_id: "r2", outcome: "skipped", skip_reason: "media_expired" },
  ] } })
  try {
    const result = await submitListingDrafts({ ...body, items: [...body.items, { rowId: "r2", schemaRevision: "schema" }] })
    assert.equal(result.items.length, 2)
    assert.equal(result.items[0]!.issues![0]!.code, "future_field_rule")
  } finally { globalThis.fetch = original }
})

test("submit keeps its original 150-second deadline through response body consumption", async () => {
  const originalFetch = globalThis.fetch, originalTimer = globalThis.setTimeout, originalNow = Date.now
  const deadlines: number[] = []
  const signals: AbortSignal[] = []
  Date.now = () => 1000
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (ms === 150_000) { deadlines.push(ms); return originalTimer(callback, 1, ...args) }
    return originalTimer(callback, ms, ...args)
  }) as typeof setTimeout
  globalThis.fetch = async (_url, init) => {
    signals.push(init!.signal!)
    return new Response(new ReadableStream({ start(stream) {
      init!.signal!.addEventListener("abort", () => stream.error(new DOMException("deadline", "TimeoutError")), { once: true })
    } }))
  }
  try {
    await assert.rejects(submitListingDrafts(body, 151_000), { code: "cloud_unavailable" })
    assert.deepEqual(deadlines, [150_000])
    assert.equal(signals[0]!.aborted, true)
  } finally { globalThis.fetch = originalFetch; globalThis.setTimeout = originalTimer; Date.now = originalNow }
})
