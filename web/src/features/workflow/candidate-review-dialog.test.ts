import { route } from "@/api/routes"
import assert from "node:assert/strict"
import test from "node:test"
import type { ListingRowView } from "@/bindings/listing-projection"
import { candidateCurrentText, decideListingCandidate, pendingCandidates, readCandidateReviewRow } from "./candidate-review-dialog"

function snapshot(): ListingRowView {
  return {
    id: "row/id", revision: 12,
    ai: { candidates: [
      { address: { kind: "plain", field_key: "name" }, value: { kind: "text", value: "one" }, source: "ai", state: "confirmed" },
      { address: { kind: "plain", field_key: "description" }, value: { kind: "text", value: "new" }, current_value: { kind: "text", value: "old" }, source: "ai", state: "proposed" },
      { address: { kind: "plain", field_key: "offer_id" }, value: { kind: "text", value: "no" }, source: "ai", state: "unresolved" },
    ] },
  } as ListingRowView
}

test("review keeps original indices when settled candidates are hidden", () => {
  assert.deepEqual(pendingCandidates(snapshot()).map(({ index, candidate }) => [index, candidate.state]), [[1, "proposed"], [2, "unresolved"]])
})

test("candidate decision sends the displayed revision once and consumes the standard PATCH envelope", async () => {
  const previous = globalThis.fetch
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const reply = { ...snapshot(), revision: 13 }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return new Response(JSON.stringify({ data: reply, issues: [], plan: null }), { headers: { "Content-Type": "application/json" } })
  }) as typeof globalThis.fetch
  try {
    const next = await decideListingCandidate(snapshot(), 1, true)
    assert.equal(next.revision, 13)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.url, route("listingRowsById", { id: "row/id" }))
    assert.equal(calls[0]?.init?.method, "PATCH")
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { baseRevision: 12, candidateDecisions: [{ index: 1, accept: true }] })
  } finally { globalThis.fetch = previous }
})

test("a stale candidate index is refused without reading a new revision or retrying", async () => {
  const previous = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return new Response(JSON.stringify({ code: "conflict", error: "候选已变化" }), { status: 409, headers: { "Content-Type": "application/json" } })
  }) as typeof globalThis.fetch
  try {
    await assert.rejects(decideListingCandidate(snapshot(), 1, false), (error: unknown) => (error as { status?: number }).status === 409)
    assert.equal(calls, 1, "never reinterpret the old index against a fresh list")
  } finally { globalThis.fetch = previous }
})

test("candidate review refreshes missing fields without changing the displayed decision", async () => {
  const previous = globalThis.fetch
  const row = { ...snapshot(), storeId: "store-1", payload: { descriptionCategoryId: 42, typeId: 73, language: "zh_hans" } }
  const bodies: unknown[] = []
  const reads: string[] = []
  globalThis.fetch = async (input, init) => {
    if (init?.method === "PATCH") {
      bodies.push(JSON.parse(String(init.body)))
      return bodies.length === 1
        ? Response.json({ code: "schema_sync_required", error: "目录过期" }, { status: 409 })
        : Response.json({ data: { ...row, revision: 13 } })
    }
    reads.push(String(input))
    return Response.json({ data: { description_category_id: 42, type_id: 73, language: "zh_hans", fetched_at_ms: 1, fields: [] } })
  }
  try {
    const saved = await decideListingCandidate(row, 1, true)
    assert.equal(saved.revision, 13)
    assert.deepEqual(bodies, [
      { baseRevision: 12, candidateDecisions: [{ index: 1, accept: true }] },
      { baseRevision: 12, candidateDecisions: [{ index: 1, accept: true }] },
    ])
    assert.deepEqual(reads, [`${route("catalogSchema")}?descriptionCategoryId=42&typeId=73&language=zh_hans`], "字段读取走平台密钥，不携带店铺")
  } finally { globalThis.fetch = previous }
})


test("review displays current Draft after another decision, including a manual clear", () => {
  const row = snapshot()
  const candidate = pendingCandidates(row)[0]!.candidate
  row.draft = { values: { description: { kind: "text", value: "already accepted" } }, complex_values: [] }
  assert.equal(candidateCurrentText(row, candidate), "already accepted")
  delete row.draft.values.description
  assert.equal(candidateCurrentText(row, candidate), "空值")
})


test("review reads only after this row's pending edit is saved and stops on save failure", async () => {
  const previous = globalThis.fetch
  const events: string[] = []
  globalThis.fetch = (async () => { events.push("read"); return new Response(JSON.stringify({ data: snapshot() }), { headers: { "Content-Type": "application/json" } }) }) as typeof globalThis.fetch
  try {
    let release!: (saved: boolean) => void
    const pending = readCandidateReviewRow("row/id", async (ids) => { assert.deepEqual(ids, ["row/id"]); events.push("save"); return new Promise<boolean>((resolve) => { release = resolve }) })
    assert.deepEqual(events, ["save"])
    release(true)
    await pending
    assert.deepEqual(events, ["save", "read"])
    await assert.rejects(readCandidateReviewRow("row/id", async () => false), /尚未保存/)
    assert.deepEqual(events, ["save", "read"], "failed edits never open review against stale server values")
  } finally { globalThis.fetch = previous }
})
