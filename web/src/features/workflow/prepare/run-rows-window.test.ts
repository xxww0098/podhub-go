/** Independent preparation windows and recognition throughput under slow siblings.
 * Tests cross the runRows interface; HTTP, OPFS and rendering use the existing recorded adapters.
 */
import assert from "node:assert/strict"
import test from "node:test"
import type { WorkflowOperationRowResult } from "@/bindings/commands"
import { AI_CONCURRENCY } from "./ai-job"
import { resetPendingUploads, setCardContext } from "./execution-context"
import {
  COMPLETION,
  FIXED_TAGS,
  preparedRowIds,
  RECOGNISED,
  record,
  singleJobClaims,
  SLICE_DIGEST,
  windowCalls,
  windowJobIds,
  withStubbedDevice,
} from "./executor-test-support"

// The media-only chunk size is an observable scheduling contract, not an executor export.
const MEDIA_CHUNK_ROWS = 64

test("held AI calls occupy only their own bounded pool", async () => {
  setCardContext({ psdTemplateSha256: "template-sha" })
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let reached!: () => void
  const progressed = new Promise<void>(resolve => { reached = resolve })
  let paid = 0
  const ids = Array.from({ length: AI_CONCURRENCY + 1 }, (_, i) => `bounded-${i}`)
  const stub = record(async call => {
    const id = call.url.match(/rows\/([^/]+)/)?.[1] ?? ids[0]!
    if (call.url.endsWith("/prepare")) return { outcome: "running", jobs: [
      { id: `${id}-ai`, kind: "ai.recognize", payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "prompt" } } },
    ] }
    if (call.url.endsWith("/ocr/completions")) { if (++paid === AI_CONCURRENCY) reached(); await held; return COMPLETION }
    if (call.url.endsWith("/ai/settle")) return { ...RECOGNISED, id }
    return { ...RECOGNISED, id }
  })
  let running: Promise<WorkflowOperationRowResult[]> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    const { runRows } = await import("./run-rows")
    running = withStubbedDevice(() => runRows({ row_ids: ids, expected_revisions: [] }, "recognize"))
    await Promise.race([progressed, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("held calls did not fill the AI pool")), 500) })])
    assert.equal(paid, AI_CONCURRENCY, "the extra row cannot buy while the pool is held")
    assert.equal(stub.calls.filter(call => call.url.endsWith("/claim")).length, 0)
    assert.equal(windowJobIds(stub.calls).filter((id) => id.endsWith("-ai")).length, AI_CONCURRENCY)
    release()
    assert.ok((await running).every((row) => row.outcome === "start" && !row.error))
    assert.equal(paid, ids.length, "the last row buys once a slot frees")
  } finally { if (deadline) clearTimeout(deadline); release(); await running; stub.restore() }
})

test("prepare pins only the active-row window while earlier executions are hung", async () => {
  const ids = Array.from({ length: 200 }, (_, i) => `jit-${i + 1}`)
  let release!: () => void
  const hung = new Promise<void>((resolve) => { release = resolve })
  let windowReady!: () => void
  const sawWindow = new Promise<void>((resolve) => { windowReady = resolve })
  let prepared = 0
  const stub = record(async (call) => {
    const id = call.url.match(/rows\/([^/]+)/)?.[1] ?? ids[0]!
    if (call.url.endsWith("/prepare")) {
      if (++prepared === AI_CONCURRENCY) windowReady()
      return { outcome: "running", jobs: [{
        id: `${id}-ai`, kind: "ai.recognize",
        payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "prompt" } },
      }] }
    }
    if (call.url.endsWith("/ocr/completions")) { await hung; return COMPLETION }
    return { ...RECOGNISED, id }
  })
  let running: Promise<WorkflowOperationRowResult[]> | undefined
  try {
    const { runRows } = await import("./run-rows")
    running = withStubbedDevice(() => runRows({ row_ids: ids, expected_revisions: [] }, "prepare"))
    await sawWindow
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.deepEqual(preparedRowIds(stub.calls), ids.slice(0, AI_CONCURRENCY))
  } finally {
    release()
    await running
    stub.restore()
  }
})

