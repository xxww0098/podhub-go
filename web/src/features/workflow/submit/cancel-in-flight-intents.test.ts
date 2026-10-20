import { route } from "@/api/routes"
import assert from "node:assert/strict"
import test from "node:test"
import { cancelInFlightIntentsForDrafts, cancelInFlightIntentForDraft } from "./cancel-in-flight-intents"

const api = await import("@/api/client").then((module) => module.api)

test("cancels a queued intent beyond the first page for the card", async () => {
  const paths: string[] = []
  const cancelled: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input, init) => {
    const path = String(input)
    paths.push(path)
    if (init?.method === "POST") {
      cancelled.push(path)
      return new Response(JSON.stringify({ data: { id: "late", listing_row_id: "draft-late", state: "queued" } }), { status: 200 })
    }
    const page = path.includes("cursor=next")
      ? { items: [{ id: "late", listing_row_id: "draft-late", state: "queued" }], next_cursor: null }
      : { items: [{ id: "early", listing_row_id: "draft-early", state: "queued" }], next_cursor: "next" }
    return new Response(JSON.stringify({ data: page }), { status: 200 })
  }) as typeof fetch
  try {
    assert.deepEqual(await cancelInFlightIntentsForDrafts(["draft-late"], "card-1"), {
      attempted: 1,
      cancelled: 1,
    })
    assert.deepEqual(paths, [
      `${route("listingIntents")}?cardId=card-1&limit=100&stableOrder=true`,
      `${route("listingIntents")}?cardId=card-1&limit=100&stableOrder=true&cursor=next`,
      route("listingIntentsByIdCancel", { id: "late" }),
    ])
    assert.deepEqual(cancelled, [route("listingIntentsByIdCancel", { id: "late" })])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("does not cancel unknown or terminal intents and dedupes pages", async () => {
  const originalGet = api.get
  const originalPost = api.post
  const cancelled: string[] = []
  api.get = (async (path: string) => path.includes("cursor=next")
    ? { items: [
        { id: "same", listing_row_id: "draft", state: "submitting" },
        { id: "unknown", listing_row_id: "draft", state: "unknown" },
        { id: "done", listing_row_id: "draft", state: "accepted" },
      ], next_cursor: null }
    : { items: [{ id: "same", listing_row_id: "draft", state: "queued" }], next_cursor: "next" }) as typeof api.get
  api.post = (async (path: string) => {
    cancelled.push(path)
    return {}
  }) as typeof api.post
  try {
    assert.deepEqual(await cancelInFlightIntentsForDrafts(["draft"], "card"), {
      attempted: 1,
      cancelled: 1,
    })
    assert.deepEqual(cancelled, [route("listingIntentsByIdCancel", { id: "same" })])
  } finally {
    api.get = originalGet
    api.post = originalPost
  }
})

test("continues bounded cancellation after one failure and reports failure", async () => {
  const originalGet = api.get
  const originalPost = api.post
  let active = 0
  let maxActive = 0
  api.get = (async () => ({
    items: [1, 2, 3, 4].map((n) => ({ id: `i-${n}`, listing_row_id: "draft", state: "queued" })),
    next_cursor: null,
  })) as typeof api.get
  api.post = (async (path: string) => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise((resolve) => setTimeout(resolve, 2))
    active -= 1
    if (path.endsWith("/i-2/cancel")) throw new Error("failed")
    return {}
  }) as typeof api.post
  try {
    await assert.rejects(
      cancelInFlightIntentsForDrafts(["draft"], "card"),
      /1 个 Intent 取消失败/,
    )
    assert.equal(maxActive, 3)
  } finally {
    api.get = originalGet
    api.post = originalPost
  }
})

test("repeated pagination cursor fails closed", async () => {
  const originalGet = api.get
  api.get = (async () => ({
    items: [],
    next_cursor: "same",
  })) as typeof api.get
  try {
    await assert.rejects(cancelInFlightIntentsForDrafts(["draft"], "card"), /分页游标重复/)
  } finally {
    api.get = originalGet
  }
})

test("empty card id refuses safely and never reads the whole workspace", async () => {
  const originalGet = api.get
  let reads = 0
  api.get = (async () => {
    reads += 1
    return { items: [], next_cursor: null }
  }) as typeof api.get
  try {
    await assert.rejects(cancelInFlightIntentsForDrafts(["draft"], "  "), /缺少 Listing Card 标识/)
    assert.equal(reads, 0)
  } finally {
    api.get = originalGet
  }
})

test("pagination failure happens before any cancel POST", async () => {
  const originalGet = api.get
  const originalPost = api.post
  let posts = 0
  api.get = (async (path: string) => {
    if (path.includes("cursor=next")) throw new Error("network")
    return { items: [{ id: "intent", listing_row_id: "draft", state: "queued" }], next_cursor: "next" }
  }) as typeof api.get
  api.post = (async () => {
    posts += 1
    return {}
  }) as typeof api.post
  try {
    await assert.rejects(cancelInFlightIntentsForDrafts(["draft"], "card"), /network/)
    assert.equal(posts, 0)
  } finally {
    api.get = originalGet
    api.post = originalPost
  }
})

test("single-draft cancellation queries by rowId", async () => {
  const originalGet = api.get
  const originalPost = api.post
  let path = ""
  const cancelled: string[] = []
  api.get = (async (requestPath: string) => {
    path = requestPath
    return { items: [
      { id: "intent", listing_row_id: "draft", state: "submitting" },
      { id: "intent-2", listing_row_id: "draft", state: "queued" },
    ], next_cursor: null }
  }) as typeof api.get
  api.post = (async (requestPath: string) => {
    cancelled.push(requestPath)
    return {}
  }) as typeof api.post
  try {
    assert.deepEqual(await cancelInFlightIntentForDraft("draft"), { cancelled: true, intentId: "intent" })
    assert.equal(path, `${route("listingIntents")}?rowId=draft&limit=100&stableOrder=true`)
    assert.deepEqual(cancelled.sort(), [
      route("listingIntentsByIdCancel", { id: "intent-2" }),
      route("listingIntentsByIdCancel", { id: "intent" }),
    ])
  } finally {
    api.get = originalGet
    api.post = originalPost
  }
})
