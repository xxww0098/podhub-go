import assert from "node:assert/strict"
import test from "node:test"
import { route } from "@/api/routes"
import { readRecentSubmissions } from "./recent-submissions-read"
import { filterRecentSubmissions, submissionPrice, submissionStatus } from "./recent-submissions"
import type { RecentSubmission } from "./recent-submissions-read"
import type { OzonStoreView } from "@/bindings/commands"
import type { ListingRowView } from "@/bindings/listing-projection"

const intent = (id: string) => ({
  id, listing_row_id: `row-${id}`, store_id: "store-1", client_operation_id: `op-${id}`,
  row_revision: 1, state: "queued", current_issue_status: "absent", submission_receipt_status: "absent",
  can_resume: false, submission_issues: [], updated_at_ms: 100,
})
const row = (id: string) => ({ id: `row-${id}`, card_id: `card-${id}`, draft: { values: {}, complex_values: [] } })
const review = (overrides: Partial<{ needs_review: number; unknown: number; rejected: number; conflict: number; accepted_issue: number }> = {}) => ({
  needs_review: 0, unknown: 0, rejected: 0, conflict: 0, accepted_issue: 0, ...overrides,
})

test("an empty recent submission page does not request rows", async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async (input) => {
    calls++
    assert.equal(String(input), `${route("listingIntents")}?limit=5&latestPerRow=true&review=true`)
    return Response.json({ data: { items: [], next_cursor: null, review: review() } })
  }) as typeof fetch
  try {
    assert.deepEqual((await readRecentSubmissions(new AbortController().signal)).items, [])
    assert.equal(calls, 1)
  } finally { globalThis.fetch = original }
})

test("the attention filter reads the workspace review queue, not the latest five", async () => {
  const original = globalThis.fetch
  let seen = ""
  globalThis.fetch = (async (input) => {
    const path = String(input)
    if (path.startsWith(route("listingIntents"))) {
      seen = path
      return Response.json({ data: { items: [intent("r")], next_cursor: null, review: review({ needs_review: 1, unknown: 1 }) } })
    }
    return Response.json({ error: "missing" }, { status: 404 })
  }) as typeof fetch
  try {
    const result = await readRecentSubmissions(new AbortController().signal, { needsReview: true })
    assert.equal(seen, `${route("listingIntents")}?limit=5&latestPerRow=true&review=true&needsReview=true`)
    assert.deepEqual(result.items.map((entry) => entry.intent.id), ["r"])
    assert.deepEqual(result.review, review({ needs_review: 1, unknown: 1 }))
  } finally { globalThis.fetch = original }
})

test("an attention entry reads only its own review group", async () => {
  const original = globalThis.fetch
  let seen = ""
  globalThis.fetch = (async (input) => {
    const path = String(input)
    if (path.startsWith(route("listingIntents"))) {
      seen = path
      return Response.json({ data: { items: [], next_cursor: "next-page", review: review({ needs_review: 3, rejected: 2, conflict: 1 }) } })
    }
    return Response.json({ error: "missing" }, { status: 404 })
  }) as typeof fetch
  try {
    const result = await readRecentSubmissions(new AbortController().signal, { reviewKind: "failed" })
    assert.equal(seen, `${route("listingIntents")}?limit=5&latestPerRow=true&review=true&needsReview=true&reviewKind=failed`)
    assert.equal(result.nextCursor, "next-page")
  } finally { globalThis.fetch = original }
})

test("loading more keeps the review group and cursor", async () => {
  const original = globalThis.fetch
  let seen = ""
  globalThis.fetch = (async (input) => {
    const path = String(input)
    if (path.startsWith(route("listingIntents"))) {
      seen = path
      return Response.json({ data: { items: [], next_cursor: null, review: review() } })
    }
    return Response.json({ error: "missing" }, { status: 404 })
  }) as typeof fetch
  try {
    const result = await readRecentSubmissions(new AbortController().signal, { reviewKind: "unknown", cursor: "page-2" })
    assert.equal(seen, `${route("listingIntents")}?limit=5&latestPerRow=true&review=true&needsReview=true&reviewKind=unknown&cursor=page-2`)
    assert.equal(result.nextCursor, undefined)
  } finally { globalThis.fetch = original }
})

