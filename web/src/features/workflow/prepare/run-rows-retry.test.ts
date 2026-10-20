/** Rail independence, bounded retry and post-OCR media dependencies.
 * Tests cross the runRows interface; HTTP, OPFS and rendering use the existing recorded adapters.
 */
import assert from "node:assert/strict"
import test from "node:test"
import type { WorkflowOperationRowResult } from "@/bindings/commands"
import { AI_CONCURRENCY } from "./ai-job"
import { requestStop, setCardContext } from "./execution-context"
import {
  COMPLETION,
  FIXED_TAGS,
  grantedClaim,
  RECOGNISED,
  record,
  ROW,
  SLICE_DIGEST,
  windowJobIds,
  withStubbedDevice,
} from "./executor-test-support"

for (const local of [false, true]) test(`${local ? "preprocessing" : "OCR"} failure does not cancel the media rail`, async () => {
  setCardContext({ psdTemplateSha256: "template-sha" })
  const stub = record(call => {
    if (call.url.endsWith("/prepare")) return { outcome: "running", jobs: [
      { id: "independent-ai", kind: "ai.recognize", payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "prompt" } } },
      { id: "independent-render", kind: "media.render", payload: { psd_template_sha256: "template-sha" } },
    ] }
    if (call.url.endsWith("/ocr/completions")) return new Response(JSON.stringify({ error: "AI unavailable", code: "validation" }), { status: 400 })
    if (call.method === "PUT") return { byteLength: 1, publicUrl: "https://cdn.invalid/image.jpg", objectKey: "image.jpg", accountId: "account" }
    if (call.url.endsWith("/media")) return { applied: true, row: ROW, jobs: [] }
    return ROW
  })
  try {
    const { runRows } = await import("./run-rows")
    const results = await withStubbedDevice(() => runRows({ row_ids: [ROW.id], expected_revisions: [] }, "prepare"), {},
      local ? { prepareAiImage: async () => { throw new Error("bad local image") } } : {})
    assert.ok(results[0]!.error)
    assert.equal(stub.calls.filter(call => call.url.endsWith("/ai/fail")).length, 3, "each failed attempt retires its Job")
    if (local) assert.equal(stub.calls.some(call => call.url.endsWith("/ocr/completions")), false)
    assert.equal(stub.calls.filter(call => call.url.endsWith("/media") && call.body.media_state === "rendered").length, 1)
    assert.equal(stub.calls.filter(call => /media\/images(?:\/|$)/.test(call.url)).length, 1, "media finishes independently of OCR")
  } finally { stub.restore() }
})

// The idempotent replan returns the same Job, now dead: the claim-window
// refuses it forever, so the retry loop must end the row with the error that
// failed the purchase — not spin on "准备作业已结束".
test("a purchase refusal ends the row instead of replanning the dead Job forever", async () => {
  const job = { id: "dead-job", kind: "ai.recognize", idempotency_key: "key", payload: {
    source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "prompt" },
  } }
  let plans = 0
  let ocr = 0
  let claims = 0
  const stub = record((call) => {
    if (call.url.endsWith("/prepare")) {
      plans += 1
      return { outcome: "running", jobs: [{ ...job, state: plans === 1 ? "queued" : "failed" }] }
    }
    if (call.url.endsWith("/ocr/completions")) {
      ocr += 1
      return new Response(
        JSON.stringify({ error: "钱包余额不足：可用 0 microfen，本次需要预占 50000000 microfen", code: "INSUFFICIENT_BALANCE" }),
        { status: 402 },
      )
    }
    if (call.url.endsWith("/ai/fail")) return { jobs: [] }
    return ROW
  }, (claimed) => {
    claims += 1
    if (claims === 1) return grantedClaim(claimed)
    if (claims > 8) requestStop([ROW.id])
    return null
  })
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await withStubbedDevice(() => runRows({ row_ids: [ROW.id], expected_revisions: [] }, "recognize"))
    assert.equal(result?.error?.code, "cloud_insufficient_balance", "the row reports the purchase refusal, not the dead-Job symptom")
    assert.equal(ocr, 1)
    assert.equal(claims, 2)
    assert.equal(plans, 2)
    assert.equal(stub.calls.filter((call) => call.url.endsWith("/ai/fail")).length, 1)
  } finally {
    stub.restore()
  }
})

