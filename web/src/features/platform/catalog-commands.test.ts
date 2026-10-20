/**
 * The passthrough half of wave 2: category prompts, category
 * videos, and the shared field library. They arrive camelCase and reach the
 * screens snake_case, so the test asserts both the route and the projection.
 */
import { route } from "@/api/routes"
import assert from "node:assert/strict"
import test from "node:test"

import { listingHttp } from "@/bindings/http-listing"

type Call = { url: string, method: string, body: unknown }

function recordFetch(reply: (call: Call) => unknown): { calls: Call[], restore: () => void } {
  const previous = globalThis.fetch
  const calls: Call[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    }
    calls.push(call)
    return new Response(JSON.stringify({ data: reply(call) }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }) as typeof globalThis.fetch
  return { calls, restore: () => { globalThis.fetch = previous } }
}

test("category prompts and videos read one route and write another", async () => {
  const prompt = {
    prompt_id: "p1",
    name: "识图",
    file_name: "shoes.md",
    content: "…",
    fixed_tags: Array.from({ length: 16 }, (_, index) => `#fixed_${index + 1}`),
    description_category_id: 17028922,
    type_id: 91565,
    updated_at_ms: 5,
  }
  const video = {
    video_id: "v1",
    name: "主图视频",
    video_url: "https://cdn.example.test/v.mp4",
    duration_ms: 8000,
    description_category_id: 17028922,
    type_id: 91565,
    updated_at_ms: 6,
  }
  const stub = recordFetch((call) =>
    call.url.includes("/videos")
      ? call.method === "GET"
        ? { videos: [video] }
        : { video }
      : call.method === "GET"
        ? call.url === route("promptsCategories")
          ? { leaves: [{ description_category_id: 17028922, type_id: 91565 }] }
          : { prompts: [prompt] }
        : { prompt },
  )
  try {
    const prompts = await listingHttp.listingCardListCategoryPrompts(17028922, 91565)
    const leaves = await listingHttp.listingCardListPromptLeaves()
    const saved = await listingHttp.listingCardSaveCategoryPrompt({
      prompt_id: "p1",
      description_category_id: 17028922,
      type_id: 91565,
      name: "识图",
      content: "…",
      file_name: "shoes.md",
      fixed_tags: prompt.fixed_tags,
    })
    const videos = await listingHttp.listingCardListCategoryVideos(17028922, 91565)
    await listingHttp.listingCardSaveCategoryVideo({
      description_category_id: 17028922,
      type_id: 91565,
      name: "主图视频",
      video_url: "https://cdn.example.test/v.mp4",
      duration_ms: 8000,
    })
    assert.deepEqual(stub.calls.map((call) => `${call.method} ${call.url}`), [
      "GET /api/prompts/category/17028922/91565",
      "GET /api/prompts/categories",
      "PUT /api/admin/prompts/p1",
      "GET /api/videos/category/17028922/91565",
      "POST /api/admin/videos",
    ])
    assert.equal(prompts[0].prompt_id, "p1")
    assert.equal(prompts[0].file_name, "shoes.md")
    assert.deepEqual(leaves, [{ description_category_id: 17028922, type_id: 91565 }])
    assert.equal(saved.name, "识图")
    assert.deepEqual(saved.fixed_tags, prompt.fixed_tags)
    assert.deepEqual((stub.calls[2] as { body: { fixed_tags: string[] } }).body.fixed_tags, prompt.fixed_tags)
    assert.equal(videos[0].video_url, "https://cdn.example.test/v.mp4")
    assert.deepEqual(stub.calls[4].body, {
      description_category_id: 17028922,
      type_id: 91565,
      name: "主图视频",
      video_url: "https://cdn.example.test/v.mp4",
      duration_ms: 8000,
    })
  } finally {
    stub.restore()
  }
})


test("cancelling prepare walks every draft once and sums the stamped jobs", async () => {
  const stub = recordFetch(() => ({ jobs: [{ id: "j1" }, { id: "j2" }] }))
  try {
    const result = await listingHttp.operationsCancelPrepare({
      draft_ids: ["row-1", "  ", "row-2"],
    })
    assert.deepEqual(stub.calls.map((call) => `${call.method} ${call.url}`), [
      "POST /api/listing/rows/row-1/prepare/cancel",
      "POST /api/listing/rows/row-2/prepare/cancel",
    ])
    assert.deepEqual(result, { attempted: 2, cancelled: 4 })
    assert.deepEqual(await listingHttp.operationsCancelPrepare({ draft_ids: [] }), {
      attempted: 0,
      cancelled: 0,
    })
    assert.equal(stub.calls.length, 2)
  } finally {
    stub.restore()
  }
})