test("prepare window advances to the next row when one active row settles", async () => {
  const ids = Array.from({ length: 100 }, (_, i) => `adv-${i + 1}`)
  let releaseWaiting!: () => void
  const holdWaiting = new Promise<void>((resolve) => { releaseWaiting = resolve })
  let nextPinned!: () => void
  const sawNext = new Promise<void>((resolve) => { nextPinned = resolve })
  const stub = record(async (call) => {
    const id = call.url.match(/rows\/([^/]+)/)?.[1] ?? ids[0]!
    if (call.url.endsWith("/prepare")) {
      if (id === ids[AI_CONCURRENCY]) nextPinned()
      return { outcome: "running", jobs: [{
        id: `${id}-ai`, kind: "ai.recognize", idempotency_key: id,
        payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "prompt" } },
      }] }
    }
    if (call.url.endsWith("/ocr/completions")) {
      const key = call.headers["Idempotency-Key"]
      if (key !== ids[0]) await holdWaiting
      return COMPLETION
    }
    return { ...RECOGNISED, id }
  })
  let running: Promise<WorkflowOperationRowResult[]> | undefined
  try {
    const { runRows } = await import("./run-rows")
    running = withStubbedDevice(() => runRows({ row_ids: ids, expected_revisions: [] }, "prepare"))
    await sawNext
    await new Promise<void>((resolve) => setImmediate(resolve))
    const prepared = preparedRowIds(stub.calls)
    assert.deepEqual(prepared, ids.slice(0, AI_CONCURRENCY + 1), "one completed OCR admits exactly one waiting row")
    assert.ok(prepared.length <= AI_CONCURRENCY + 1)
  } finally {
    releaseWaiting()
    await running
    stub.restore()
  }
})

test("prepare chains each row while another row's OCR is held", async () => {
  setCardContext({ psdTemplateSha256: "template-sha" })
  const ids = ["phase-1", "phase-2"]
  let releaseOcr!: () => void
  const heldOcr = new Promise<void>((resolve) => { releaseOcr = resolve })
  let sawRender!: () => void
  const renderStarted = new Promise<void>((resolve) => { sawRender = resolve })
  const renders: string[] = []
  const stub = record(async (call) => {
    const id = call.url.match(/rows\/([^/]+)/)?.[1] ?? ids[0]!
    if (call.url.endsWith("/prepare")) {
      if (call.body.operation === "prepare" || call.body.operation === "recognize") return { outcome: "running", jobs: [
        { id: `${id}-ai`, kind: "ai.recognize", payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "prompt" } } },
        { id: `${id}-render`, kind: "media.render", payload: { psd_template_sha256: "template-sha" } },
      ] }
      if (call.body.operation === "slice") return { outcome: "running", jobs: [
        { id: `${id}-render`, kind: "media.render", payload: { psd_template_sha256: "template-sha" } },
      ] }
      return { outcome: "running", jobs: [{ id: `${id}-upload`, kind: "media.upload", payload: { manifest_digest: `manifest:test:${id}-render`, manifest: {} } }] }
    }
    if (call.url.endsWith("/ocr/completions")) {
      if (call.headers["X-Listing-Job-Id"] === `${ids[0]}-ai`) await heldOcr
      return COMPLETION
    }
    if (call.url.endsWith("/media") && call.body.media_state === "rendered") {
      renders.push(id)
      if (id === ids[1]) sawRender()
      return { applied: true, row: { ...RECOGNISED, id, media_state: "rendered" }, jobs: [] }
    }
    if (call.url.endsWith("/media/images")) {
      return [{ applied: true, index: 0, phase: "public_ready", publicUrl: "https://cdn.invalid/image.jpg",
        objectKey: `${id}.jpg`, accountId: "account", storageRevision: 1, completed: 1, total: 1,
        mediaState: "ready", viewRevision: RECOGNISED.view_revision + 1,
        row: { ...RECOGNISED, id, media_state: "ready" } }]
    }
    if (call.method === "PUT") return { publicUrl: "https://cdn.invalid/image.jpg", objectKey: `${id}.jpg`, accountId: "account" }
    return { ...RECOGNISED, id }
  })
  let running: Promise<WorkflowOperationRowResult[]> | undefined
  try {
    const { runRows } = await import("./run-rows")
    running = withStubbedDevice(() => runRows({ row_ids: ids, expected_revisions: [] }, "prepare"), {}, {
      renderProduct: async () => ({
        manifest: {},
        slices: [{ index: 0, groupName: "main", fileName: "image.jpg", width: 1, height: 1, contentHash: `sha256:${SLICE_DIGEST}`, bytes: new Uint8Array([1]) }],
      }),
    })
    await renderStarted
    assert.ok(renders.includes(ids[1]), "the fast row reaches render while the first OCR is held")
    releaseOcr()
    await running
    assert.deepEqual(renders.sort(), [...ids].sort())
  } finally {
    releaseOcr()
    await running
    stub.restore()
    setCardContext({ psdTemplateSha256: "" })
  }
})

