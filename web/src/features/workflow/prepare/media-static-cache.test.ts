/**
 * The media.render / media.upload rail: OPFS render, the static-slice cache and public confirmation.
 *
 * The renderer and OPFS are stubbed (executor-test-support): what these tests
 * are for is the wire — the route a verb takes, the pin it writes under, and
 * the shape Cloud will refuse if it drifts.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { sha256Hex } from "@/render/opfs"

import { setCardContext } from "./execution-context"
import { RENDERER_CONTRACT_VERSION } from "./media-job"
import { FIXED_TAGS, record, ROW, SLICE_DIGEST, withStubbedDevice } from "./executor-test-support"

/** The three-slice render fixture the static-cache tests render, skip and file. */
async function sliceFixture() {
  const hashed = (bytes: Uint8Array) => sha256Hex(bytes).then(digest => `sha256:${digest}`)
  const dynamicBytes = new Uint8Array([1, 2])
  const labelBytes = new Uint8Array([3, 4, 5])
  const frameBytes = new Uint8Array([9])
  const dynamic = { groupName: "art", index: 1, fileName: "image-1-2.jpg", width: 8, height: 8, contentHash: await hashed(dynamicBytes), staticGroup: false, bytes: dynamicBytes }
  const skipped = { groupName: "label", index: 2, fileName: "image-1-3.jpg", width: 0, height: 0, contentHash: "", staticGroup: true, bytes: new Uint8Array(0) }
  const rendered = { ...skipped, width: 6, height: 4, contentHash: await hashed(labelBytes), bytes: labelBytes }
  const firstSkipped = { ...skipped, groupName: "frame", index: 0, fileName: "image-1-1.jpg" }
  const firstRendered = { ...firstSkipped, width: 8, height: 8, contentHash: await hashed(frameBytes), bytes: frameBytes }
  return { dynamic, skipped, rendered, firstSkipped, firstRendered }
}

test("static groups come from the OPFS cache in group order; a miss renders everything once", async () => {
  setCardContext({ psdTemplateSha256: "template-sha" })
  const stub = record((call) => {
    if (call.url.endsWith("/prepare")) {
      return { outcome: "running", jobs: [{ id: "job-9", kind: "media.render", aggregate_id: "row-1", aggregate_type: "listing_row", input_revision: 10, state: "queued", attempt: 0, idempotency_key: "slice:v1:row-1:10", payload: { recognition_prompt: { prompt_id: "prompt-1", fixed_tags: FIXED_TAGS, content: "识图提示词", sha256: "prompt-sha" }, executor: "browser", pinned_revision: 10, source_sha256: "source-sha", psd_template_sha256: "pinned-template-sha", renderer_contract_version: RENDERER_CONTRACT_VERSION }, updated_at_ms: 0 }] }
    }
    if (call.url.endsWith("/media")) return { applied: true, jobs: [], row: ROW }
    return { ...ROW, revision: 10, media_state: "processing" }
  })
  const { dynamic, skipped, rendered, firstSkipped, firstRendered } = await sliceFixture()
  const cached = [firstRendered, rendered].map(slice => ({ ...slice, groupIndex: slice.index, byteSize: slice.bytes.length }))
  const manifest = { templateFingerprint: "sha256:pinned-template-sha", staticGroups: 2, stageTimings: { render: 123 } }
  const intents: Array<string | undefined> = []
  const written: unknown[][] = []
  let hit = true
  const run = async () => {
    const { runRows } = await import("./run-rows")
    return withStubbedDevice(
      () => runRows({ row_ids: ["row-1"], expected_revisions: [{ row_id: "row-1", revision: 9 }] }, "slice"),
      {
        openStaticSliceCache: async () => ({
          read: async (groups: { index: number; groupName: string }[]) => groups.map(group =>
            hit ? cached.find(entry => entry.groupIndex === group.index && entry.groupName === group.groupName) ?? null : null),
        }),
        writeStaticSlices: async (_fingerprint: string, _profile: string, slices: unknown[]) => {
          written.push(slices)
        },
      },
      {
        renderProduct: async (_t: number, _d: Uint8Array, _n: string, intent?: { staticGroups?: string }) => {
          intents.push(intent?.staticGroups)
          const slices = intent?.staticGroups === "skip" ? [firstSkipped, dynamic, skipped] : [firstRendered, dynamic, rendered]
          return { manifest: { ...manifest, slices: slices.map(({ bytes: _bytes, ...metadata }) => metadata) }, slices }
        },
      },
    )
  }
  const images = () =>
    stub.calls.at(-1)!.body.payload.media.images.map((image: any) => [image.index, image.group_name, image.content_hash, image.byte_size])
  try {
    await run()
    assert.deepEqual(intents, ["skip"], "a warm cache renders the dynamic groups only")
    assert.deepEqual(images(), [[0, "frame", firstRendered.contentHash, 1], [1, "art", dynamic.contentHash, 2], [2, "label", rendered.contentHash, 3]])
    assert.deepEqual(written, [], "nothing new to file")
    assert.deepEqual(stub.calls.at(-1)!.body.payload.render_evidence.manifest, {
      ...manifest, slices: [firstRendered, dynamic, rendered].map(({ bytes: _bytes, ...metadata }) => metadata),
    }, "the submitted manifest describes the filled images, preserving renderer evidence")

    intents.length = 0
    hit = false
    await run()
    assert.deepEqual(intents, ["skip", undefined], "a miss renders everything, once")
    assert.deepEqual(images(), [[0, "frame", firstRendered.contentHash, 1], [1, "art", dynamic.contentHash, 2], [2, "label", rendered.contentHash, 3]])
    assert.deepEqual(written, [[firstRendered, rendered]], "the full render files its static slices")
  } finally {
    stub.restore()
    setCardContext({ psdTemplateSha256: "" })
  }
})

