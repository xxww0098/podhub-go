/**
 * The media.render / media.upload rail: OPFS render, the static-slice cache and public confirmation.
 *
 * The renderer and OPFS are stubbed (executor-test-support): what these tests
 * are for is the wire — the route a verb takes, the pin it writes under, and
 * the shape Cloud will refuse if it drifts.
 */
import assert from "node:assert/strict"
import test from "node:test"

import type { WorkflowOperationRowResult } from "@/bindings/commands"

import { interceptMediaCompletion, json as mediaJson } from "../media/direct-media-test-fixtures"

import { configurePendingUploads, PENDING_UPLOAD_MAX_BYTES, requestStop, resetPendingUploads, setCardContext } from "./execution-context"

import { advanceBusyClock, busy, COMPLETION, FIXED_TAGS, RECOGNISED, record, ROW, SLICE_DIGEST, withStubbedDevice } from "./executor-test-support"

test("render CAS retries are bounded and report exhaustion", async () => {
  setCardContext({ psdTemplateSha256: "template-sha" })
  const stub = record(call => {
    if (call.url.endsWith("/prepare")) return { outcome: "running", jobs: [{ id: "hot-render", kind: "media.render", payload: { psd_template_sha256: "template-sha" } }] }
    if (call.url.endsWith("/media")) return { applied: false, row: ROW, jobs: [] }
    return ROW
  })
  let renders = 0
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await withStubbedDevice(() => runRows({ row_ids: ["row-1"], expected_revisions: [] }, "slice"), {}, {
      renderProduct: async () => { renders += 1; return { manifest: {}, slices: [{ index: 0, groupName: "main", fileName: "image.jpg", width: 1, height: 1, contentHash: `sha256:${SLICE_DIGEST}`, bytes: new Uint8Array([1]) }] } },
    })
    // Each bounded stage attempt rerenders and retries its CAS writeback three
    // times; exhaustion surfaces as the same stale-writeback error.
    assert.equal(renders, 3)
    assert.equal(stub.calls.filter(call => call.body?.media_state === "rendered").length, 9)
    assert.equal(result?.error?.code, "workflow_media_writeback_stale")
    assert.equal(stub.calls.some(call => call.url.endsWith("upload/claim")), false)
  } finally { stub.restore() }
})

// The pending-upload budget pauses render admission without holding a lane.
test("pending-upload backpressure pauses the next render without holding a lane", async () => {
  setCardContext({ psdTemplateSha256: "template-sha" })
  configurePendingUploads({ maxCount: 1 })
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let firstUpload!: () => void
  const sawUpload = new Promise<void>(resolve => { firstUpload = resolve })
  const renders: string[] = []
  let paid = 0
  let ocrFinished!: () => void
  const sawOcr = new Promise<void>(resolve => { ocrFinished = resolve })
  const ids = ["bp-1", "bp-2"]
  const stub = record(async call => {
    const id = call.url.match(/rows\/([^/]+)/)?.[1] ?? ids[0]!
    if (call.url.endsWith("/prepare")) {
      if (call.body?.operation === "prepare" || call.body?.operation === "recognize") {
        return { outcome: "running", jobs: [{ id: `${id}-ai`, kind: "ai.recognize",
          payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "prompt" } } },
          { id: `${id}-render`, kind: "media.render", payload: { psd_template_sha256: "template-sha" } }] }
      }
      if (call.body?.operation === "slice") {
        return { outcome: "running", jobs: [{ id: `${id}-render`, kind: "media.render", payload: { psd_template_sha256: "template-sha" } }] }
      }
      return { outcome: "prepared", jobs: [] }
    }
    if (call.url.endsWith("/ocr/completions")) { paid += 1; if (paid === 2) ocrFinished(); return COMPLETION }
    if (call.url.endsWith("/media") && call.body?.media_state === "rendered") {
      const manifest = { renderer: call.body.payload.render_evidence.manifest, images: call.body.payload.media.images }
      return { applied: true, row: { ...RECOGNISED, id }, jobs: [{ id: `${id}-upload`, kind: "media.upload",
        payload: { manifest_digest: `manifest:test:${id}-render`, manifest } }] }
    }
    if (call.method === "PUT") { firstUpload(); await held; return { byteLength: 1, publicUrl: "https://cdn.invalid/image.jpg", objectKey: "image.jpg", accountId: "account" } }
    return { ...RECOGNISED, id }
  })
  let running: Promise<WorkflowOperationRowResult[]> | undefined
  try {
    const { runRows } = await import("./run-rows")
    running = withStubbedDevice(() => runRows({ row_ids: ids, expected_revisions: [] }, "prepare"), {}, {
      renderProduct: async () => {
        renders.push(renders.length ? "bp-2" : "bp-1")
        return { manifest: {}, slices: [{ index: 0, groupName: "main", fileName: "slice-1.jpg", width: 1, height: 1, contentHash: `sha256:${SLICE_DIGEST}`, bytes: new Uint8Array([1]) }] }
      },
    })
    await sawUpload
    await sawOcr
    assert.equal(paid, 2, "OCR must not wait for upload room")
    assert.deepEqual(renders, ["bp-1"], "the second render waits without occupying a render slot")
    release()
    assert.ok((await running).every((row) => !row.error))
    assert.deepEqual(renders, ["bp-1", "bp-2"])
  } finally {
    release()
    await running
    stub.restore()
    resetPendingUploads()
    configurePendingUploads({ maxCount: 8, maxBytes: 256 * 1024 * 1024 })
  }
})

