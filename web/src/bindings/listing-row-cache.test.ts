import assert from "node:assert/strict"
import { afterEach, test } from "node:test"

import { invalidateAllSessionCaches } from "@/lib/session-cache"
import { patchListingRow } from "./http-listing"
import {
  cachedListingRow,
  forgetCardRows,
  forgetListingRows,
  readListingRowFresh,
  rememberListingRows,
  residentListingRow,
  rowCacheScope,
} from "./listing-row-cache"

const row = (id: string, view_revision: number, extra: Record<string, unknown> = {}) =>
  ({ id, card_id: "card-1", store_id: "store-1", revision: 4, view_revision, payload: { schemaRevision: "r" }, ...extra })

const previousFetch = globalThis.fetch
let gets = 0

function serve(answer: (url: string, init?: RequestInit) => unknown | Promise<unknown>) {
  gets = 0
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "GET") gets += 1
    const data = await answer(String(input), init)
    if (data instanceof Response) return data
    return new Response(JSON.stringify({ data }), { headers: { "Content-Type": "application/json" } })
  }) as typeof fetch
}

function gate() {
  let open!: () => void
  const opened = new Promise<void>((resolve) => { open = resolve })
  return { open, opened }
}

afterEach(() => {
  globalThis.fetch = previousFetch
  invalidateAllSessionCaches()
})

test("a late poll never replaces a newer streamed row, but still answers its own reply", async () => {
  const held = gate()
  serve(async () => { await held.opened; return row("r1", 2) })
  const polling = readListingRowFresh("r1")
  rememberListingRows([row("r1", 3)], rowCacheScope())
  held.open()
  assert.equal((await polling).view_revision, 2)
  assert.equal(cachedListingRow("r1")?.view_revision, 3)
})

test("a resident row costs no GET; concurrent misses share one", async () => {
  serve((url) => row(url.split("/").at(-1)!, 1))
  rememberListingRows([row("hit", 1)], rowCacheScope())
  assert.equal((await residentListingRow("hit")).id, "hit")
  assert.equal(gets, 0)
  const [a, b] = await Promise.all([residentListingRow("miss"), residentListingRow("miss")])
  assert.equal(a, b)
  assert.equal(gets, 1)
})

test("an identity switch mid-read fences the reply and every scope taken before it", async () => {
  const held = gate()
  serve(async () => { await held.opened; return row("r2", 1) })
  const scope = rowCacheScope()
  const reading = residentListingRow("r2")
  invalidateAllSessionCaches()
  held.open()
  await assert.rejects(reading, { code: "workflow_row_cache_stale" })
  rememberListingRows([row("r2", 5)], scope)
  assert.equal(cachedListingRow("r2"), undefined)
  rememberListingRows([row("r2", 5)], rowCacheScope())
  assert.equal(cachedListingRow("r2")?.view_revision, 5, "the new session's own writer is accepted")
})

test("a removal is not resurrected by a writer that started before it", () => {
  const before = rowCacheScope()
  rememberListingRows([row("gone", 1), row("kept", 1, { card_id: "card-2" })], before)
  forgetListingRows(["gone"])
  rememberListingRows([row("gone", 2)], before)
  assert.equal(cachedListingRow("gone"), undefined)
  rememberListingRows([row("gone", 2)], rowCacheScope())
  assert.equal(cachedListingRow("gone")?.view_revision, 2)
  forgetCardRows("card-1")
  assert.equal(cachedListingRow("gone"), undefined)
  assert.equal(cachedListingRow("kept")?.card_id, "card-2")
})

test("malformed rows are never cached", () => {
  rememberListingRows([{ id: "bad", card_id: "card-1", revision: -1, view_revision: 1, payload: {} }, { id: "", card_id: "c", revision: 1, view_revision: 1, payload: {} }], rowCacheScope())
  assert.equal(cachedListingRow("bad"), undefined)
})

test("a failed patch leaves the cached row as it was; a saved one replaces it", async () => {
  rememberListingRows([row("p1", 3)], rowCacheScope())
  serve(() => new Response(JSON.stringify({ code: "conflict", error: "busy" }), { status: 409, headers: { "Content-Type": "application/json" } }))
  await assert.rejects(patchListingRow("p1", { baseRevision: 4, changes: {} }, row("p1", 3) as never))
  assert.equal(cachedListingRow("p1")?.view_revision, 3)
  serve(() => row("p1", 4, { revision: 5 }))
  await patchListingRow("p1", { baseRevision: 4, changes: {} }, row("p1", 3) as never)
  assert.deepEqual([cachedListingRow("p1")?.revision, cachedListingRow("p1")?.view_revision], [5, 4])
})