test("100-row one-click prepare never calls single-job /claim", async () => {
  setCardContext({ psdTemplateSha256: "template-sha" })
  const ids = Array.from({ length: 100 }, (_, i) => `prep-${i + 1}`)
  const stub = record((call) => {
    const id = call.url.match(/rows\/([^/]+)/)?.[1] ?? ids[0]!
    if (call.url.endsWith("/prepare")) {
      return { outcome: "running", jobs: [{
        id: `${id}-ai`, kind: "ai.recognize", idempotency_key: id,
        payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "prompt" } },
      }] }
    }
    if (call.url.endsWith("/ocr/completions")) return COMPLETION
    return { ...RECOGNISED, id }
  })
  try {
    const { runRows } = await import("./run-rows")
    const results = await withStubbedDevice(() => runRows({ row_ids: ids, expected_revisions: [] }, "prepare"))
    assert.equal(singleJobClaims(stub.calls).length, 0)
    assert.ok(windowCalls(stub.calls).length > 0)
    assert.ok(results.every((row) => row.outcome === "start" && !row.error))
  } finally {
    stub.restore()
  }
})

test("100-row recognition uses the prepare pin window", async () => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let windowReady!: () => void
  const sawWindow = new Promise<void>(resolve => { windowReady = resolve })
  const ids = Array.from({ length: 100 }, (_, i) => `capacity-${i}`)
  let running = 0
  let peak = 0
  let plans = 0
  let refused = 0
  let paid = 0
  const stub = record(async call => {
    const id = call.url.match(/rows\/([^/]+)/)?.[1] ?? ids[0]!
    if (call.url.endsWith("/prepare")) {
      if (++plans === AI_CONCURRENCY) windowReady()
      if (running >= AI_CONCURRENCY) {
        refused += 1
        return new Response(JSON.stringify({ code: "queue_busy", error: "queue busy" }), { status: 503 })
      }
      running += 1
      peak = Math.max(peak, running)
      return { outcome: "running", jobs: [{ id: `${id}-ai`, kind: "ai.recognize", idempotency_key: id,
        payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "prompt" } } }] }
    }
    if (call.url.endsWith("/ocr/completions")) { paid += 1; await held; return COMPLETION }
    if (call.url.endsWith("/ai/settle")) running -= 1
    return { ...RECOGNISED, id }
  })
  let run: Promise<WorkflowOperationRowResult[]> | undefined
  try {
    const results = await withStubbedDevice(async () => {
      const { runRows } = await import("./run-rows")
      run = runRows({ row_ids: ids, expected_revisions: [] }, "recognize")
      await sawWindow
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.deepEqual(preparedRowIds(stub.calls), ids.slice(0, AI_CONCURRENCY))
      assert.equal(refused, 0, "the local pin window prevents over-admission")
      release()
      return run
    })
    assert.equal(peak, AI_CONCURRENCY)
    assert.equal(paid, ids.length)
    assert.ok(results.every(row => !row.error && row.outcome === "start"))
  } finally { release(); await run; stub.restore() }
})