test("a static cache write failure does not discard completed slices", async () => {
  setCardContext({ psdTemplateSha256: "template-sha" })
  const stub = record(call => {
    if (call.url.endsWith("/prepare")) return { outcome: "running", jobs: [{
      id: "cache-write-job", kind: "media.render", payload: {
        source_sha256: "source-sha", psd_template_sha256: "pinned-template-sha", renderer_contract_version: RENDERER_CONTRACT_VERSION,
      },
    }] }
    if (call.url.endsWith("/media")) return { applied: true, jobs: [], row: ROW }
    return ROW
  })
  const slice = { index: 0, groupName: "main", fileName: "image.jpg", width: 1, height: 1,
    contentHash: `sha256:${SLICE_DIGEST}`, staticGroup: true, bytes: new Uint8Array([1]) }
  try {
    const { runRows } = await import("./run-rows")
    const result = await withStubbedDevice(
      () => runRows({ row_ids: ["row-1"], expected_revisions: [{ row_id: "row-1", revision: 9 }] }, "slice"),
      { writeStaticSlices: async () => { throw new DOMException("cache is full", "QuotaExceededError") } },
      { renderProduct: async () => ({ manifest: { templateFingerprint: "sha256:pinned-template-sha" }, slices: [slice] }) },
    )
    assert.equal(result[0]!.error, undefined)
    const committed = stub.calls.find(call => call.url.endsWith("/media") && call.body.media_state === "rendered")
    assert.equal(committed?.body.payload.media.images[0].content_hash, slice.contentHash)
  } finally {
    stub.restore()
    setCardContext({ psdTemplateSha256: "" })
  }
})

test("a static cache hole rerenders every group instead of writing a gap", async () => {
  setCardContext({ psdTemplateSha256: "template-sha" })
  const stub = record((call) => {
    if (call.url.endsWith("/prepare")) {
      return { outcome: "running", jobs: [{ id: "job-hole", kind: "media.render", aggregate_id: "row-1", aggregate_type: "listing_row", input_revision: 10, state: "queued", attempt: 0, idempotency_key: "slice:v1:row-1:10", payload: { recognition_prompt: { prompt_id: "prompt-1", fixed_tags: FIXED_TAGS, content: "识图提示词", sha256: "prompt-sha" }, executor: "browser", pinned_revision: 10, source_sha256: "source-sha", psd_template_sha256: "pinned-template-sha", renderer_contract_version: RENDERER_CONTRACT_VERSION }, updated_at_ms: 0 }] }
    }
    if (call.url.endsWith("/media")) return { applied: true, jobs: [], row: ROW }
    return { ...ROW, revision: 10, media_state: "processing" }
  })
  const { dynamic, skipped, rendered, firstSkipped, firstRendered } = await sliceFixture()
  const cached = [{ ...rendered, groupIndex: rendered.index, byteSize: rendered.bytes.length }]
  const intents: Array<string | undefined> = []
  try {
    const { runRows } = await import("./run-rows")
    await withStubbedDevice(
      () => runRows({ row_ids: ["row-1"], expected_revisions: [{ row_id: "row-1", revision: 9 }] }, "slice"),
      {
        openStaticSliceCache: async () => ({
          read: async (groups: { index: number; groupName: string }[]) => groups.map(group =>
            cached.find(entry => entry.groupIndex === group.index && entry.groupName === group.groupName) ?? null),
        }),
        writeStaticSlices: async () => undefined,
      },
      {
        renderProduct: async (_t: number, _d: Uint8Array, _n: string, intent?: { staticGroups?: string }) => {
          intents.push(intent?.staticGroups)
          return { manifest: { templateFingerprint: "sha256:pinned-template-sha" }, slices: intent?.staticGroups === "skip" ? [firstSkipped, dynamic, skipped] : [firstRendered, dynamic, rendered] }
        },
      },
    )
    assert.deepEqual(intents, ["skip", undefined], "one missing static group forces a full render")
  } finally {
    stub.restore()
    setCardContext({ psdTemplateSha256: "" })
  }
})

