/** OCR input: pinned sources, private staging, and released memory. */
import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"

import {
  analyzeImageBody,
} from "./ai-job"
import {
  advanceBusyClock,
  captureLog,
  COMPLETION,
  FIXED_TAGS,
  grantedClaim,
  RECOGNISED,
  ROW,
  windowJobIds,
  withStubbedDevice,
} from "./executor-test-support"
import { record } from "./ai-job-test-support"
import { prepareOcrImage, OCR_MAX_IMAGE_BYTES } from "./ocr-upload"

test("the paid OCR body carries only a private prepared-image ticket", () => {
  assert.deepEqual(analyzeImageBody("private-ticket"), { uploadTicket: "private-ticket" })
})

test("an oversized OCR raster is refused before grant or purchase", () => {
  assert.throws(() => prepareOcrImage(new Uint8Array(OCR_MAX_IMAGE_BYTES + 1)), /图片超过大小上限/)
})

for (const sourceProblem of ["changed", "missing"] as const) test(`recognition refuses a ${sourceProblem} source before buying OCR and keeps valid results`, async () => {
  const stub = record((call) => {
    if (call.url.endsWith("/prepare")) return {
      outcome: "waiting",
      jobs: [{ id: "job-old", kind: "ai.recognize", idempotency_key: "old-source-purchase", payload: {
        source_sha256: sourceProblem === "changed" ? "old-source" : ROW.source.sha256,
        recognition_prompt: { fixed_tags: FIXED_TAGS, content: "固定提示词" },
      } }],
    }
    if (call.url.endsWith("/ocr/completions")) return COMPLETION
    return RECOGNISED
  })
  let images = 0
  let renders = 0
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await withStubbedDevice(
      () => runRows({ row_ids: [ROW.id], expected_revisions: [{ row_id: ROW.id, revision: ROW.revision }] }, "recognize"),
      sourceProblem === "missing" ? { getSource: async () => null } : {},
      {
        prepareAiImage: async () => { images += 1; throw new Error("invalid source must not be processed") },
        renderProduct: async () => { renders += 1; throw new Error("recognition must not render") },
      },
    )
    assert.equal(result?.error?.code, `workflow_source_${sourceProblem}`)
    assert.match(result!.error!.message, sourceProblem === "missing" ? /重新导入/ : /重新准备/)
    assert.equal(images, 0)
    assert.equal(renders, 0)
    assert.equal(stub.calls.filter((call) => call.method === "PUT").length, 0)
    assert.equal(stub.calls.filter((call) => call.url.endsWith("/ocr/completions")).length, 0)
    assert.equal(stub.calls.filter((call) => call.url.endsWith("/ai/settle")).length, 0)
    assert.deepEqual(result!.product?.draft, RECOGNISED.draft)
    assert.deepEqual(result!.product?.lifecycle.ai_summary?.tags, RECOGNISED.ai.summary.tags)
  } finally {
    stub.restore()
  }
})

