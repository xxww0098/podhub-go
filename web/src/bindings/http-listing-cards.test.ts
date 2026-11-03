import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { route } from "@/api/routes"
import { invalidateAllSessionCaches } from "@/lib/session-cache"
import { listingHttp } from "./http-listing"

const originalFetch = globalThis.fetch
const card = (id: string, updated_at_ms = 123) => ({ id, title: id, revision: 1, payload: {}, updated_at_ms })

function serve(answer: (url: string) => unknown | Promise<unknown>) {
  globalThis.fetch = (async (input) => new Response(JSON.stringify({ data: await answer(String(input)) }), {
    headers: { "Content-Type": "application/json" },
  })) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = originalFetch
  invalidateAllSessionCaches()
})

test("saved plans follow every cursor, preserve server order and expose the wire timestamp", async () => {
  const urls: string[] = []
  const cursor = "1787333400000123:11111111-1111-4111-8111-111111111111"
  serve((url) => {
    urls.push(url)
    return urls.length === 1
      ? { items: Array.from({ length: 100 }, (_, i) => card(String(i))), nextCursor: cursor }
      : { items: [card("last", 456)] }
  })
  const cards = await listingHttp.listingCardListSavedDrafts()
  assert.equal(cards.length, 101)
  assert.equal(cards[0]?.draft_id, "0")
  assert.equal(cards[100]?.draft_id, "last")
  assert.equal(cards[100]?.updated_at_ms, 456)
  assert.equal(urls[1], `${route("listingCards")}?limit=100&cursor=${encodeURIComponent(cursor)}`)
})

test("empty plan lists finish after one request", async () => {
  let calls = 0
  serve(() => { calls += 1; return { items: [] } })
  assert.deepEqual(await listingHttp.listingCardListSavedDrafts(), [])
  assert.equal(calls, 1)
})

test("repeated cursors reject instead of looping or reporting a partial list", async () => {
  let calls = 0
  serve(() => { calls += 1; return { items: [card("same")], nextCursor: "same-cursor" } })
  await assert.rejects(listingHttp.listingCardListSavedDrafts(), { code: "workflow_card_list_cursor" })
  assert.equal(calls, 2)
})

test("a workspace change during pagination rejects the old list", async () => {
  let calls = 0
  serve(() => {
    calls += 1
    if (calls === 1) return { items: [card("old-workspace")], nextCursor: "next" }
    invalidateAllSessionCaches()
    return { items: [card("new-workspace")] }
  })
  await assert.rejects(listingHttp.listingCardListSavedDrafts(), { code: "workflow_card_list_stale" })
  assert.equal(calls, 2)
})