test("a held render keeps its runtime while AI finishes independently", async () => {
  setCardContext({ psdTemplateSha256: "template-sha" })
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let allRecognized!: () => void
  const progressed = new Promise<void>(resolve => { allRecognized = resolve })
  let paid = 0
  let disposals = 0
  const ids = Array.from({ length: AI_CONCURRENCY }, (_, i) => `independent-${i}`)
  const stub = record(call => {
    const id = call.url.match(/rows\/([^/]+)/)?.[1] ?? ids[0]!
    if (call.url.endsWith("/prepare")) return { outcome: "running", jobs: [
      { id: `${id}-ai`, kind: "ai.recognize", payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "prompt" } } },
      { id: `${id}-render`, kind: "media.render", payload: { psd_template_sha256: "template-sha" } },
    ] }
    if (call.url.endsWith("/ocr/completions")) {
      if (++paid === AI_CONCURRENCY) allRecognized()
      return COMPLETION
    }
    if (call.url.endsWith("/media")) return { applied: true, row: { ...RECOGNISED, id }, jobs: [] }
    if (call.method === "PUT") return { byteLength: 1, publicUrl: "https://cdn.invalid/image.jpg", objectKey: "image.jpg", accountId: "account" }
    return { ...RECOGNISED, id }
  })
  let running: Promise<WorkflowOperationRowResult[]> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    const { runRows } = await import("./run-rows")
    running = withStubbedDevice(() => runRows({ row_ids: ids, expected_revisions: [] }, "prepare"), {}, {
      disposeRender: () => { disposals += 1 },
      renderProduct: async () => {
        await held
        assert.equal(disposals, 0, "AI completion must not dispose the rendering runtime")
        return { manifest: {}, slices: [{ index: 0, groupName: "main", fileName: "image.jpg", width: 1, height: 1, contentHash: `sha256:${SLICE_DIGEST}`, bytes: new Uint8Array([1]) }] }
      },
    })
    await Promise.race([progressed, new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error("AI slots are held by media")), 1000)
    })])
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(paid, AI_CONCURRENCY)
    assert.equal(disposals, 0)
  } finally {
    if (deadline) clearTimeout(deadline)
    release()
    await running
    stub.restore()
  }
  assert.equal(disposals, 1)
})

test("prepare retains the last render holder through retry after AI finishes", async () => {
  setCardContext({ psdTemplateSha256: "template-sha" })
  let aiFinished!: () => void
  const recognized = new Promise<void>(resolve => { aiFinished = resolve })
  let renders = 0
  let disposals = 0
  const renderJob = { id: "retry-render", kind: "media.render", payload: { psd_template_sha256: "template-sha" } }
  const stub = record(call => {
    if (call.url.endsWith("/prepare")) return { outcome: "running", jobs: call.body.operation === "prepare" ? [
      { id: "retry-ai", kind: "ai.recognize", payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "prompt" } } },
      renderJob,
    ] : [renderJob] }
    if (call.url.endsWith("/ocr/completions")) return COMPLETION
    if (call.url.endsWith("/ai/settle")) { aiFinished(); return RECOGNISED }
    if (call.url.endsWith("/media")) return { applied: true, row: RECOGNISED, jobs: call.body.media_state === "rendered" ? [{
      id: "retry-upload", kind: "media.upload", payload: {
        manifest_digest: "manifest:test:retry-render",
        manifest: { renderer: call.body.payload.render_evidence.manifest, images: call.body.payload.media.images },
      },
    }] : [] }
    if (call.method === "PUT") return { byteLength: 1, publicUrl: "https://cdn.invalid/image.jpg", objectKey: "image.jpg", accountId: "account" }
    return RECOGNISED
  })
  try {
    const { runRows } = await import("./run-rows")
    const results = await withStubbedDevice(() => runRows({ row_ids: [ROW.id], expected_revisions: [] }, "prepare"), {}, {
      disposeRender: () => { disposals += 1 },
      renderProduct: async () => {
        await recognized
        await new Promise<void>(resolve => setImmediate(resolve))
        assert.equal(disposals, 0, "neither AI completion nor a render retry may release the holder")
        if (++renders === 1) throw new Error("transient render failure")
        return { manifest: {}, slices: [{ index: 0, groupName: "main", fileName: "image.jpg", width: 1, height: 1, contentHash: `sha256:${SLICE_DIGEST}`, bytes: new Uint8Array([1]) }] }
      },
    })
    assert.equal(renders, 2)
    assert.equal(disposals, 1)
    assert.ok(results.every(row => !row.error))
    assert.equal(stub.calls.filter(call => /media\/images(?:\/|$)/.test(call.url)).length, 1)
  } finally { stub.restore() }
})

