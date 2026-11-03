import assert from "node:assert/strict"
import test from "node:test"
import { route } from "@/api/routes"
import { readRecentSubmissions } from "./recent-submissions-read"
import { filterRecentSubmissions, submissionStatus } from "./recent-submissions"
import type { RecentSubmission } from "./recent-submissions-read"
import type { OzonStoreView } from "@/bindings/commands"

const intent = (id: string) => ({
  id, listing_row_id: `row-${id}`, store_id: "store-1", client_operation_id: `op-${id}`,
  row_revision: 1, state: "queued", current_issue_status: "absent", submission_receipt_status: "absent",
  can_resume: false, submission_issues: [], updated_at_ms: 100,
})
const row = (id: string) => ({ id: `row-${id}`, card_id: `card-${id}`, draft: { values: {}, complex_values: [] } })

test("an empty recent submission page does not request rows", async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async (input) => {
    calls++
    assert.equal(String(input), `${route("listingIntents")}?limit=5&latestPerRow=true`)
    return Response.json({ data: { items: [], next_cursor: null } })
  }) as typeof fetch
  try {
    assert.deepEqual(await readRecentSubmissions(new AbortController().signal), [])
    assert.equal(calls, 1)
  } finally { globalThis.fetch = original }
})

test("recent submissions keep server order and show a row failure independently", async () => {
  const original = globalThis.fetch
  let finishFirst!: (response: Response) => void
  globalThis.fetch = (async (input) => {
    const path = String(input)
    if (path.startsWith(route("listingIntents"))) return Response.json({ data: { items: [intent("1"), intent("2")], next_cursor: null } })
    if (path === route("listingRowsById", { id: "row-1" })) return new Promise<Response>((resolve) => { finishFirst = resolve })
    if (path === route("listingRowsById", { id: "row-2" })) return Response.json({ error: "读取失败" }, { status: 503 })
    throw new Error(`unexpected request: ${path}`)
  }) as typeof fetch
  try {
    const pending = readRecentSubmissions(new AbortController().signal)
    for (let i = 0; i < 20 && !finishFirst; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0))
    assert.ok(finishFirst)
    finishFirst(Response.json({ data: row("1") }))
    const result = await pending
    assert.deepEqual(result.map((entry) => entry.intent.id), ["1", "2"])
    assert.equal(result[0]?.row?.card_id, "card-1")
    assert.equal(result[1]?.row, undefined)
  } finally { globalThis.fetch = original }
})

test("aborting a previous workspace read discards a late response", async () => {
  const original = globalThis.fetch
  let finishOld!: (response: Response) => void
  let calls = 0
  globalThis.fetch = (async (input) => {
    assert.ok(String(input).startsWith(route("listingIntents")))
    calls++
    if (calls === 1) return new Promise<Response>((resolve) => { finishOld = resolve })
    return Response.json({ data: { items: [], next_cursor: null } })
  }) as typeof fetch
  try {
    const old = new AbortController()
    const pending = readRecentSubmissions(old.signal)
    assert.ok(finishOld)
    old.abort()
    assert.deepEqual(await readRecentSubmissions(new AbortController().signal), [])
    finishOld(Response.json({ data: { items: [intent("old")], next_cursor: null } }))
    await assert.rejects(pending)
    assert.equal(calls, 2, "a stale response must not start row reads")
  } finally { globalThis.fetch = original }
})

test("accepted and unknown states are never presented as on sale", () => {
  assert.deepEqual(submissionStatus({ state: "accepted", current_issue_status: "absent" }), { label: "平台受理", group: "accepted" })
  assert.deepEqual(submissionStatus({ state: "accepted", current_issue_status: "present" }), { label: "受理后需核对", group: "attention" })
  assert.deepEqual(submissionStatus({ state: "accepted", current_issue_status: "undeterminable" }), { label: "受理后需核对", group: "attention" })
  assert.deepEqual(submissionStatus({ state: "unknown", current_issue_status: "absent" }), { label: "结果未知", group: "attention" })
  assert.deepEqual(submissionStatus({ state: "future_state", current_issue_status: "absent" }), { label: "未知状态", group: "attention" })
})

test("recent task search and store filter only select matching submissions", () => {
  const items = [
    { intent: intent("1"), row: { ...row("1"), draft: { values: { name: { kind: "text", value: "帆布包" }, offer_id: { kind: "text", value: "SKU-ONE" } }, complex_values: [] } } },
    { intent: { ...intent("2"), store_id: "store-2" }, row: row("2") },
  ] as unknown as RecentSubmission[]
  const stores = [{ id: "store-1", label: "主店" }, { id: "store-2", label: "二店" }] as OzonStoreView[]
  assert.deepEqual(filterRecentSubmissions(items, stores, "store-1", "sku-one").map((item) => item.intent.id), ["1"])
  assert.deepEqual(filterRecentSubmissions(items, stores, "store-2", "帆布").map((item) => item.intent.id), [])
  assert.deepEqual(filterRecentSubmissions(items, stores, "", "二店").map((item) => item.intent.id), ["2"])
})