test("two concurrent cold rows share one full static fill", async () => {
  setCardContext({ psdTemplateSha256: "template-sha" })
  const client = await import("@/render/client")
  const previousLanes = client.renderClient.maxLanes
  client.renderClient.maxLanes = 2
  const stub = record((call) => {
    const rowId = call.url.match(/\/rows\/([^/]+)/)?.[1] ?? "row-1"
    if (call.url.endsWith("/prepare")) {
      return { outcome: "running", jobs: [{ id: `job-${rowId}`, kind: "media.render", aggregate_id: rowId, aggregate_type: "listing_row", input_revision: 10, state: "queued", attempt: 0, idempotency_key: `slice:v1:${rowId}:10`, payload: { recognition_prompt: { prompt_id: "prompt-1", fixed_tags: FIXED_TAGS, content: "识图提示词", sha256: "prompt-sha" }, executor: "browser", pinned_revision: 10, source_sha256: "source-sha", psd_template_sha256: "pinned-template-sha", renderer_contract_version: RENDERER_CONTRACT_VERSION }, updated_at_ms: 0 }] }
    }
    if (call.url.endsWith("/media")) return { applied: true, jobs: [], row: { ...ROW, id: rowId } }
    return { ...ROW, id: rowId, revision: 10, media_state: "processing" }
  })
  const { dynamic, skipped, rendered, firstSkipped, firstRendered } = await sliceFixture()
  let filed: typeof firstRendered[] = []
  const intents: Array<string | undefined> = []
  let releaseFull!: () => void
  const held = new Promise<void>((resolve) => {
    releaseFull = resolve
  })
  let fullStarted = 0
  try {
    const { runRows } = await import("./run-rows")
    const running = withStubbedDevice(
      () => runRows({
        row_ids: ["row-1", "row-2"],
        expected_revisions: [{ row_id: "row-1", revision: 9 }, { row_id: "row-2", revision: 9 }],
      }, "slice"),
      {
        openStaticSliceCache: async () => filed.length ? {
          read: async (groups: { index: number; groupName: string }[]) => groups.map(group =>
            filed.find(entry => entry.index === group.index && entry.groupName === group.groupName)
              ? { ...filed.find(entry => entry.index === group.index && entry.groupName === group.groupName)!, groupIndex: group.index, byteSize: filed.find(entry => entry.index === group.index)!.bytes.length }
              : null),
        } : null,
        writeStaticSlices: async (_fingerprint: string, _profile: string, slices: typeof firstRendered[]) => {
          filed = slices
        },
      },
      {
        concurrentLanes: true,
        renderProduct: async (_t: number, _d: Uint8Array, _n: string, intent?: { staticGroups?: string }) => {
          intents.push(intent?.staticGroups)
          if (intent?.staticGroups === "skip") return { manifest: { templateFingerprint: "sha256:pinned-template-sha" }, slices: [firstSkipped, dynamic, skipped] }
          fullStarted += 1
          await held
          return { manifest: { templateFingerprint: "sha256:pinned-template-sha" }, slices: [firstRendered, dynamic, rendered] }
        },
      },
    )
    for (let i = 0; i < 50 && fullStarted < 1; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(fullStarted, 1, "the follower waits instead of starting a second full render")
    releaseFull()
    await running
    assert.equal(fullStarted, 1)
    assert.equal(intents.filter((intent) => intent === "skip").length, 1)
    assert.equal(intents.filter((intent) => intent === undefined).length, 1)
  } finally {
    releaseFull()
    client.renderClient.maxLanes = previousLanes
    stub.restore()
    setCardContext({ psdTemplateSha256: "" })
  }
})
