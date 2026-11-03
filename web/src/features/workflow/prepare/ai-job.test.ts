/** OCR recognition: purchase identities, one contract retry, and writeback. */
import assert from "node:assert/strict"
import test from "node:test"

import type { WorkflowOperationRowResult } from "@/bindings/commands"
import {
  RECOGNITION_CONTRACT_VERSION,
} from "./ai-job"
import { requestStop, setCardContext } from "./execution-context"
import { RENDERER_CONTRACT_VERSION } from "./media-job"
import {
  answer,
  captureLog,
  COMPLETION,
  FIXED_TAGS,
  FIVE_TAGS,
  RECOGNISED,
  ROW,
  windowCalls,
  withStubbedDevice,
} from "./executor-test-support"
import { record } from "./ai-job-test-support"

test("the logged OCR cost is the charged split, never the nominal total", async () => {
  const stub = record((call) => {
    if (call.url.endsWith("/prepare")) return {
      outcome: "running",
      jobs: [{ id: "job-cost", kind: "ai.recognize", idempotency_key: "cost-key", payload: {
        source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "识图提示词" },
      } }],
    }
    if (call.url.endsWith("/ocr/completions")) return COMPLETION
    if (call.url.endsWith("/ai/settle")) return RECOGNISED
    return ROW
  })
  const log = captureLog()
  try {
    const { runRows } = await import("./run-rows")
    await withStubbedDevice(() => runRows({ row_ids: [ROW.id], expected_revisions: [] }, "recognize"))
    const ocrLine = log.lines.find((line) => line.includes(" ai.ocr ")) ?? ""
    assert.match(ocrLine, /cost_microfen=300/, "cost reads billing.charged_microfen (300), absorbed 100 excluded")
    assert.doesNotMatch(ocrLine, /cost_microfen=400/, "the nominal total must not surface as cost")
  } finally {
    log.restore()
    stub.restore()
  }
})

test("recognize pins without a PSD and settles its purchase without rewriting the Draft", async () => {
  setCardContext({ psdTemplateSha256: "" })
  const stub = record((call) => {
    if (call.url.endsWith("/prepare")) {
      return { outcome: "running", jobs: [{ id: "job-1", kind: "ai.recognize", aggregate_id: "row-1", aggregate_type: "listing_row", input_revision: 9, state: "queued", attempt: 0, idempotency_key: "recognize:v1:row-1:9:ai:v2:source-sha:prompt-sha:browser-image-v1_ocr-v1", payload: { recognition_prompt: { prompt_id: "prompt-1", fixed_tags: FIXED_TAGS, content: "识图提示词", sha256: "prompt-sha" }, executor: "browser", pinned_revision: 9, source_sha256: "source-sha", psd_template_sha256: "template-sha", renderer_contract_version: RENDERER_CONTRACT_VERSION }, updated_at_ms: 0 }] }
    }
    if (call.url.endsWith("/ocr/completions")) return { ...COMPLETION, listing_row: { ...RECOGNISED, revision: 10 } }
    if (call.url.endsWith("/ai/settle")) return { ...RECOGNISED, revision: 10 }
    return ROW
  })
  try {
    const { runRows } = await import("./run-rows")
    const streamed: WorkflowOperationRowResult[] = []
    const results = await withStubbedDevice(() =>
      runRows(
        { row_ids: ["row-1"], expected_revisions: [{ row_id: "row-1", revision: 9 }] },
        "recognize",
        (row) => streamed.push(row),
      ),
    )
    const [result] = results
    assert.equal(result!.outcome, "start")
    assert.equal(result!.job_id, "job-1")
    assert.equal(result!.error, undefined)
    // Settlement returns the validated Draft directly, without a second write.
    assert.equal(result!.product?.lifecycle.ai, "ready")
    assert.equal(result!.product?.lifecycle.revision, 10)
    assert.deepEqual(result!.product?.draft?.values.name, { kind: "text", value: "Постер с морем" })
    assert.deepEqual(result!.product?.lifecycle.ai_summary?.tags, FIVE_TAGS)
    // Streamed: the leg starting (Cloud's pinned row), the leg landing, then
    // the settled result; only the last one is not `interim`.
    assert.deepEqual(
      streamed.filter((row) => row.product).map((row) => [row.interim ?? false, row.product?.lifecycle.ai]),
      [[true, "pending"], [true, "ready"], [false, "ready"]],
    )
    assert.deepEqual(streamed.at(-1), result)
    assert.deepEqual(
      stub.calls.map((call) => `${call.method} ${call.url}`),
      [
      "POST /api/listing/rows/row-1/prepare",
      "GET /api/listing/rows/row-1",
      "POST /api/listing/jobs/claim-window",
        "GET /api/listing/rows/row-1",
        "POST /api/ai/ocr/completions",
      ],
    )
    assert.deepEqual(windowCalls(stub.calls)[0]!.body, {
      jobIds: ["job-1"],
      kind: "ai.recognize",
      limit: 1,
    })
    assert.deepEqual(stub.calls[0]!.body, {
      operation: "recognize",
      renderer_contract_version: RENDERER_CONTRACT_VERSION,
      command_id: stub.calls[0]!.body.command_id,
    })
    assert.match(stub.calls[0]!.body.command_id, /^[0-9a-f-]{36}$/)
    // The key travels from the Job, verbatim: re-deriving it in the browser
    // after the re-read would file the same work under a second key.
    assert.equal(
      stub.calls.find((call) => call.url.endsWith("/ocr/completions"))!.headers["Idempotency-Key"],
      "recognize:v1:row-1:9:ai:v2:source-sha:prompt-sha:browser-image-v1_ocr-v1",
    )
    assert.equal(stub.calls.some((call) => call.url.endsWith("/ai/settle")), false, "normal OCR writeback does not POST ai/settle")
    assert.equal(stub.calls.some((call) => call.method === "PATCH"), false, "settlement validates without sending a stale full Draft back")
  } finally {
    stub.restore()
  }
})

