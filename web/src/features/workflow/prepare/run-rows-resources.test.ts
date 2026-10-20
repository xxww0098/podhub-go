/** Batch lifetime, preprocessing ownership and media chunk settlement.
 * Tests cross the runRows interface; HTTP, OPFS and rendering use the existing recorded adapters.
 */
import assert from "node:assert/strict"
import test from "node:test"
import type { WorkflowOperationRowResult } from "@/bindings/commands"
import { requestStop, setCardContext } from "./execution-context"
import {
  COMPLETION,
  FIXED_TAGS,
  preparedRowIds,
  RECOGNISED,
  record,
  ROW,
  SLICE_DIGEST,
  windowJobIds,
  withStubbedDevice,
} from "./executor-test-support"

// The media-only chunk size is an observable scheduling contract, not an executor export.
const MEDIA_CHUNK_ROWS = 64

test("a failed row observer waits for sibling rows before disposing the batch", async () => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let observed!: () => void
  const observerFailed = new Promise<void>(resolve => { observed = resolve })
  let disposals = 0
  const stub = record(async call => {
    if (call.url.includes("/slow/")) await held
    return { outcome: "prepared", jobs: [] }
  })
  try {
    await withStubbedDevice(async () => {
      const { runRows } = await import("./run-rows")
      const running = runRows({ row_ids: ["fast", "slow"], expected_revisions: [] }, "recognize", row => {
        if (row.row_id === "fast") { observed(); throw new Error("observer failed") }
      })
      const rejected = assert.rejects(running, /observer failed/)
      await observerFailed
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(disposals, 0, "the slow row still owns its execution resources")
      release()
      await rejected
      assert.equal(disposals, 1)
    }, {}, { dispose: () => { disposals++ } })
  } finally { release(); stub.restore() }
})

test("a held recognize phase never acquires PSD workers", async () => {
  setCardContext({ psdTemplateSha256: "template-sha" })
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let sawOcr!: () => void
  const ocrInFlight = new Promise<void>(resolve => { sawOcr = resolve })
  let renderDisposals = 0
  let renders = 0
  const stub = record(async call => {
    const id = call.url.match(/rows\/([^/]+)/)?.[1] ?? "row-1"
    if (call.url.endsWith("/prepare")) return { outcome: "running", jobs: [
      { id: `${id}-ai`, kind: "ai.recognize", payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "prompt" } } },
    ] }
    if (call.url.endsWith("/ocr/completions")) { sawOcr(); await held; return COMPLETION }
    if (call.url.endsWith("/media")) return { applied: true, row: { ...RECOGNISED, id }, jobs: [] }
    return { ...RECOGNISED, id }
  })
  let running: Promise<WorkflowOperationRowResult[]> | undefined
  try {
    const { runRows } = await import("./run-rows")
    running = withStubbedDevice(() => runRows({ row_ids: ["row-1"], expected_revisions: [] }, "recognize"), {}, {
      disposeRender: () => { renderDisposals += 1 },
      renderProduct: async () => { renders += 1; throw new Error("recognize must not render") },
    })
    await ocrInFlight
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(renderDisposals, 1, "the batch drops its render workers before the first purchase")
    assert.equal(renders, 0)
    release()
    assert.ok((await running).every((row) => row.outcome === "start" && !row.error))
  } finally { release(); await running; stub.restore() }
})

// The pending-upload budget pauses render admission without holding a lane.