test("render-only rows finish while a prepare upload holds more than the pending budget", async () => {
  setCardContext({ psdTemplateSha256: "template-sha" })
  configurePendingUploads({ maxCount: 8, maxBytes: PENDING_UPLOAD_MAX_BYTES })
  let releaseUpload!: () => void
  const heldUpload = new Promise<void>(resolve => { releaseUpload = resolve })
  let uploadStarted!: () => void
  const sawUpload = new Promise<void>(resolve => { uploadStarted = resolve })
  const oversizedImage = {
    index: 0,
    file_name: "slice-1.jpg",
    content_hash: `sha256:${SLICE_DIGEST}`,
    group_name: "主图",
    width: 900,
    height: 1200,
    byte_size: PENDING_UPLOAD_MAX_BYTES + 1,
    phase: "rendered",
  }
  const renderedRows = new Set<string>()
  const stub = record(async call => {
    const id = call.url.match(/rows\/([^/]+)/)?.[1] ?? "unknown"
    if (call.url.endsWith("/prepare")) {
      if (call.body?.operation === "prepare" && id === "holder") {
        return { outcome: "running", jobs: [{ id: "holder-render", kind: "media.render", payload: { psd_template_sha256: "template-sha" } }] }
      }
      if (call.body?.operation === "slice") {
        return { outcome: "running", jobs: [{ id: `${id}-render`, kind: "media.render", payload: { psd_template_sha256: "template-sha" } }] }
      }
    }
    if (call.url.endsWith("/media") && call.body?.media_state === "rendered") {
      renderedRows.add(id)
      if (id === "holder") {
        return {
          applied: true,
          row: { ...RECOGNISED, id, media_state: "rendered", media: { images: [oversizedImage], videos: [] } },
          jobs: [{ id: "holder-upload", kind: "media.upload", payload: {
            manifest_digest: "manifest:holder",
            manifest: { images: [{ ...oversizedImage, byte_size: 1 }] },
          } }],
        }
      }
      return { applied: true, row: { ...RECOGNISED, id, media_state: "rendered" }, jobs: [] }
    }
    if (call.method === "PUT") {
      uploadStarted()
      await heldUpload
      return { byteLength: 1, publicUrl: "https://cdn.invalid/holder.jpg", objectKey: "holder.jpg", accountId: "acct" }
    }
    return { ...RECOGNISED, id }
  })
  let holder: Promise<WorkflowOperationRowResult[]> | undefined
  let renderOnly: Promise<WorkflowOperationRowResult[]> | undefined
  try {
    const { runRows } = await import("./run-rows")
    await withStubbedDevice(async () => {
      holder = runRows({ row_ids: ["holder"], expected_revisions: [] }, "prepare")
      await sawUpload
      renderOnly = runRows({ row_ids: ["slice-1", "slice-2"], expected_revisions: [] }, "slice")
      const results = await Promise.race([
        renderOnly,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("render-only batch waited on upload budget")), 500)),
      ])
      assert.equal(results.length, 2)
      assert.ok(results.every(result => !result.error), "render-only rows must not fail behind upload backpressure")
      assert.deepEqual([...renderedRows].sort(), ["holder", "slice-1", "slice-2"])
    }).finally(async () => {
      releaseUpload()
      await Promise.allSettled([holder, renderOnly].filter((run): run is Promise<WorkflowOperationRowResult[]> => Boolean(run)))
    })
  } finally {
    releaseUpload()
    await Promise.allSettled([holder, renderOnly].filter((run): run is Promise<WorkflowOperationRowResult[]> => Boolean(run)))
    stub.restore()
    resetPendingUploads()
    configurePendingUploads({ maxCount: 8, maxBytes: 256 * 1024 * 1024 })
    setCardContext({ psdTemplateSha256: "" })
  }
})