test("a failed AI row replans only its own rail while render continues", async () => {
  setCardContext({ psdTemplateSha256: "template-sha" })
  const stub = record(call => {
    if (call.url.endsWith("/prepare")) {
      return call.body.operation === "recognize" || call.body.operation === "prepare"
        ? { outcome: "running", jobs: [
          { id: "failed-ai", kind: "ai.recognize", payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "prompt" } } },
          { id: "independent-render", kind: "media.render", payload: { psd_template_sha256: "template-sha" } },
        ] }
        : { outcome: "prepared", jobs: [] }
    }
    if (call.url.endsWith("/ocr/completions")) return new Response(JSON.stringify({ code: "validation", error: "AI unavailable" }), { status: 400 })
    if (call.url.endsWith("/media")) return { applied: true, row: ROW, jobs: [] }
    if (call.method === "PUT") return { objectKey: "image.jpg", publicUrl: "https://cdn.invalid/image.jpg", accountId: "account" }
    return ROW
  })
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await withStubbedDevice(() => runRows({ row_ids: ["row-1"], expected_revisions: [] }, "prepare"))
    assert.deepEqual(
      stub.calls.filter(call => call.url.endsWith("/prepare")).map(call => call.body.operation),
      ["prepare", "recognize", "recognize"],
      "bounded retries replan the failed rail only",
    )
    assert.equal(stub.calls.filter(call => call.url.endsWith("/ocr/completions")).length, 3)
    assert.equal(stub.calls.filter(call => call.url.endsWith("/media") && call.body.media_state === "rendered").length, 1)
    assert.equal(stub.calls.filter(call => call.method === "PUT" && call.url.includes("/media/")).length, 1)
    assert.match(result?.error?.message ?? "", /AI unavailable/)
  } finally { stub.restore() }
})

for (const mode of ["direct", "deferred upload", "external OCR"] as const) {
test(`prepare replans upload after OCR with prepared slices: ${mode}`, async () => {
  const rendered = {
    ...ROW,
    media_state: "rendered",
    media: { images: [{ index: 0, file_name: "slice-1.jpg", content_hash: `sha256:${SLICE_DIGEST}`, group_name: "main", width: 1, height: 1, byte_size: 1, phase: "rendered" }], videos: [] },
    render_evidence: { manifest_digest: "manifest:split", manifest: { images: [{ index: 0, file_name: "slice-1.jpg", content_hash: `sha256:${SLICE_DIGEST}`, group_name: "main", width: 1, height: 1, byte_size: 1, phase: "rendered" }] } },
  }
  let plans = 0
  let renders = 0
  const stub = record(call => {
    if (call.url.endsWith("/prepare")) {
      plans += 1
      if (plans === 1) return { outcome: "running", jobs: [{ id: "split-ai", state: mode === "external OCR" ? "succeeded" : "queued", kind: "ai.recognize", idempotency_key: "split-ocr", payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "prompt" } } }] }
      if (mode === "deferred upload" && plans === 2) return { outcome: "running", jobs: [], issues: [{ kind: "media.upload", blockers: [], message: "capacity busy" }] }
      return { outcome: "running", jobs: [{ id: "split-upload", kind: "media.upload", payload: { manifest_digest: "manifest:split", manifest: { images: rendered.media.images } } }] }
    }
    if (call.url.endsWith("/ocr/completions")) return COMPLETION
    if (call.url.endsWith("/ai/settle")) return { ...RECOGNISED, media_state: "rendered", media: rendered.media, render_evidence: rendered.render_evidence }
    if (call.method === "PUT") return { byteLength: 1, publicUrl: "https://cdn.invalid/slice.jpg", objectKey: "slice.jpg", accountId: "acct" }
    if (call.url.endsWith("/media/images")) return { items: [{ applied: true, index: 0, phase: "public_ready",
      public_url: "https://cdn.invalid/slice.jpg", object_key: "slice.jpg", account_id: "acct",
      storage_revision: 1, completed: 1, total: 1, media_state: "ready",
      row: { ...rendered, media_state: "ready" } }], total: 1 }
    return mode === "external OCR" ? { ...RECOGNISED, media_state: "rendered", media: rendered.media, render_evidence: rendered.render_evidence } : rendered
  }, job => mode === "external OCR" && job.id === "split-ai" ? null : grantedClaim(job))
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await withStubbedDevice(() => runRows({ row_ids: [ROW.id], expected_revisions: [] }, "prepare"), {
      getRender: async () => new Uint8Array([1]),
    }, {
      renderProduct: async () => { renders += 1; throw new Error("already-rendered row must not render") },
    })
    assert.equal(result?.error, undefined)
    assert.equal(plans, mode === "deferred upload" ? 3 : 2, "OCR completion gets a fresh authoritative plan")
    assert.equal(stub.calls.filter(call => call.method === "PUT" && call.url.includes("/media/")).length, 1)
    assert.equal(stub.calls.filter(call => call.url.endsWith("/ocr/completions")).length, mode === "external OCR" ? 0 : 1)
    assert.equal(renders, 0, "already-rendered media skips the render rail")
    assert.deepEqual(windowJobIds(stub.calls), ["split-ai"])
    const prepareCalls = stub.calls.filter(call => call.url.endsWith("/prepare"))
    assert.deepEqual(prepareCalls.map(call => call.body.operation), mode === "deferred upload" ? ["prepare", "prepare", "upload"] : ["prepare", "prepare"])
    assert.notEqual(prepareCalls[0]?.body.command_id, prepareCalls[1]?.body.command_id)
  } finally { stub.restore() }
})
}

