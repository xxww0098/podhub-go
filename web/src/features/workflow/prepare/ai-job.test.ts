/** OCR recognition: purchase identities, one contract retry, and writeback. */
import assert from "node:assert/strict"
import test from "node:test"

import type { WorkflowOperationRowResult } from "@/bindings/commands"
import {
  OCR_RETRY_KEY_SUFFIX,
  ocrPurchaseKey,
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
  HAN_ANSWER,
  RECOGNISED,
  ROW,
  windowCalls,
  withStubbedDevice,
} from "./executor-test-support"
import { record } from "./ai-job-test-support"

test("OCR stage has one initial purchase and one retry identity", () => {
  assert.equal(ocrPurchaseKey("job-key", 1), "job-key")
  assert.equal(ocrPurchaseKey("job-key", 2), `job-key${OCR_RETRY_KEY_SUFFIX}`)
  assert.equal(ocrPurchaseKey("job-key", 3), `job-key${OCR_RETRY_KEY_SUFFIX}`)
})

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
        ocrRecovery: { jobId: "job-1", requestId: "air-purchase" },
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

test("a bad OCR answer gets at most one retry under its derived purchase key", async () => {
  setCardContext({ psdTemplateSha256: "template-sha" })
  const JOB_KEY = "recognize:v1:row-1:9:ai:v2:source-sha:prompt-sha:browser-image-v1_ocr-v1"
  const prepare = { outcome: "running", jobs: [{ id: "job-1", kind: "ai.recognize", aggregate_id: "row-1", aggregate_type: "listing_row", input_revision: 9, state: "queued", attempt: 0, idempotency_key: JOB_KEY, payload: { recognition_prompt: { prompt_id: "prompt-1", fixed_tags: FIXED_TAGS, content: "识图提示词", sha256: "prompt-sha" }, executor: "browser", pinned_revision: 9, source_sha256: "source-sha", psd_template_sha256: "template-sha", renderer_contract_version: RENDERER_CONTRACT_VERSION }, updated_at_ms: 0 }] }
  const badThenGood = record((call) => {
    if (call.url.endsWith("/prepare")) return prepare
    if (call.url.endsWith("/ocr/completions")) {
      return call.headers["Idempotency-Key"] === JOB_KEY
        ? { billing: COMPLETION.billing, completion: answer(JSON.stringify({ ru: "Чехол 山", tags: FIVE_TAGS, desc: "Сюжет." })) }
        : COMPLETION
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
    const keys = badThenGood.calls
      .filter((call) => call.url.endsWith("/ocr/completions"))
      .map((call) => call.headers["Idempotency-Key"])
    assert.deepEqual(keys, [JOB_KEY, `${JOB_KEY}${OCR_RETRY_KEY_SUFFIX}`])
    const purchases = badThenGood.calls.filter((call) => call.url.endsWith("/ocr/completions"))
    assert.deepEqual(purchases.map((call) => ({
      job: call.headers["X-Listing-Job-Id"],
      owner: call.headers["X-Listing-Lease-Owner"],
      epoch: call.headers["X-Listing-Lease-Epoch"],
    })), [
      { job: "job-1", owner: "tab-job-1", epoch: "1" },
      { job: "job-1", owner: "tab-job-1", epoch: "1" },
    ])
    assert.deepEqual(purchases[0]!.body, { uploadTicket: "private-ocr-ticket" }, "the server Job now owns the prompt and image reconstruction")
    assert.deepEqual(purchases[1]!.body, purchases[0]!.body, "retry retains the source binding while Cloud repairs the stored answer")
    assert.ok(badThenGood.calls.some((call) => call.url.endsWith("/ai/settle")))
  } finally {
    badThenGood.restore()
  }

  const alwaysBad = record((call) => {
    if (call.url.endsWith("/prepare")) return prepare
    if (call.url.endsWith("/ocr/completions")) return { billing: COMPLETION.billing, completion: answer(HAN_ANSWER) }
    return ROW
  })
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await withStubbedDevice(() =>
      runRows({ row_ids: ["row-1"], expected_revisions: [{ row_id: "row-1", revision: 9 }] }, "recognize"),
    )
    assert.equal(result!.error?.code, "workflow_ai_result_unusable")
    assert.match(result!.error?.message ?? "", /俄语标题中混入了中文，需要纯俄语内容/)
    assert.match(result!.error?.message ?? "", /已计费，结果未写入商品/)
    assert.match(result!.error?.message ?? "", /更新系统提示词后重新准备/)
    assert.doesNotMatch(result!.error?.message ?? "", /Idempotency-Key|\bru\b/)
    const posts = alwaysBad.calls.map((call) => `${call.method} ${call.url}`)
    assert.equal(posts.filter((post) => post.endsWith("/ocr/completions")).length, 2, "han receives one correction and never a third purchase")
    assert.doesNotMatch(result!.error?.message ?? "", /不会生成新答案/)
    assert.ok(!posts.some((post) => post.endsWith("/ai/settle")), "a bad answer never reaches the Draft")
    assert.ok(posts.some((post) => post.endsWith("/ai/fail")), "a failed Job is retired so a hot update can take effect")
  } finally {
    alwaysBad.restore()
  }
})

test("a mixed-script answer is corrected once and a second failure names the field", async () => {
  setCardContext({ psdTemplateSha256: "template-sha" })
  const stuck = `кип${"i"}рис`
  const mixed = JSON.stringify({ ru: `Чехол ${stuck}`, tags: FIVE_TAGS, desc: `Сюжет ${stuck}.` })
  const stub = record((call) => {
    if (call.url.endsWith("/prepare")) return {
      outcome: "running",
      jobs: [{ id: "job-1", kind: "ai.recognize", idempotency_key: "mixed-key", payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "识图提示词" } } }],
    }
    if (call.url.endsWith("/ocr/completions")) return { billing: COMPLETION.billing, completion: answer(mixed) }
    return ROW
  })
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await withStubbedDevice(() => runRows({ row_ids: ["row-1"], expected_revisions: [] }, "recognize"))
    assert.equal(result!.error?.code, "workflow_ai_result_unusable")
    assert.match(result!.error?.message ?? "", /俄语标题里的俄语词混入了拉丁字母/)
    assert.doesNotMatch(result!.error?.message ?? "", /不会生成新答案/)
    const keys = stub.calls.filter((call) => call.url.endsWith("/ocr/completions")).map((call) => call.headers["Idempotency-Key"])
    assert.deepEqual(keys, ["mixed-key", `mixed-key${OCR_RETRY_KEY_SUFFIX}`])
  } finally {
    stub.restore()
  }
})