// A row whose AI leg fails never reaches the media phases of a strict

// A row whose AI leg fails never reaches the media phases of a strict

test("a stuck upload does not block recognition of a later row", async () => {
  setCardContext({ psdTemplateSha256: "template-sha" })
  const { runRows } = await import("./run-rows")
  const ids = Array.from({ length: MEDIA_CHUNK_ROWS + 1 }, (_, index) => `upload-hold-${index}`)
  const ninth = ids[AI_CONCURRENCY]!
  const last = ids[MEDIA_CHUNK_ROWS]!
  const seen = new Set<string>()
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let sawPut!: () => void
  const firstPut = new Promise<void>((resolve) => { sawPut = resolve })
  let sawLast!: () => void
  const lastOcr = new Promise<void>((resolve) => { sawLast = resolve })
  const stub = record(async (call) => {
    const id = call.url.match(/rows\/([^/]+)/)?.[1] ?? ids[0]!
    if (call.url.endsWith("/prepare")) {
      if (call.body.operation === "prepare" || call.body.operation === "recognize") return { outcome: "running", jobs: [
        { id: `${id}-ai`, kind: "ai.recognize", payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "prompt" } } },
        { id: `${id}-render`, kind: "media.render", payload: { psd_template_sha256: "template-sha" } },
      ] }
      if (call.body.operation === "slice") return { outcome: "running", jobs: [
        { id: `${id}-render`, kind: "media.render", payload: { psd_template_sha256: "template-sha" } },
      ] }
      return { outcome: "running", jobs: [{ id: `${id}-upload`, kind: "media.upload", payload: { manifest_digest: `manifest:test:${id}-render`, manifest: {} } }] }
    }
    if (call.url.endsWith("/ocr/completions")) {
      const rowId = String(call.headers["X-Listing-Job-Id"] ?? "").replace(/-ai$/, "")
      seen.add(rowId)
      if (rowId === last) sawLast()
      return COMPLETION
    }
    if (call.url.endsWith("/ai/settle")) return { ...RECOGNISED, id }
    if (call.url.endsWith("/media") && call.body.media_state === "rendered") {
      return { applied: true, row: { ...RECOGNISED, id, media_state: "rendered" }, jobs: [] }
    }
    if (call.url.endsWith("/media/images")) {
      return [{ applied: true, index: 0, phase: "public_ready", publicUrl: "https://cdn.invalid/image.jpg",
        objectKey: `${id}.jpg`, accountId: "account", storageRevision: 1, completed: 1, total: 1,
        mediaState: "ready", viewRevision: RECOGNISED.view_revision + 1,
        row: { ...RECOGNISED, id, media_state: "ready" } }]
    }
    if (call.method === "PUT") {
      sawPut()
      await held
      return { publicUrl: "https://cdn.invalid/image.jpg", objectKey: `${id}.jpg`, accountId: "account" }
    }
    return { ...RECOGNISED, id }
  })
  let running: Promise<WorkflowOperationRowResult[]> | undefined
  try {
    running = withStubbedDevice(() => runRows({ row_ids: ids, expected_revisions: [] }, "prepare"), {}, {
      renderProduct: async () => ({
        manifest: {},
        slices: [{ index: 0, groupName: "main", fileName: "image.jpg", width: 1, height: 1, contentHash: `sha256:${SLICE_DIGEST}`, bytes: new Uint8Array([1]) }],
      }),
    })
    const stalled = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("later recognition waited for the stuck upload")), 4_000)
    })
    await Promise.race([Promise.all([firstPut, lastOcr]), stalled])
    assert.equal(seen.has(ninth), true, "row 9 recognizes while earlier uploads are held")
    assert.equal(seen.has(last), true, "recognition continues past the old 64-row fence")
    release()
    assert.ok((await running).every((row) => !row.error))
  } finally {
    release()
    await running
    stub.restore()
    resetPendingUploads()
    setCardContext({ psdTemplateSha256: "" })
  }
})