test("deferred OCR keeps the render worker alive for deferred follow-up slicing", async () => {
  setCardContext({ psdTemplateSha256: "template-sha" })
  let plans = 0
  let disposals = 0
  let renders = 0
  const stub = record(call => {
    if (call.url.endsWith("/prepare")) {
      plans += 1
      if (plans === 1) return { outcome: "running", jobs: [], issues: [{ kind: "ai.recognize", blockers: [], message: "capacity busy" }] }
      if (plans === 2) return { outcome: "running", jobs: [{ id: "deferred-ai", kind: "ai.recognize", payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "prompt" } } }] }
      if (plans === 3) return { outcome: "running", jobs: [], issues: [{ kind: "media.render", blockers: [], message: "capacity busy" }] }
      return { outcome: "running", jobs: [{ id: "deferred-render", kind: "media.render", payload: { psd_template_sha256: "template-sha" } }] }
    }
    if (call.url.endsWith("/ocr/completions")) return COMPLETION
    if (call.url.endsWith("/media")) return { applied: true, row: RECOGNISED, jobs: [{
      id: "deferred-upload", kind: "media.upload", payload: {
        manifest_digest: "manifest:test:deferred-render",
        manifest: { renderer: call.body.payload.render_evidence.manifest, images: call.body.payload.media.images },
      },
    }] }
    if (call.method === "PUT") return { byteLength: 1, publicUrl: "https://cdn.invalid/image.jpg", objectKey: "image.jpg", accountId: "account" }
    return RECOGNISED
  })
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await withStubbedDevice(() => runRows({ row_ids: [ROW.id], expected_revisions: [] }, "prepare"), {}, {
      disposeRender: () => { disposals += 1 },
      renderProduct: async () => {
        assert.equal(disposals, 0, "deferred OCR must retain the render holder")
        renders += 1
        return { manifest: {}, slices: [{ index: 0, groupName: "main", fileName: "image.jpg", width: 1, height: 1, contentHash: `sha256:${SLICE_DIGEST}`, bytes: new Uint8Array([1]) }] }
      },
    })
    assert.equal(result?.error, undefined)
    assert.equal(renders, 1)
    assert.equal(disposals, 1)
    assert.deepEqual(stub.calls.filter(call => call.url.endsWith("/prepare")).map(call => call.body.operation), ["prepare", "recognize", "prepare", "slice"])
    assert.deepEqual(windowJobIds(stub.calls), ["deferred-ai"])
    assert.equal(stub.calls.filter(call => call.method === "PUT" && call.url.includes("/media/")).length, 1)
  } finally { stub.restore() }
})

test("a failed post-OCR prepare plan is reported without retrying OCR", async () => {
  let plans = 0
  const stub = record(call => {
    if (call.url.endsWith("/prepare")) {
      plans += 1
      if (plans === 1) return { outcome: "running", jobs: [{ id: "replan-ai", kind: "ai.recognize", idempotency_key: "replan-ocr", payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "prompt" } } }] }
      return new Response(JSON.stringify({ code: "replan_failed", error: "cannot replan" }), { status: 500 })
    }
    if (call.url.endsWith("/ocr/completions")) return COMPLETION
    if (call.url.endsWith("/ai/settle")) return RECOGNISED
    return ROW
  })
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await withStubbedDevice(() => runRows({ row_ids: [ROW.id], expected_revisions: [] }, "prepare"))
    assert.equal(plans, 2)
    assert.equal(stub.calls.filter(call => call.url.endsWith("/ocr/completions")).length, 1)
    assert.equal(result?.error?.code, "cloud_replan_failed")
  } finally { stub.restore() }
})
