/**
 * The media.render / media.upload rail: OPFS render, the static-slice cache and public confirmation.
 *
 * The renderer and OPFS are stubbed (executor-test-support): what these tests
 * are for is the wire — the route a verb takes, the pin it writes under, and
 * the shape Cloud will refuse if it drifts.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { setErrorFeedbackContext } from "@/lib/error-feedback-reporting"
import { route } from "@/api/routes"

import { toast } from "@/components/ui/toast"

import { setCardContext } from "./execution-context"
import { RENDERER_CONTRACT_VERSION } from "./media-job"
import { captureLog, FIXED_TAGS, prepareStages, RECOGNISED, record, ROW, SLICE_DIGEST, slicePrepareReply, withStubbedDevice } from "./executor-test-support"

test("slice renders to OPFS and writes rendered evidence without uploading", async () => {
  setCardContext({ psdTemplateSha256: "template-sha" })
  const stub = record((call) => {
    if (call.url.endsWith("/prepare")) {
      return { outcome: "running", jobs: [{ id: "job-2", kind: "media.render", aggregate_id: "row-1", aggregate_type: "listing_row", input_revision: 10, state: "queued", attempt: 0, idempotency_key: "slice:v1:row-1:10", payload: { recognition_prompt: { prompt_id: "prompt-1", fixed_tags: FIXED_TAGS, content: "识图提示词", sha256: "prompt-sha" }, executor: "browser", pinned_revision: 10, source_sha256: "source-sha", psd_template_sha256: "pinned-template-sha", renderer_contract_version: RENDERER_CONTRACT_VERSION }, updated_at_ms: 0 }] }
    }
    if (call.url.endsWith("/media")) return { applied: true, jobs: [], row: ROW }
    return { ...ROW, revision: 10, media_state: "processing" }
  })
  try {
    const { runRows } = await import("./run-rows")
    await withStubbedDevice(() =>
      runRows({ row_ids: ["row-1"], expected_revisions: [{ row_id: "row-1", revision: 9 }] }, "slice"),
    )
    // The row is read again after the render: the writeback pins the revision
    // the row holds once the lane wait and the render are over.
    assert.deepEqual(
      stub.calls.map((call) => `${call.method} ${call.url}`),
      [
        "POST /api/listing/rows/row-1/prepare",
        "GET /api/listing/rows/row-1",
        "GET /api/listing/rows/row-1",
        "POST /api/listing/rows/row-1/media",
      ],
    )
    assert.equal(
      stub.calls.some((call) => call.url.includes(route("mediaObjectsByDigestByExtensionPresign", { digest: "digest", extension: "extension" }).replace("digest/extension/presign", ""))),
      false,
      "slice must not probe or PUT public objects",
    )
    const writeback = stub.calls.find((call) => call.url.endsWith("/media"))!.body
    assert.equal(writeback.expected_revision, 10, "the pin is read back after prepare bumped it")
    assert.equal(writeback.job_id, "job-2", "the successful writeback retires its durable Job")
    assert.equal(writeback.media_state, "rendered")
    assert.deepEqual(Object.keys(writeback.payload).sort(), ["media", "render_evidence"])
    assert.deepEqual(writeback.payload.media.images[0], {
      index: 0,
      file_name: "slice-1.jpg",
      content_hash: `sha256:${SLICE_DIGEST}`,
      group_name: "主图",
      width: 900,
      height: 1200,
      byte_size: 1,
      phase: "rendered",
    })
    // `RenderEvidence` is a flattened struct with no `rename_all`, so its four
    // fingerprints stay snake_case inside the camelCase envelope.
    const evidence = writeback.payload.render_evidence
    assert.equal(evidence.source_sha256, "source-sha")
    // The template digest is the Job's pin, not whatever the open card holds
    // now — a card rebound mid-batch must not change what a pinned job renders.
    assert.equal(evidence.template_sha256, "pinned-template-sha")
    assert.equal(evidence.renderer_contract_version, RENDERER_CONTRACT_VERSION)
    assert.match(evidence.manifest_digest, /^manifest:v1:row-1:sha256:[0-9a-f]{64}$/)
    assert.equal(evidence.sliceCount, 1)
  } finally {
    stub.restore()
  }
})

test("a supplier render job stages its frozen verified PSD when OPFS is empty", async () => {
  setCardContext({ psdTemplateSha256: "supplier-template-sha" })
  const stub = record((call) => {
    if (call.url.endsWith("/prepare")) {
      return { outcome: "running", jobs: [{
        id: "supplier-render", kind: "media.render", aggregate_id: "row-1",
        aggregate_type: "listing_row", input_revision: 10, state: "queued", attempt: 0,
        idempotency_key: "slice:supplier", updated_at_ms: 0,
        payload: {
          executor: "browser", pinned_revision: 10, source_sha256: "source-sha",
          psd_template_sha256: "supplier-template-sha",
          renderer_contract_version: RENDERER_CONTRACT_VERSION,
          card_payload: {
            supplier_product_id: "supplier-product",
            psd_template_file_name: "factory.psd",
          },
        },
      }] }
    }
    if (call.url.endsWith("/media")) return { applied: true, jobs: [], row: ROW }
    return { ...ROW, revision: 10, media_state: "processing" }
  })
  let staged = false
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await withStubbedDevice(
      () => runRows(
        { row_ids: ["row-1"], expected_revisions: [{ row_id: "row-1", revision: 9 }] },
        "slice",
      ),
      {
        getTemplate: async () => staged ? new Uint8Array([4, 5, 6]) : null,
        stageSupplierTemplate: async (productId: string, digest: string, fileName: string) => {
          assert.deepEqual([productId, digest, fileName], [
            "supplier-product", "supplier-template-sha", "factory.psd",
          ])
          staged = true
        },
      },
    )
    assert.equal(staged, true)
    assert.equal(result?.error, undefined)
    assert.ok(stub.calls.some((call) => call.url.endsWith("/media")))
  } finally {
    stub.restore()
  }
})

test("prepare rerenders stale local slices instead of uploading their old manifest", async () => {
  setCardContext({ psdTemplateSha256: "template-sha" })
  const stale = {
    ...ROW,
    media: { images: [{ index: 0, file_name: "old.jpg", content_hash: `sha256:${SLICE_DIGEST}`, group_name: "主图", width: 900, height: 1200, byte_size: 1, phase: "rendered" }], videos: [] },
    render_evidence: { source_sha256: "old-source", template_sha256: "template-sha", renderer_contract_version: RENDERER_CONTRACT_VERSION, manifest_digest: "old-manifest" },
  }
  const stub = record((call) => {
    if (call.url.endsWith("/prepare")) return {
      outcome: "running",
      jobs: [{ id: "job-render", kind: "media.render", payload: { source_sha256: "source-sha", psd_template_sha256: "template-sha" } }],
    }
    if (call.method === "PUT") return { publicUrl: "https://cdn.example.invalid/new.jpg", objectKey: "o/new.jpg", accountId: "acct", byteLength: 1, deduplicated: false }
    if (call.url.endsWith("/media")) return { applied: true, jobs: [], row: stale }
    return stale
  })
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await withStubbedDevice(() => runRows({ row_ids: [ROW.id], expected_revisions: [{ row_id: ROW.id, revision: ROW.revision }] }, "prepare"))
    assert.equal(result?.error, undefined)
    const landed = stub.calls.find((call) => call.url.endsWith("/media"))!.body
    assert.equal(landed.payload.render_evidence.source_sha256, "source-sha")
    assert.notEqual(landed.payload.render_evidence.manifest_digest, "old-manifest")
    assert.equal(landed.payload.media.images[0].content_hash, `sha256:${SLICE_DIGEST}`)
  } finally {
    stub.restore()
  }
})

for (const missing of ["template", "source"] as const) test(`a missing ${missing} writes its actionable failure without losing valid results`, async () => {
  setCardContext({ psdTemplateSha256: "template-sha" })
  const kept = { ...RECOGNISED, media: { images: [{ index: 0, file_name: "kept.jpg", content_hash: `sha256:${SLICE_DIGEST}`,
    group_name: "main", width: 1, height: 1, byte_size: 1, phase: "public_ready", public_url: "https://cdn.invalid/kept.jpg" }], videos: [] } }
  const stub = record((call) => {
    if (call.url.endsWith("/prepare")) {
      return { outcome: "running", jobs: [{ id: "job-3", kind: "media.render", aggregate_id: "row-1", aggregate_type: "listing_row", input_revision: 9, state: "queued", attempt: 0, updated_at_ms: 0 }] }
    }
    if (call.url.endsWith("/media")) return { applied: true, jobs: [], row: kept }
    return kept
  })
  const log = captureLog()
  let renders = 0
  let localWrites = 0
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await withStubbedDevice(
      () =>
        runRows(
          { row_ids: ["row-1"], expected_revisions: [{ row_id: "row-1", revision: 9 }] },
          "slice",
        ),
      {
        ...(missing === "template" ? { getTemplate: async () => null } : { getSource: async () => null }),
        putRender: async () => { localWrites += 1; return true },
      },
      { renderProduct: async () => { renders += 1; throw new Error("missing inputs must not render") } },
    )
    log.restore()
    assert.equal(result!.outcome, "start")
    assert.equal(result!.error?.code, `workflow_${missing}_missing`)
    assert.match(result!.error!.message, missing === "source" ? /重新导入/ : /重新选择模板/)
    assert.equal(renders, 0)
    assert.equal(localWrites, 0)
    assert.equal(stub.calls.filter((call) => call.url.endsWith("/ocr/completions")).length, 0)
    assert.equal(stub.calls.filter((call) => call.method === "PUT").length, 0)
    assert.deepEqual(result!.product?.draft, kept.draft)
    assert.deepEqual(result!.product?.lifecycle.ai_summary?.tags, kept.ai.summary.tags)
    assert.deepEqual(result!.product?.lifecycle.images, kept.media.images)
    const writebacks = stub.calls.filter((call) => call.url.endsWith("/media"))
    assert.equal(writebacks.length, 3, "render gets one initial attempt and two retries")
    const writeback = writebacks.at(-1)!.body
    assert.equal(writeback.media_state, "failed")
    assert.equal(writeback.payload.failure_log[0].stage, "media")
    assert.equal(writeback.payload.failure_log[0].code, `workflow_${missing}_missing`)
    assert.match(writeback.payload.failure_log[0].message, missing === "source" ? /重新导入/ : /重新选择模板/)
    assert.deepEqual(Object.keys(writeback.payload), ["failure_log"], "failure must not replace valid draft or media")
    // Failure writes above prove all three attempts; console errors dedupe for 30s.
    assert.deepEqual(prepareStages(log.lines, "row-1"), [
      "pin",
      "media.lane", "media.fail", "stage.retry",
      "media.lane", "stage.retry",
      "media.lane",
      "row.fail", "row.done",
    ])
    assert.match(
      log.lines.find((line) => line.includes(" row.fail "))!,
      new RegExp(`code=workflow_${missing}_missing row=row-1`),
    )
  } finally {
    log.restore()
    stub.restore()
  }
})

test("a render failure retries a stale failure writeback with a fresh revision", async () => {
  setCardContext({ psdTemplateSha256: "template-sha" })
  let stale = false
  const stub = record((call) => {
    if (call.url.endsWith("/prepare")) return slicePrepareReply("row-1")
    if (call.url.endsWith("/media")) {
      if (!stale) { stale = true; return { applied: false, row: null, jobs: [] } }
      return { applied: true, row: ROW, jobs: [] }
    }
    return { ...ROW, revision: stale ? 11 : 10, view_revision: stale ? 11 : 10 }
  })
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await withStubbedDevice(
      () => runRows({ row_ids: ["row-1"], expected_revisions: [] }, "slice"),
      { getTemplate: async () => null },
    )
    assert.equal(result?.error?.code, "workflow_template_missing")
    const writebacks = stub.calls.filter((call) => call.url.endsWith("/media"))
    assert.deepEqual(writebacks.slice(0, 2).map((call) => call.body.expected_revision), [10, 11])
    assert.equal(writebacks[1]!.body.payload.failure_log[0].code, "workflow_template_missing")
  } finally { stub.restore() }
})

test("failed failure writeback reports both errors and preserves the render error", async () => {
  setErrorFeedbackContext({ sessionKey: "media-writeback-feedback" })
  const receipts: string[] = []
  setCardContext({ psdTemplateSha256: "template-sha" })
  const stub = record((call) => {
    if (call.url === route("eventsInbox")) {
      for (const event of call.body.events) {
        assert.equal(event.kind, "error_feedback.v1")
        assert.equal(event.schema_version, 1)
        assert.match(event.id, /^[0-9]{20}$/)
        const payload = JSON.parse(event.payload_json)
        assert.equal(payload.errorId, event.id)
        assert.equal(payload.code, "workflow_template_missing")
        assert.equal(payload.refusalReason, "workflow_executor_failed")
        assert.ok(Object.keys(payload).every(key => ["errorId", "code", "traceId", "status", "stage", "rowId", "cardId", "appVersion", "userId", "workspaceId", "userAgent", "requestId", "apiPath", "apiStatus", "refusalReason", "media"].includes(key)))
        receipts.push(event.id)
      }
      return { accepted: receipts, rejected: [] }
    }
    if (call.url.endsWith("/prepare")) return slicePrepareReply("row-1")
    if (call.url.endsWith("/media")) return { applied: false, row: null, jobs: [] }
    return { ...ROW, revision: 10, viewRevision: 10 }
  })
  const log = captureLog()
  const notices: Parameters<typeof toast.add>[0][] = []
  const originalAdd = toast.add
  toast.add = ((notice) => { notices.push(notice); return "media-failure-test" }) as typeof toast.add
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await withStubbedDevice(
      () => runRows({ row_ids: ["row-1"], expected_revisions: [] }, "slice"),
      { getTemplate: async () => null },
    )
    assert.equal(result?.error?.code, "workflow_template_missing")
    assert.ok(stub.calls.filter((call) => call.url.endsWith("/media")).length >= 3)
    assert.ok(log.lines.filter((line) => line.includes("[notify] error") && line.includes("失败记录未保存")).length <= 1,
      "the same diagnostic is printed at most once within the existing 30s window")
    const notice = notices.find((item) => item.title === "媒体处理失败，失败记录未保存")
    assert.ok(notice, "the dual-error toast remains observable even when console output is deduped")
    const description = renderToStaticMarkup(createElement("div", null, notice?.description))
    assert.match(description, /处理：本机没有该 PSD 模板.*；保存：商品行持续变化/)
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(receipts.length, 1)
    assert.ok(description.includes(receipts[0]!))
  } finally {
    setErrorFeedbackContext({ sessionKey: null })
    toast.add = originalAdd
    log.restore()
    stub.restore()
  }
})

test("a DOMException numeric code is normalized before failure writeback", async () => {
  setCardContext({ psdTemplateSha256: "template-sha" })
  const stub = record((call) => {
    if (call.url.endsWith("/prepare")) {
      return { outcome: "running", jobs: [{ id: "job-domexception", kind: "media.render", aggregate_id: "row-1", aggregate_type: "listing_row", input_revision: 9, state: "queued", attempt: 0, updated_at_ms: 0 }] }
    }
    if (call.url.endsWith("/media")) return { applied: true, jobs: [], row: ROW }
    return ROW
  })
  const domException = new DOMException("image pipeline refused the mutation", "NoModificationAllowedError")
  assert.equal(domException.code, 7)
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await withStubbedDevice(
      () =>
        runRows(
          { row_ids: ["row-1"], expected_revisions: [{ row_id: "row-1", revision: 9 }] },
          "slice",
        ),
      { getTemplate: async () => { throw domException } },
    )
    assert.equal(result!.error?.code, "workflow_executor_failed")
    const writebacks = stub.calls.filter((call) => call.url.endsWith("/media"))
    assert.equal(writebacks.at(-1)!.body.payload.failure_log[0].code, "workflow_executor_failed")
  } finally {
    stub.restore()
  }
})

test("one PSD parse serves the whole batch", async () => {
  setCardContext({ psdTemplateSha256: "template-sha" })
  const stub = record((call) => {
    const rowId = call.url.split(route("listingRowsById", { id: "placeholder" }).replace("placeholder", ""))[1]?.split("/")[0] ?? "row-1"
    if (call.url.endsWith("/prepare")) return slicePrepareReply(rowId)
    if (call.url.endsWith("/media")) return { applied: true, jobs: [], row: { ...ROW, id: rowId, mediaState: "rendered" } }
    return { ...ROW, id: rowId, revision: 10, media_state: "processing" }
  })
  const log = captureLog()
  let loads = 0
  let drops = 0
  try {
    const { runRows } = await import("./run-rows")
    await withStubbedDevice(
      () => runRows({ row_ids: ["row-1", "row-2", "row-3"], expected_revisions: [] }, "slice"),
      {},
      {
        loadTemplate: async () => {
          loads += 1
          return 7
        },
        dropTemplate: async () => {
          drops += 1
        },
      },
    )
    log.restore()
    assert.equal(loads, 1, "the lane parses the PSD once")
    assert.equal(drops, 0, "the handle stays on the lane across rows")
    const events = log.lines
      .filter((line) => line.startsWith("[prepare] template."))
      .map((line) => line.split(" ")[1])
    assert.deepEqual(events, ["template.load", "template.retain", "template.retain"])
  } finally {
    log.restore()
    stub.restore()
    setCardContext({ psdTemplateSha256: "" })
  }
})

test("a RENDER_TRAP forgets the handle so the next row reloads the template", async () => {
  setCardContext({ psdTemplateSha256: "template-sha" })
  const stub = record((call) => {
    const rowId = call.url.split(route("listingRowsById", { id: "placeholder" }).replace("placeholder", ""))[1]?.split("/")[0] ?? "row-1"
    if (call.url.endsWith("/prepare")) return slicePrepareReply(rowId)
    if (call.url.endsWith("/media")) return { applied: true, jobs: [], row: { ...ROW, id: rowId, mediaState: "rendered" } }
    return { ...ROW, id: rowId, revision: 10, media_state: "processing" }
  })
  const log = captureLog()
  let loads = 0
  let renders = 0
  try {
    const { runRows } = await import("./run-rows")
    const results = await withStubbedDevice(
      () => runRows({ row_ids: ["row-1", "row-2"], expected_revisions: [] }, "slice"),
      {},
      {
        loadTemplate: async () => {
          loads += 1
          return loads
        },
        renderProduct: async () => {
          renders += 1
          if (renders === 1) {
            throw Object.assign(new Error("the render module was discarded; reload the template"), {
              code: "RENDER_TRAP",
            })
          }
          return {
            manifest: { staticGroups: 0 },
            slices: [{
              groupName: "主图",
              index: 0,
              fileName: "slice-1.jpg",
              width: 900,
              height: 1200,
              contentHash: `sha256:${SLICE_DIGEST}`,
              bytes: new Uint8Array([1]),
            }],
          }
        },
      },
    )
    log.restore()
    // The trapped attempt forgets the handle; the row retries under a fresh
    // template and completes, then the next row reuses it.
    assert.equal(results[0]?.error, undefined)
    assert.equal(results[1]?.error, undefined)
    assert.equal(loads, 2, "the trapped instance cannot keep the old handle")
    assert.equal(renders, 3)
    assert.ok(log.lines.some((line) => line.includes("template.forget") && line.includes("reason=RENDER_TRAP")))
    assert.equal(log.lines.filter((line) => line.includes("template.load")).length, 2)
  } finally {
    log.restore()
    stub.restore()
    setCardContext({ psdTemplateSha256: "" })
  }
})