test("OCR writeback pending recovers through ai/settle and does not fail the job", async () => {
  setCardContext({ psdTemplateSha256: "" })
  const stub = record((call) => {
    if (call.url.endsWith("/prepare")) {
      return { outcome: "running", jobs: [{ id: "job-1", kind: "ai.recognize", aggregate_id: "row-1", aggregate_type: "listing_row", input_revision: 9, state: "queued", attempt: 0, idempotency_key: "recognize:v1:row-1:9:ai:v2:source-sha:prompt-sha:browser-image-v1_ocr-v1", payload: { recognition_prompt: { prompt_id: "prompt-1", fixed_tags: FIXED_TAGS, content: "识图提示词", sha256: "prompt-sha" }, executor: "browser", pinned_revision: 9, source_sha256: "source-sha", psd_template_sha256: "template-sha", renderer_contract_version: RENDERER_CONTRACT_VERSION }, updated_at_ms: 0 }] }
    }
    if (call.url.endsWith("/ocr/completions")) {
      return new Response(JSON.stringify({
        error: "识图已计费，商品尚未写入，请核对后重试写回",
        code: "LISTING_WRITEBACK_PENDING",
        ocr_recovery: { job_id: "job-1", request_id: "air-purchase" },
      }), { status: 409, headers: { "Content-Type": "application/json" } })
    }
    if (call.url.endsWith("/ai/settle")) return { ...RECOGNISED, revision: 10 }
    if (call.url.endsWith("/ai/fail")) throw new Error("must not fail a paid writeback")
    return ROW
  })
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await withStubbedDevice(() =>
      runRows({ row_ids: ["row-1"], expected_revisions: [{ row_id: "row-1", revision: 9 }] }, "recognize"),
    )
    assert.equal(result!.error, undefined)
    assert.equal(result!.product?.lifecycle.revision, 10)
    assert.equal(stub.calls.filter((call) => call.url.endsWith("/ai/settle")).length, 1)
    assert.equal(stub.calls.some((call) => call.url.endsWith("/ai/fail")), false)
  } finally {
    stub.restore()
  }
})

