import { route } from "@/api/routes"
import assert from "node:assert/strict"
import { setImmediate } from "node:timers/promises"
import test from "node:test"
import { listingRow } from "../../../tests/listing-row-fixture"
import type { WorkflowVideoMetadata } from "@/bindings/commands"
import { workflowActions } from "./workflow-actions"

test("video binding limits unfinished row writes and preserves ordered partial results", async () => {
  const video: WorkflowVideoMetadata = {
    role: "product", origin: "public_url", file_name: "clip.mp4", content_type: "video/mp4",
    size_bytes: 42, duration_ms: 1000, public_url: "https://example.test/clip.mp4",
  }
  const ids = Array.from({ length: 12 }, (_, i) => `row-${i}`)
  const original = globalThis.fetch
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  let active = 0, peak = 0
  const written = new Map<string, unknown>()
  const reads: string[] = []
  globalThis.fetch = async (input, options) => {
    const path = String(input)
    const reply = (data: unknown) => Response.json({ data })
    if (path === route("listingCardsById", { id: "card" })) {
      return reply({ id: "card", payload: { videos: [video] } })
    }
    const rowsPrefix = route("listingRowsById", { id: "placeholder" }).replace("placeholder", "")
    const id = decodeURIComponent(path.slice(rowsPrefix.length))
    assert(ids.includes(id), `unexpected request ${path}`)
    if (options?.method === "GET") {
      reads.push(id)
      peak = Math.max(peak, ++active)
      return reply(listingRow({ id, revision: 7 }))
    }
    assert.equal(options?.method, "PATCH")
    const body = JSON.parse(String(options.body))
    assert.equal(body.baseRevision, 7)
    await barrier
    active--
    if (id === "row-1") return Response.json({ code: "revision_conflict", error: "row changed" }, { status: 409 })
    written.set(id, body.changes.media.videos)
    return reply(listingRow({ id, revision: 8, media: body.changes.media }))
  }
  const work = workflowActions.listingCardAttachVideoToProducts({
    card_draft_id: "card", target_draft_ids: ids, role: "product", video_identity: video.public_url!,
  })
  try {
    await setImmediate()
    assert(reads.length > 0 && reads.length < ids.length, "the first blocked wave must not start the entire batch")
    const firstWave = reads.length
    release()
    const result = await work
    assert.equal(peak, firstWave, "a GET must hold its place until its PATCH finishes")
    assert.deepEqual(result.map(item => item.draft_id), ids)
    assert.equal(result[1]!.error, "row changed")
    for (const item of result.filter(item => item.draft_id !== "row-1")) {
      assert.deepEqual(item.lifecycle?.product_videos, [video])
      assert.deepEqual(written.get(item.draft_id), [video])
    }
    assert.equal(written.has("row-1"), false)
  } finally {
    release()
    await work
    globalThis.fetch = original
  }
})