for (const stop of [false, true]) test(`preprocessing holds no claim and ${stop ? "Stop releases its buffers" : "ready rows claim without waiting for siblings"}`, async () => {
  const ids = ["image-first", "image-second"]
  const releases: Array<() => void> = []
  let ready!: () => void
  const preparing = new Promise<void>(resolve => { ready = resolve })
  let occupied = 0
  const stub = record(call => {
    const id = call.url.match(/rows\/([^/]+)/)?.[1] ?? ids[0]!
    if (call.url.endsWith("/prepare")) return { outcome: "running", jobs: [{
      id: `${id}-ai`, kind: "ai.recognize", idempotency_key: id,
      payload: { recognition_prompt: { content: "prompt", fixed_tags: FIXED_TAGS } },
    }] }
    if (call.url.endsWith("/ocr/completions")) return COMPLETION
    return { ...RECOGNISED, id }
  })
  const { runRows } = await import("./run-rows")
  const running = withStubbedDevice(() => runRows({ row_ids: ids, expected_revisions: [] }, "recognize"), {}, {
    prepareAiImage: async () => {
      await new Promise<void>(resolve => { releases.push(resolve); if (releases.length === 2) ready() })
      return new Uint8Array([7, 8, 9])
    },
    occupy: (bytes: number) => { occupied += bytes; return () => { occupied -= bytes; assert.ok(occupied >= 0) } },
  })
  try {
    await preparing
    assert.deepEqual(windowJobIds(stub.calls), [])
    assert.ok(occupied > 0, "queued source buffers are accounted")
    if (stop) requestStop(ids)
    releases[0]!()
    if (!stop) {
      for (let i = 0; i < 50 && windowJobIds(stub.calls).length === 0; i++) await new Promise(resolve => setTimeout(resolve, 1))
      assert.deepEqual(windowJobIds(stub.calls), [`${ids[0]}-ai`])
    }
    releases[1]!()
    const results = await running
    assert.ok(results.every(row => stop ? row.noop_reason === "cancelled" : !row.error))
    assert.equal(stub.calls.filter(call => call.url.endsWith("/ocr/completions")).length, stop ? 0 : 2)
    assert.equal(occupied, 0)
    if (stop) assert.deepEqual(windowJobIds(stub.calls), [])
  } finally { for (const release of releases) release(); await running; stub.restore() }
})

test("local render admission queues future rows without server claims and keeps their batch alive", async () => {
  const { renderClient } = await import("@/render/client")
  const originalLimit = renderClient.maxLanes
  renderClient.maxLanes = 1
  setCardContext({ psdTemplateSha256: "template-sha" })
  const ids = ["render-first", "render-second"]
  let release!: () => void
  let started!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const rendering = new Promise<void>(resolve => { started = resolve })
  let disposals = 0
  let renders = 0
  let templates = 0
  const stub = record(call => {
    const id = call.url.match(/rows\/([^/]+)/)?.[1] ?? ids[0]!
    if (call.url.endsWith("/prepare")) return { outcome: "running", jobs: [{
      id: `${id}-render`, kind: "media.render", payload: { psd_template_sha256: "template-sha" },
    }] }
    if (call.url.endsWith("/media")) return { applied: true, row: { ...ROW, id }, jobs: [] }
    return { ...ROW, id }
  })
  const { runRows } = await import("./run-rows")
  const running = withStubbedDevice(() => runRows({ row_ids: ids, expected_revisions: [] }, "slice"), {
    getTemplate: async () => { templates++; return new Uint8Array([4]) },
  }, {
    renderProduct: async () => {
      assert.equal(disposals, 0, "future render rows still own this batch")
      if (++renders === 1) { started(); await held }
      return { manifest: {}, slices: [{ index: 0, groupName: "main", fileName: "image.jpg", width: 1, height: 1, contentHash: `sha256:${SLICE_DIGEST}`, bytes: new Uint8Array([1]) }] }
    },
    disposeRender: () => { disposals++ },
  })
  try {
    await rendering
    await new Promise(resolve => setTimeout(resolve, 5))
    assert.deepEqual(windowJobIds(stub.calls), [])
    assert.equal(renders, 1)
    assert.equal(templates, 1)
    assert.equal(disposals, 0)
    release()
    assert.ok((await running).every(row => !row.error))
    assert.deepEqual(windowJobIds(stub.calls), [])
    assert.equal(renders, 2)
    assert.equal(disposals, 1)
  } finally { release(); await running; stub.restore(); renderClient.maxLanes = originalLimit; setCardContext({ psdTemplateSha256: "" }) }
})