test("stop after a bad paid OCR prevents the retry purchase", async () => {
  setCardContext({ psdTemplateSha256: "template-sha" })
  const stub = record((call) => {
    if (call.url.endsWith("/prepare")) {
      return { outcome: "running", jobs: [{ id: "job-1", kind: "ai.recognize", aggregate_id: "row-1", aggregate_type: "listing_row", input_revision: 9, state: "queued", attempt: 0, idempotency_key: "job-key", payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "识图提示词" } }, updated_at_ms: 0 }] }
    }
    if (call.url.endsWith("/ocr/completions")) {
      requestStop(["row-1"])
      return { billing: COMPLETION.billing, completion: answer(HAN_ANSWER) }
    }
    return ROW
  })
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await withStubbedDevice(() =>
      runRows({ row_ids: ["row-1"], expected_revisions: [{ row_id: "row-1", revision: 9 }] }, "recognize"),
    )
    assert.equal(result!.noop_reason, "cancelled")
    assert.equal(stub.calls.filter((call) => call.url.endsWith("/ocr/completions")).length, 1)
    assert.equal(stub.calls.some((call) => call.url.endsWith("/ai/settle")), false)
  } finally {
    stub.restore()
  }
})

for (const unusable of [
  { name: "Chinese title", content: HAN_ANSWER, posts: [ "paid-once", `paid-once${OCR_RETRY_KEY_SUFFIX}` ] },
  { name: "overlong title", content: JSON.stringify({ ru: "Ж".repeat(201), tags: FIVE_TAGS, desc: "Сюжет." }), posts: [ "paid-once", `paid-once${OCR_RETRY_KEY_SUFFIX}` ] },
]) test(`a paid OCR with ${unusable.name} stops after its allowed purchases`, async (t) => {
  let now = 0
  t.mock.method(performance, "now", () => now)
  const stub = record((call) => {
    if (call.url.endsWith("/prepare")) return {
      outcome: "running",
      jobs: [{ id: "expired-ai", kind: "ai.recognize", idempotency_key: "paid-once", payload: { source_sha256: ROW.source.sha256, recognition_prompt: { fixed_tags: FIXED_TAGS, content: "识图" } } }],
    }
    if (call.url.endsWith("/ocr/completions")) {
      now = 31_000
      return { billing: COMPLETION.billing, completion: answer(unusable.content) }
    }
    return ROW
  })
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await withStubbedDevice(() => runRows({ row_ids: [ROW.id], expected_revisions: [] }, "recognize"))
    assert.equal(result?.error?.code, "workflow_ai_result_unusable")
    const posts = stub.calls.filter((call) => call.url.endsWith("/ocr/completions") && call.method === "POST")
    assert.deepEqual(posts.map((call) => call.headers["Idempotency-Key"]),
      unusable.posts,
      "each contract failure gets at most the original and one retry identity")
    assert.equal(stub.calls.some((call) => call.url.endsWith("/ai/settle")), false)
    assert.equal(stub.calls.filter((call) => call.url.endsWith("/ai/fail")).length, 1)
  } finally { stub.restore() }
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
      assert.equal(
        stub.calls.filter((call) => call.url.endsWith("/ocr/completions")).length,
        bad === "contract" ? 0 : 3,
        "a contract violation never reaches the relay; a paid failure replans and retries to the bound",
      )
    } finally { stub.restore() }
  }
})