test("PNG recognition labels passthrough PNG and converted JPEG using the prepared bytes", async () => {
  const png = new Uint8Array(readFileSync(new URL("../../../../../fixtures/psd/synthetic/replacement-transparent-edges.png", import.meta.url)))
  for (const [prepared, mimeType] of [[png, "image/png"], [new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg"]] as const) {
    const stub = record(call => {
      if (call.url.endsWith("/prepare")) return { outcome: "running", jobs: [{
        id: "png-job", kind: "ai.recognize", idempotency_key: "png-recognition", payload: {
          source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "识图提示词" },
        },
      }] }
      if (call.url.endsWith("/ocr/completions")) return COMPLETION
      if (call.url.endsWith("/ai/settle")) return RECOGNISED
      return { ...ROW, source: { ...ROW.source, fileName: "design.png" } }
    })
    try {
      const { runRows } = await import("./run-rows")
      await withStubbedDevice(() => runRows({ row_ids: [ROW.id], expected_revisions: [] }, "recognize"),
        { getSource: async () => png }, { prepareAiImage: async () => prepared })
      const request = stub.calls.find(call => call.url.endsWith("/ocr/completions"))
      assert.deepEqual(request?.body, { uploadTicket: "private-ocr-ticket" })
      assert.equal(stub.uploads[0]!.image.content_type, mimeType)
      assert.deepEqual(stub.uploads[0]!.body, prepared)
    } finally {
      stub.restore()
    }
  }
})

test("AI diagnostics retain the input size after the worker transfers its buffer", async () => {
  const stub = record(call => {
    if (call.url.endsWith("/prepare")) return { outcome: "running", jobs: [{
      id: "ai-size-job", kind: "ai.recognize", idempotency_key: "one-purchase", payload: {
        source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "识图提示词" },
      },
    }] }
    if (call.url.endsWith("/ocr/completions")) return COMPLETION
    if (call.url.endsWith("/ai/settle")) return RECOGNISED
    return ROW
  })
  const log = captureLog()
  try {
    const { runRows } = await import("./run-rows")
    await withStubbedDevice(() => runRows({ row_ids: [ROW.id], expected_revisions: [] }, "recognize"), {}, {
      prepareAiImage: async (bytes: Uint8Array) => {
        structuredClone(bytes, { transfer: [bytes.buffer] })
        assert.equal(bytes.length, 0)
        return new Uint8Array([7, 8])
      },
    })
    assert.match(log.lines.find(line => line.includes(" ai.image ")) ?? "", /sourceBytes=3 imageBytes=2/)
  } finally {
    log.restore()
    stub.restore()
  }
})

test("a source changed during preprocessing fails the claimed job without a purchase", async () => {
  let changed = false
  const stub = record(call => {
    if (call.url.endsWith("/prepare")) return { outcome: "running", jobs: [{
      id: "changed-ai", kind: "ai.recognize", idempotency_key: "old-source",
      payload: { recognition_prompt: { content: "prompt", fixed_tags: FIXED_TAGS } },
    }] }
    return { ...ROW, revision: ROW.revision + Number(changed), view_revision: ROW.view_revision + Number(changed), source: { ...ROW.source, sha256: changed ? "changed-source" : ROW.source.sha256 } }
  })
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await withStubbedDevice(() => runRows({ row_ids: [ROW.id], expected_revisions: [] }, "recognize"), {}, {
      prepareAiImage: async () => { changed = true; return new Uint8Array([7]) },
    })
    assert.equal(result?.error?.code, "workflow_source_changed")
    assert.deepEqual(windowJobIds(stub.calls), ["changed-ai", "changed-ai", "changed-ai"], "each bounded attempt re-claims the Job")
    assert.equal(stub.calls.some(call => call.url.endsWith("/ocr/completions")), false)
    assert.deepEqual(stub.calls.find(call => call.url.endsWith("/ai/fail"))?.body, {
      job_id: "changed-ai", lease: { owner: "tab-changed-ai", epoch: 1 },
    })
  } finally { stub.restore() }
})

for (const expired of [false, true]) test(`prepared input is released when ${expired ? "the queued job expires" : "the claimed prompt changes"}`, async () => {
  let occupied = 0
  const stub = record(call => call.url.endsWith("/prepare") ? { outcome: "running", jobs: [{
    id: "closed-ai", kind: "ai.recognize", idempotency_key: "closed-key",
    payload: { recognition_prompt: { content: "prompt", fixed_tags: FIXED_TAGS } },
  }] } : ROW, job => {
    if (expired) { Object.assign(job, { state: "cancelled", last_error_code: "browser_prepare_queue_expired" }); return null }
    const claim = grantedClaim(job)
    Object.assign(claim.job.payload, { recognition_prompt: { content: "another prompt", fixed_tags: FIXED_TAGS } })
    return claim
  })
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await withStubbedDevice(() => runRows({ row_ids: [ROW.id], expected_revisions: [] }, "recognize"), {}, {
      occupy: (bytes: number) => { occupied += bytes; return () => { occupied -= bytes } },
    })
    assert.equal(result?.error?.code, expired ? "browser_prepare_queue_expired" : "workflow_ai_input_mismatch")
    assert.equal(stub.calls.some(call => call.url.endsWith("/ocr/completions")), false)
    assert.equal(stub.calls.filter(call => call.url.endsWith("/ai/fail")).length, expired ? 0 : 3)
    assert.equal(occupied, 0)
  } finally { stub.restore() }
})