test("OCR and render stay committed when throttled uncertain upload recovers into upload only", async (t) => {
  setCardContext({ psdTemplateSha256: "template-sha" })
  const { sha256Hex } = await import("@/render/opfs")
  const keepBytes = new Uint8Array([10])
  const keepHash = await sha256Hex(keepBytes)
  const wrongHash = await sha256Hex(new Uint8Array([20]))
  const keepImage = {
    index: 0, file_name: "slice-1.jpg", content_hash: `sha256:${keepHash}`,
    group_name: "main", width: 1, height: 1, byte_size: 1, phase: "rendered",
  }
  const keepPin = { manifest_digest: "manifest:test:job-render-keep", manifest: { images: [keepImage] } }
  const wrongPin = {
    manifest_digest: "manifest:other-row",
    manifest: { images: [{ ...keepImage, content_hash: `sha256:${wrongHash}`, file_name: "other.jpg" }] },
  }
  let puts = 0
  let renders = 0
  const drops: string[] = []
  // Recovery plans below deliberately pin the wrong manifest; exhausted direct
  // recovery itself must never mint another automatic upload-stage attempt.
  let uploadPlans = 0
  let online = false
  let wrongRecoveryPlans = false
  const stub = record((call) => {
    if (call.url.endsWith("/prepare")) {
      const operation = call.body?.operation
      if (operation === "prepare" && stub.calls.some((seen) => seen.url.endsWith("/media") && seen.body?.media_state === "rendered")) {
        if (!wrongRecoveryPlans) {
          uploadPlans = 3
          wrongRecoveryPlans = true
        }
        return { outcome: "running", jobs: [{ id: "job-upload-wrong", kind: "media.upload", payload: wrongPin }] }
      }
      if (operation === "prepare" || operation === "recognize") return { outcome: "running", jobs: [
        { id: "job-ai-keep", kind: "ai.recognize", idempotency_key: "ocr:keep",
          payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "识图提示词" } } },
        { id: "job-render-keep", kind: "media.render", payload: { psd_template_sha256: "template-sha" } },
      ] }
      if (operation === "upload") {
        uploadPlans += 1
        const wrong = uploadPlans >= 4 && uploadPlans <= 9
        return { outcome: "running", jobs: [{
          id: wrong ? `job-upload-wrong-${uploadPlans}` : "job-upload-keep",
          kind: "media.upload",
          payload: wrong ? wrongPin : keepPin,
        }] }
      }
      return { outcome: "prepared", jobs: [] }
    }
    if (call.url.endsWith("/ocr/completions")) return COMPLETION
    if (call.url.endsWith("/ai/settle")) return RECOGNISED
    if (call.url.endsWith("/media")) return { applied: true, row: RECOGNISED, jobs: [] }
    if (call.method === "PUT") {
      puts += 1
      assert.notEqual(new URL(call.url).pathname.split("/").at(-1)!.split(".")[0], wrongHash, "recovery must not reuse another row's list")
      if (!online) {
        if (puts === 1) return busy(429, "存储上传拥堵，请稍后重试")
        throw Object.assign(new TypeError("Failed to fetch"), { code: "UND_ERR_CONNECT_TIMEOUT" })
      }
      return { byteLength: 1, publicUrl: "https://cdn.invalid/keep.jpg", objectKey: "keep.jpg", accountId: "acct" }
    }
    return RECOGNISED
  })
  interceptMediaCompletion(() => !online ? mediaJson({}, 404) : undefined)
  try {
    const { runRows } = await import("./run-rows")
    const execute = (verb: "prepare" | "upload") => advanceBusyClock(t, () => withStubbedDevice(
      () => runRows({ row_ids: [ROW.id], expected_revisions: [] }, verb),
      { getRender: async () => keepBytes, dropRender: async (rowId: string) => { drops.push(rowId) } },
      {
        renderProduct: async () => {
          renders += 1
          return {
            manifest: {},
            slices: [{
              index: 0, groupName: "main", fileName: "slice-1.jpg", width: 1, height: 1,
              contentHash: `sha256:${keepHash}`, bytes: keepBytes,
            }],
          }
        },
      },
    ))
    // OCR/render remain committed while at most two reconciled direct PUTs
    // fail: storage cooldown then disconnect. Only explicit absence permits renewal.
    const first = await execute("prepare")
    assert.ok(first[0]!.error, "a disconnected upload exhausts its bounded retries")
    assert.ok(stub.calls.some((call) => call.url.endsWith("/media") && call.body?.media_state === "rendered"))
    assert.equal(stub.calls.filter((call) => call.url.endsWith("/ocr/completions")).length, 1)
    assert.equal(renders, 1)
    assert.equal(puts, 2)
    assert.equal(uploadPlans, 0, "direct exhaustion must not mint an automatic upload plan")
    assert.deepEqual(drops, [], "upload failure retains the committed local slices")
    // A fresh prepare never re-buys OCR or re-renders; a Job pinned to another
    // row's manifest is refused before any PUT, on every attempt.
    const wrongList = await execute("prepare")
    assert.equal(wrongList[0]!.error?.code, "workflow_media_manifest_changed")
    assert.equal(puts, 2, "a wrong list must not start another PUT")
    assert.equal(stub.calls.filter((call) => call.url.endsWith("/ocr/completions")).length, 1, "recovery must not double-purchase OCR")
    assert.equal(renders, 1, "still-valid slices must not be rendered again")
    const stillWrong = await execute("prepare")
    assert.equal(stillWrong[0]!.error?.code, "workflow_media_manifest_changed")
    online = true
    const recovered = await execute("upload")
    assert.equal(recovered[0]!.error, undefined)
    assert.equal(stub.calls.filter((call) => call.url.endsWith("/ocr/completions")).length, 1)
    assert.equal(renders, 1)
    const writeback = stub.calls.find((call) => call.url.endsWith("/media/images"))!.body
    assert.equal(writeback.job_id, "job-upload-keep")
    const confirmation = stub.calls.filter(call => call.url.endsWith("/complete-batch")).at(-1)!.body.objects[0]
    assert.equal(writeback.images[0].object_key, confirmation.object_key)
    assert.equal(stub.calls.filter((call) => call.body?.media_state === "rendered").length, 1, "stale fingerprint must not write back a second render")
  } finally {
    stub.restore()
    setCardContext({ psdTemplateSha256: "" })
  }
})