test("a page without workspace review counts is rejected", async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () => Response.json({ data: { items: [], next_cursor: null } })) as typeof fetch
  try {
    await assert.rejects(readRecentSubmissions(new AbortController().signal), /上架提交响应格式无效/)
  } finally { globalThis.fetch = original }
})

test("recent submissions keep server order and show a row failure independently", async () => {
  const original = globalThis.fetch
  let finishFirst!: (response: Response) => void
  globalThis.fetch = (async (input) => {
    const path = String(input)
    if (path.startsWith(route("listingIntents"))) return Response.json({ data: { items: [intent("1"), intent("2")], next_cursor: null, review: review({ needs_review: 1, rejected: 1 }) } })
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
    assert.deepEqual(result.items.map((entry) => entry.intent.id), ["1", "2"])
    assert.equal(result.items[0]?.row?.card_id, "card-1")
    assert.equal(result.items[1]?.row, undefined)
    assert.deepEqual(result.review, review({ needs_review: 1, rejected: 1 }))
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
    return Response.json({ data: { items: [], next_cursor: null, review: review() } })
  }) as typeof fetch
  try {
    const old = new AbortController()
    const pending = readRecentSubmissions(old.signal)
    assert.ok(finishOld)
    old.abort()
    assert.deepEqual((await readRecentSubmissions(new AbortController().signal)).items, [])
    finishOld(Response.json({ data: { items: [intent("old")], next_cursor: null } }))
    await assert.rejects(pending)
    assert.equal(calls, 2, "a stale response must not start row reads")
  } finally { globalThis.fetch = original }
})

test("accepted and unknown states are never presented as on sale", () => {
  assert.deepEqual(submissionStatus({ state: "accepted", current_issue_status: "absent" }), { label: "平台受理", group: "accepted", tone: "idle" })
  assert.deepEqual(submissionStatus({ state: "accepted", current_issue_status: "present" }), { label: "受理后需核对", group: "attention", tone: "bad" })
  assert.deepEqual(submissionStatus({ state: "accepted", current_issue_status: "undeterminable" }), { label: "受理后需核对", group: "attention", tone: "bad" })
  assert.deepEqual(submissionStatus({ state: "unknown", current_issue_status: "absent" }), { label: "结果未知", group: "attention", tone: "unknown" })
  assert.deepEqual(submissionStatus({ state: "future_state", current_issue_status: "absent" }), { label: "未知状态", group: "attention", tone: "unknown" })
})

test("submission tones follow the ledger vocabulary", () => {
  assert.equal(submissionStatus({ state: "queued", current_issue_status: "absent" }).tone, "flight")
  assert.equal(submissionStatus({ state: "submitting", current_issue_status: "absent" }).tone, "flight")
  assert.equal(submissionStatus({ state: "rejected", current_issue_status: "present" }).tone, "bad")
  assert.equal(submissionStatus({ state: "conflict", current_issue_status: "present" }).tone, "bad")
  assert.equal(submissionStatus({ state: "reconciled", current_issue_status: "absent" }).tone, "idle")
  assert.equal(submissionStatus({ state: "operator_attested", current_issue_status: "absent" }).tone, "attest")
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

test("a submission price names its contract currency and never invents one", () => {
  const rowWith = (values: Record<string, unknown>) =>
    ({ id: "row", card_id: "card", draft: { values, complex_values: [] } }) as unknown as ListingRowView
  const stores = [
    { id: "store-1", cloud_store_uuid: "cloud-1", label: "主店", company_currency: "RUB" },
  ] as OzonStoreView[]
  assert.equal(submissionPrice({ store_id: "store-1" }, rowWith({
    price: { kind: "decimal", value: 1290 },
    currency_code: { kind: "text", value: "CNY" },
  }), stores), "1290 CNY")
  // No draft currency: the store contract is the only truthful code.
  assert.equal(submissionPrice({ store_id: "cloud-1" }, rowWith({ price: { kind: "text", value: "1290" } }), stores), "1290 RUB")
  assert.equal(submissionPrice({ store_id: "missing" }, rowWith({ price: { kind: "text", value: "1290" } }), stores), "1290")
  assert.equal(submissionPrice({ store_id: "store-1" }, rowWith({}), stores), "—")
})