test("empty claims and OCR busy retries retain one input and release its memory", async (t) => {
  let claims = 0
  let purchases = 0
  let images = 0
  let occupied = 0
  const claimBytes: number[] = []
  const stub = record(call => {
    if (call.url.endsWith("/prepare")) return { outcome: "running", jobs: [{
      id: "cached-ai", kind: "ai.recognize", idempotency_key: "cached-key",
      payload: { recognition_prompt: { content: "prompt", fixed_tags: FIXED_TAGS } },
    }] }
    if (call.url.endsWith("/ocr/completions")) return ++purchases < 3
      ? new Response(JSON.stringify({ code: "BUSY", error: "busy" }), { status: 429, headers: { "Retry-After": "0" } }) : COMPLETION
    return RECOGNISED
  }, job => { claimBytes.push(occupied); return ++claims < 3 ? null : grantedClaim(job) })
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await advanceBusyClock(t, () => withStubbedDevice(() => runRows({ row_ids: [ROW.id], expected_revisions: [] }, "recognize"), {}, {
      prepareAiImage: async () => { images++; return new Uint8Array([7, 8, 9]) },
      occupy: (bytes: number) => { occupied += bytes; return () => { occupied -= bytes; assert.ok(occupied >= 0) } },
    }))
    assert.equal(result?.error, undefined)
    assert.equal(images, 1)
    assert.equal(claims, 3)
    assert.ok(claimBytes.every(bytes => bytes > 0), "waiting inputs remain in the shared memory budget")
    assert.equal(occupied, 0)
    const calls = stub.calls.filter(call => call.url.endsWith("/ocr/completions"))
    assert.deepEqual(calls.map(call => call.headers["Idempotency-Key"]), ["cached-key", "cached-key", "cached-key"])
    assert.deepEqual(calls.map(call => call.body), Array(3).fill(analyzeImageBody("private-ocr-ticket")))
  } finally { stub.restore() }
})

test("processing-confirm missing re-stages identical bytes with the original paid key", async () => {
  let purchases = 0
  const stub = record(call => {
    if (call.url.endsWith("/prepare")) return { outcome: "running", jobs: [{
      id: "staged-ai", kind: "ai.recognize", idempotency_key: "staged-key",
      payload: { recognition_prompt: { content: "prompt", fixed_tags: FIXED_TAGS } },
    }] }
    if (call.url.endsWith("/ocr/completions")) return ++purchases === 1
      ? new Response(JSON.stringify({ code: "MEDIA_COMPLETE_MISSING", error: "missing before hold" }), { status: 404 }) : COMPLETION
    return RECOGNISED
  })
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await withStubbedDevice(() => runRows({ row_ids: [ROW.id], expected_revisions: [] }, "recognize"))
    assert.equal(result?.error, undefined)
    const paid = stub.calls.filter(call => call.url.endsWith("/ocr/completions"))
    assert.equal(paid.length, 2)
    assert.deepEqual(paid.map(call => call.headers["Idempotency-Key"]), ["staged-key", "staged-key"])
    assert.equal(stub.uploads.length, 2)
    assert.deepEqual(stub.uploads[0]!.body, stub.uploads[1]!.body)
  } finally { stub.restore() }
})