test("stop while pending-upload is full leaves unstarted renders cancelled without wiping the other batch", async () => {
  setCardContext({ psdTemplateSha256: "template-sha" })
  configurePendingUploads({ maxCount: 1 })
  let releaseUpload!: () => void
  const heldUpload = new Promise<void>((resolve) => { releaseUpload = resolve })
  let uploading!: () => void
  const sawUpload = new Promise<void>((resolve) => { uploading = resolve })
  let planned!: () => void
  const sawWaiterPlan = new Promise<void>((resolve) => { planned = resolve })
  let ocrFinished!: () => void
  const sawOcr = new Promise<void>(resolve => { ocrFinished = resolve })
  const renders: string[] = []
  const drops: string[] = []
  const disposed: string[] = []
  const stub = record(async (call) => {
    const id = call.url.match(/rows\/([^/]+)/)?.[1] ?? "held"
    if (call.url.endsWith("/prepare")) {
      if (id === "waiter") {
        planned()
        return { outcome: "running", jobs: [{ id: "waiter-render", kind: "media.render", payload: { psd_template_sha256: "template-sha" } }] }
      }
      if (call.body?.operation === "prepare" || call.body?.operation === "recognize") {
        return { outcome: "running", jobs: [{ id: `${id}-ai`, kind: "ai.recognize",
          payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "prompt" } } },
          { id: `${id}-render`, kind: "media.render", payload: { psd_template_sha256: "template-sha" } }] }
      }
      if (call.body?.operation === "slice") {
        return { outcome: "running", jobs: [{ id: `${id}-render`, kind: "media.render", payload: { psd_template_sha256: "template-sha" } }] }
      }
      return { outcome: "prepared", jobs: [] }
    }
    if (call.url.endsWith("/ocr/completions")) { ocrFinished(); return COMPLETION }
    if (call.url.endsWith("/media") && call.body?.media_state === "rendered") {
      // The rendered write enqueues the follow-up upload Job, which holds the
      // pending-upload slot through its own PUT.
      const manifest = { renderer: call.body.payload.render_evidence.manifest, images: call.body.payload.media.images }
      return { applied: true, row: { ...RECOGNISED, id, mediaState: "rendered" },
        jobs: [{ id: `${id}-upload`, kind: "media.upload", payload: { manifest_digest: `manifest:test:${id}-render`, manifest } }] }
    }
    if (call.url.endsWith("/media")) return { applied: true, row: { ...RECOGNISED, id }, jobs: [] }
    if (call.method === "PUT") {
      uploading()
      await heldUpload
      return { byteLength: 1, publicUrl: "https://cdn.invalid/held.jpg", objectKey: "held.jpg", accountId: "acct" }
    }
    return { ...RECOGNISED, id }
  })
  try {
    const { runRows } = await import("./run-rows")
    await withStubbedDevice(async () => {
      const holder = runRows({ row_ids: ["held"], expected_revisions: [] }, "prepare")
      await sawUpload
      await sawOcr
      const waiter = runRows({ row_ids: ["waiter"], expected_revisions: [] }, "prepare")
      await sawWaiterPlan
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.deepEqual(renders, ["held"])
      const beforeWaiterEnd = disposed.length
      requestStop(["waiter"])
      const [result] = await Promise.race([
        waiter,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("pending-upload wait did not exit after stop")), 250)),
      ])
      assert.equal(result?.noop_reason, "cancelled")
      assert.deepEqual(renders, ["held"])
      assert.equal(stub.calls.some((call) => call.url.includes("waiter") && call.method === "PUT"), false)
      assert.equal(stub.calls.filter((call) => call.url.endsWith("/ocr/completions")).length, 1)
      assert.equal(drops.includes("held"), false, "stop must not wipe the other batch's OPFS")
      assert.equal(disposed.length, beforeWaiterEnd + 1, "only the stopped batch's Workers are torn down")
      releaseUpload()
      assert.ok((await holder).every((row) => !row.error))
    }, { dropRender: async (rowId: string) => { drops.push(rowId) } }, {
      renderProduct: async () => {
        const row = renders.length ? "waiter" : "held"
        renders.push(row)
        if (row === "waiter") throw new Error("stopped waiter must not start render")
        return {
          manifest: {},
          slices: [{
            index: 0, groupName: "main", fileName: "slice-1.jpg", width: 1, height: 1,
            contentHash: `sha256:${SLICE_DIGEST}`, bytes: new Uint8Array([1]),
          }],
        }
      },
      dispose: () => { disposed.push("batch") },
    })
  } finally {
    releaseUpload()
    stub.restore()
    resetPendingUploads()
    configurePendingUploads({ maxCount: 8, maxBytes: 256 * 1024 * 1024 })
    setCardContext({ psdTemplateSha256: "" })
  }
})