test("five image tags settle without a retry", async () => {
  setCardContext({ psdTemplateSha256: "template-sha" })
  const JOB_KEY = "recognize:v1:row-1:9:ai:v2:source-sha:prompt-sha:browser-image-v1_ocr-v1"
  const prepare = { outcome: "running", jobs: [{ id: "job-1", kind: "ai.recognize", aggregate_id: "row-1", aggregate_type: "listing_row", input_revision: 9, state: "queued", attempt: 0, idempotency_key: JOB_KEY, payload: { recognition_prompt: { prompt_id: "prompt-1", fixed_tags: FIXED_TAGS, content: "识图提示词", sha256: "prompt-sha" }, executor: "browser", pinned_revision: 9, source_sha256: "source-sha", psd_template_sha256: "template-sha", renderer_contract_version: RENDERER_CONTRACT_VERSION }, updated_at_ms: 0 }] }
  const stub = record((call) => {
    if (call.url.endsWith("/prepare")) return prepare
    if (call.url.endsWith("/ocr/completions")) {
      return {
        billing: COMPLETION.billing,
        completion: answer(JSON.stringify({ ru: "Постер с морем", tags: FIVE_TAGS, desc: "Морской постер" })),
      }
    }
    return ROW
  })
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await withStubbedDevice(() =>
      runRows({ row_ids: ["row-1"], expected_revisions: [{ row_id: "row-1", revision: 9 }] }, "recognize"),
    )
    assert.equal(result!.outcome, "start")
    assert.equal(result!.error, undefined)
    const posts = stub.calls.filter((call) => call.url.endsWith("/ocr/completions"))
    assert.equal(posts.length, 1, "one purchase for a valid five-tag answer")
    const settle = stub.calls.find((call) => call.url.endsWith("/ai/settle"))!
    assert.equal(settle.body.request_id, "air-purchase")
  } finally {
    stub.restore()
  }
})

test("an unusable server theme waits for a person without another paid request", async () => {
  const stub = record(call => {
    if (call.url.endsWith("/prepare")) return {outcome:"running", jobs:[{id:"job-1",kind:"ai.recognize",attempt:2,idempotency_key:"one-key",payload:{source_sha256:"source-sha",recognition_prompt:{fixed_tags:FIXED_TAGS,content:"facts"}}}]}
    if (call.url.endsWith("/ocr/completions")) return new Response(JSON.stringify({code:"OCR_CONTRACT_VIOLATION",error:"图片无法辨认，请人工处理"}),{status:422})
    return ROW
  })
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await withStubbedDevice(() => runRows({row_ids:[ROW.id],expected_revisions:[]},"recognize"))
    assert.equal(result?.error?.code,"cloud_ocr_contract_violation")
    const calls=stub.calls.filter(c=>c.url.endsWith("/ocr/completions"))
    assert.equal(calls.length,1)
    assert.equal(calls[0]!.headers["Idempotency-Key"],"one-key")
    assert.equal(stub.calls.some(c=>c.url.endsWith("/ai/settle")),false)
    assert.equal(stub.calls.filter(c=>c.url.endsWith("/ai/fail")).length,1)
    assert.equal(stub.calls.find(c=>c.url.endsWith("/ai/fail"))?.body.error_code,"cloud_ocr_contract_violation")
  } finally {stub.restore()}
})

test("recognition requires the pinned processing contract and a Cloud purchase id", async () => {
  for (const bad of ["contract", "purchase"]) {
    const stub = record((call) => {
      if (call.url.endsWith("/prepare")) return {
        outcome: "running",
        jobs: [{ id: "job-purchase", kind: "ai.recognize", idempotency_key: "purchase-key", payload: {
          source_sha256: "source-sha",
          recognition_contract_version: bad === "contract" ? "browser-image-v1:ocr-fixed1-30-ai4-v1" : RECOGNITION_CONTRACT_VERSION,
          recognition_prompt: { fixed_tags: FIXED_TAGS, content: "识图" },
        } }],
      }
      if (call.url.endsWith("/ocr/completions")) return { ...COMPLETION, billing: { ...COMPLETION.billing, request_id: "" } }
      return RECOGNISED
    })
    try {
      const { runRows } = await import("./run-rows")
      const [result] = await withStubbedDevice(() => runRows({ row_ids: [ROW.id], expected_revisions: [] }, "recognize"))
      assert.equal(result?.error?.code, bad === "contract" ? "workflow_recognition_contract_changed" : "workflow_purchase_missing")
      assert.equal(stub.calls.some((call) => call.url.endsWith("/ai/settle")), false)
      if (bad === "contract") assert.equal(stub.calls.find(call => call.url.endsWith("/ai/fail"))?.body.error_code, "workflow_recognition_contract_changed")
      assert.equal(
        stub.calls.filter((call) => call.url.endsWith("/ocr/completions")).length,
        bad === "contract" ? 0 : 3,
        "a contract violation never reaches the relay; a paid failure replans and retries to the bound",
      )
    } finally { stub.restore() }
  }
})