test("a chunk settles before the next row starts, and one failure does not skip later chunks", async () => {
  setCardContext({ psdTemplateSha256: "template-sha" })
  const { runRows } = await import("./run-rows")
  const ids = Array.from({ length: MEDIA_CHUNK_ROWS + 1 }, (_, index) => `chunk-${index}`)
  const last = ids[MEDIA_CHUNK_ROWS]!
  const firstChunk = new Set(ids.slice(0, MEDIA_CHUNK_ROWS))
  const releases: Array<() => void> = []
  const prepared: string[] = []
  let version = 0
  const waiters: Array<() => void> = []
  const bump = () => {
    version += 1
    for (const wake of waiters.splice(0)) wake()
  }
  const changedSince = (seen: number) => version !== seen
    ? Promise.resolve()
    : new Promise<void>((resolve) => { waiters.push(resolve) })
  const stub = record(async (call) => {
    const id = call.url.match(/rows\/([^/]+)/)?.[1] ?? ids[0]!
    if (call.url.endsWith("/prepare")) {
      prepared.push(id)
      bump()
      await new Promise<void>((resolve) => { releases.push(resolve) })
      if (id === ids[0]) return { outcome: "blocked", jobs: [], issues: [{ kind: "media.render", blockers: ["bad_row"] }] }
      return { outcome: "prepared", jobs: [] }
    }
    return { ...ROW, id }
  })
  const releaseAll = () => {
    for (const release of releases.splice(0)) release()
  }
  let running: Promise<WorkflowOperationRowResult[]> | undefined
  try {
    running = withStubbedDevice(() => runRows({ row_ids: ids, expected_revisions: [] }, "slice"))
    await changedSince(0)
    assert.equal(prepared.includes(last), false)
    assert.ok(prepared.length > 0 && prepared.length <= MEDIA_CHUNK_ROWS)
    assert.ok(prepared.every((id) => firstChunk.has(id)))
    let seen = version
    while (!prepared.includes(last)) {
      const before = prepared.length
      releaseAll()
      if (prepared.length === before) {
        const stalled = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("chunk did not advance")), 1000)
        })
        await Promise.race([changedSince(seen), stalled])
        seen = version
      }
      if (!prepared.includes(last)) assert.ok(prepared.every((id) => firstChunk.has(id)))
    }
    assert.deepEqual(prepared.slice(0, MEDIA_CHUNK_ROWS), ids.slice(0, MEDIA_CHUNK_ROWS))
    releaseAll()
    const results = await running
    assert.deepEqual(results.map((row) => row.row_id), ids)
    assert.equal(results[0]?.outcome, "blocked")
    assert.deepEqual(results[0]?.blockers, ["bad_row"])
    assert.ok(results.slice(1).every((row) => row.outcome === "noop" && !row.error))
  } finally {
    releaseAll()
    await running
    stub.restore()
    setCardContext({ psdTemplateSha256: "" })
  }
})

test("a rejected row does not stop the next chunk", async () => {
  setCardContext({ psdTemplateSha256: "template-sha" })
  const { runRows } = await import("./run-rows")
  const ids = Array.from({ length: MEDIA_CHUNK_ROWS + 1 }, (_, index) => `reject-${index}`)
  const stub = record((call) => {
    const id = call.url.match(/rows\/([^/]+)/)?.[1] ?? ids[0]!
    if (call.url.endsWith("/prepare")) return { outcome: "prepared", jobs: [] }
    return { ...ROW, id }
  })
  try {
    await assert.rejects(
      withStubbedDevice(() => runRows({ row_ids: ids, expected_revisions: [] }, "slice", (row) => {
        if (row.row_id === ids[0] && !row.interim) throw new Error("row failed")
      })),
      /row failed/,
    )
    assert.deepEqual(preparedRowIds(stub.calls), ids)
  } finally {
    stub.restore()
    setCardContext({ psdTemplateSha256: "" })
  }
})
