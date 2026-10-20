import assert from "node:assert/strict"
import test from "node:test"
import { cancelListingIntent, probeListingIntent, readListingIntent, readListingIntents, releaseUnknownListingIntents, type ListingIntent } from "./http-listing-intents"

export const intentFixture = (patch: Partial<ListingIntent> = {}): ListingIntent => ({
  id: "i1", listing_row_id: "r1", store_id: "s1", row_revision: 0, client_operation_id: "server-op",
  state: "queued", can_resume: false, current_issue_status: "absent", submission_issues: [],
  submission_receipt_status: "absent", updated_at_ms: 1, ...patch,
})

test("exact/batch/cancel/release preserve actual Intent wire and do not auto-page", async () => {
  const original = globalThis.fetch
  const calls: { url: string; body: unknown }[] = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, body: init?.body })
    if (url.endsWith("release-unknown")) return Response.json({ data: { released_intent_ids: ["i1"], intents: [intentFixture({ state: "superseded" })] } })
    return Response.json({ data: url.includes("?") ? { items: [intentFixture()], next_cursor: "truncated" } : intentFixture() })
  }
  try {
    assert.equal((await readListingIntent("i1")).id, "i1")
    const page = await readListingIntents("s1", { rowIds: ["r1"] })
    assert.equal(page.next_cursor, "truncated")
    const query = new URL(calls[1]!.url, "https://fixture.invalid").searchParams
    assert.equal(query.get("storeId"), "s1")
    assert.equal(query.get("limit"), "100")
    assert.equal(query.get("latestPerRow"), "true")
    await cancelListingIntent("i1")
    assert.equal(calls[2]!.body, undefined)
    assert.deepEqual((await releaseUnknownListingIntents(["i1"])).released_intent_ids, ["i1"])
    assert.equal(calls.length, 4)
    await assert.rejects(readListingIntents("s1", { rowIds: Array.from({ length: 101 }, (_, i) => String(i)) }))
    assert.equal(calls.length, 4)
  } finally { globalThis.fetch = original }
})

test("wrong-store and malformed Intent responses never become authority", async () => {
  const original = globalThis.fetch
  try {
    for (const value of [intentFixture({ store_id: "other" }), { id: "i1" }]) {
      globalThis.fetch = async () => Response.json({ data: { items: [value] } })
      await assert.rejects(readListingIntents("s1", { intentIds: ["i1"] }), { code: "listing_contract_invalid" })
    }
  } finally { globalThis.fetch = original }
})

test("optional release read facts survive exact/page/release and fresh readback without granting send permission", async () => {
  const original = globalThis.fetch
  const facts: { has_live_reconcile_claim?: boolean; has_unfinished_dispatch_job?: boolean }[] = [
    {}, { has_live_reconcile_claim: false }, { has_unfinished_dispatch_job: false },
    ...[false, true].flatMap((claim) => [false, true].map((job) => ({ has_live_reconcile_claim: claim, has_unfinished_dispatch_job: job }))),
  ]
  let calls = 0
  try {
    for (const fact of facts) {
      let current = { ...intentFixture({ state: "unknown" }), ...fact }
      globalThis.fetch = async (input) => {
        calls++
        const url = String(input)
        return Response.json({ data: url.endsWith("release-unknown")
          ? { released_intent_ids: ["i1"], intents: [current] }
          : url.includes("?") ? { items: [current], next_cursor: "truncated" } : current })
      }
      const before = calls
      assert.deepEqual(await readListingIntent("i1"), current)
      assert.deepEqual((await readListingIntents("s1", { intentIds: ["i1"] })).items, [current])
      current = { ...current, state: "superseded" }
      assert.deepEqual((await releaseUnknownListingIntents(["i1"])).intents, [current])
      assert.equal(calls, before + 3, "no automatic release, pagination or readback")
      // Another actor can acquire work after release; only a new explicit read sees it.
      current = { ...intentFixture({ state: "queued" }), has_live_reconcile_claim: true, has_unfinished_dispatch_job: true }
      assert.deepEqual(await readListingIntent("i1"), current)
      assert.equal(current.can_resume, false)
      assert.equal(calls, before + 4, "read facts never trigger a submit")
    }
  } finally { globalThis.fetch = original }
})

test("non-boolean release read facts fail closed on exact/page/cancel/release responses", async () => {
  const original = globalThis.fetch
  let calls = 0
  try {
    for (const key of ["has_live_reconcile_claim", "has_unfinished_dispatch_job"]) {
      for (const malformed of [null, 0, 1, "false", "true", {}, []]) {
        const value = { ...intentFixture(), [key]: malformed }
        globalThis.fetch = async (input) => {
          calls++
          const url = String(input)
          return Response.json({ data: url.endsWith("release-unknown")
            ? { released_intent_ids: ["i1"], intents: [value] }
            : url.includes("?") ? { items: [value] } : value })
        }
        const before = calls
        for (const read of [() => readListingIntent("i1"), () => readListingIntents("s1", { rowIds: ["r1"] }),
          () => cancelListingIntent("i1"), () => releaseUnknownListingIntents(["i1"])]) {
          await assert.rejects(read(), { code: "listing_contract_invalid" })
        }
        assert.equal(calls, before + 4, "invalid facts never cause a follow-up request")
      }
    }
  } finally { globalThis.fetch = original }
})

test("a manual offer probe is one read and never an import", async () => {
  const original = globalThis.fetch
  const calls: { url: string; method: string; body: unknown }[] = []
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body })
    return Response.json({ data: intentFixture({
      state: "unknown",
      import_probe: { phase: "needs_manual", passes: 9 },
    }) })
  }
  try {
    const intent = await probeListingIntent("i1")
    assert.equal(intent.import_probe?.phase, "needs_manual")
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.method, "POST")
    assert.equal(calls[0]!.body, undefined)
    assert.match(calls[0]!.url, /\/api\/listing\/intents\/i1\/probe$/)
    assert.doesNotMatch(calls[0]!.url, /import|recover/)
  } finally { globalThis.fetch = original }
})