test("a busy receipt write cannot replenish an exhausted peer's direct PUT budget", async context => {
  const { forgetMediaObjects } = await import("../media/media-objects")
  forgetMediaObjects()
  const { sha256Hex } = await import("@/render/opfs")
  const hashes = [SLICE_DIGEST, await sha256Hex(new Uint8Array([2]))]
  const images = hashes.map((hash, index) => ({ index, file_name: `mixed-${index}.jpg`, content_hash: `sha256:${hash}`, group_name: "main", width: 1, height: 1, byte_size: 1, phase: "rendered" }))
  const row = { ...ROW, media_state: "rendered", media: { images, videos: [] }, render_evidence: { manifest_digest: "mixed" } }
  const puts = [0, 0]
  const stub = record(call => {
    if (call.url.endsWith("/prepare")) return { outcome: "running", jobs: [{ id: "mixed-upload", kind: "media.upload", payload: { manifest_digest: "mixed", manifest: { images } } }] }
    if (call.method === "PUT") {
      const index = hashes.indexOf(new URL(call.url).pathname.split("/").at(-1)!.split(".")[0]!)
      puts[index]! += 1
      if (index === 0) throw new TypeError("offline")
      return {}
    }
    if (call.url.endsWith("/media/images")) return busy(429, "receipt storage busy")
    if (call.url.endsWith("/media")) return { applied: true, row, jobs: [] }
    return row
  })
  interceptMediaCompletion((_body, url) => url.includes(SLICE_DIGEST) ? mediaJson({}, 404) : undefined)
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await advanceBusyClock(context, () => withStubbedDevice(() => runRows({ row_ids: [ROW.id], expected_revisions: [] }, "upload"), {
      getRender: async (_row: string, file: string) => new Uint8Array([file === "mixed-0.jpg" ? 1 : 2]),
    }))
    assert.equal(result?.error?.code, "media_complete_missing_after_retry")
    assert.deepEqual(puts, [2, 1], "receipt congestion cannot start another pair for the failed peer")
    assert.equal(stub.calls.filter(call => call.url.endsWith("/prepare")).length, 1)
  } finally { stub.restore() }
})
