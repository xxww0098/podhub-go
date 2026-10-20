/** Cloud planning, preflight, view ordering and row feedback.
 * Tests cross the runRows interface; HTTP, OPFS and rendering use the existing recorded adapters.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { route } from "@/api/routes"
import type { WorkflowOperationRowResult } from "@/bindings/commands"
import { RECOGNITION_CONTRACT_VERSION } from "./ai-job"
import { requestStop, setCardContext } from "./execution-context"
import { RENDERER_CONTRACT_VERSION } from "./media-job"
import { waitLabel } from "./executor/row-feedback"
import {
  COMPLETION,
  FIXED_TAGS,
  grantedClaim,
  RECOGNISED,
  record,
  ROW,
  SLICE_DIGEST,
  withStubbedDevice,
} from "./executor-test-support"

test("waiting still carries out queued browser jobs after a reload", async () => {
  setCardContext({ psdTemplateSha256: "template-sha" })
  const stub = record((call) => {
    if (call.url.endsWith("/prepare")) {
      return { outcome: "waiting", jobs: [{ id: "job-1", kind: "ai.recognize", aggregate_id: "row-1", aggregate_type: "listing_row", input_revision: 9, state: "queued", attempt: 0, idempotency_key: "recognize:v1:row-1:9:ai:v2:source-sha:prompt-sha:browser-image-v1_ocr-v1", payload: { recognition_prompt: { prompt_id: "prompt-1", fixed_tags: FIXED_TAGS, content: "识图提示词", sha256: "prompt-sha" }, executor: "browser", pinned_revision: 9, source_sha256: "source-sha", psd_template_sha256: "template-sha", renderer_contract_version: RENDERER_CONTRACT_VERSION }, updated_at_ms: 0 }] }
    }
    if (call.url.endsWith("/ocr/completions")) return COMPLETION
    if (call.url.endsWith("/ai/settle")) return ROW
    return ROW
  })
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await withStubbedDevice(() =>
      runRows({ row_ids: ["row-1"], expected_revisions: [{ row_id: "row-1", revision: 9 }] }, "recognize"),
    )
    assert.equal(result!.outcome, "start")
    assert.equal(result!.job_id, "job-1")
    assert.ok(stub.calls.some((call) => call.url.endsWith("/ocr/completions")))
  } finally {
    stub.restore()
  }
})

test("prepare and AI settlement recover expired fields without buying recognition twice", async () => {
  setCardContext({ psdTemplateSha256: "" })
  let plans = 0
  let settles = 0
  const missing = () => new Response(JSON.stringify({ code: "schema_sync_required", error: "目录已过期" }), { status: 409 })
  const coordinate = { descriptionCategoryId: 42, typeId: 73, language: "zh_hans" }
  const stub = record((call) => {
    if (call.url.endsWith("/prepare")) return ++plans === 1 ? missing() : { outcome: "running", jobs: [{
      id: "catalog-job", kind: "ai.recognize", idempotency_key: "one-purchase", payload: {
        source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "识图提示词" },
      },
    }] }
    if (call.url.endsWith("/ocr/completions")) return COMPLETION
    if (call.url.endsWith("/ai/settle")) return ++settles === 1 ? missing() : RECOGNISED
    if (call.url.startsWith(route("catalogSchema"))) return {
      description_category_id: 42, type_id: 73, language: "zh_hans", fetched_at_ms: 1, fields: [],
    }
    return { ...ROW, payload: coordinate }
  })
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await withStubbedDevice(() => runRows({ row_ids: [ROW.id], expected_revisions: [] }, "recognize"))
    assert.equal(result?.error, undefined)
    assert.equal(result?.product?.lifecycle.ai, "ready")
    assert.equal(plans, 2)
    assert.equal(settles, 2)
    assert.equal(stub.calls.filter((call) => call.url.endsWith("/ocr/completions")).length, 1)
    const writes = stub.calls.filter((call) => call.url.endsWith("/ai/settle"))
    assert.deepEqual(writes[0]!.body, writes[1]!.body, "retry consumes the same paid answer and Job lease")
    assert.deepEqual(stub.calls.filter((call) => call.url.startsWith(route("catalogSchema"))).map((call) => call.url), [
      `${route("catalogSchema")}?descriptionCategoryId=42&typeId=73&language=zh_hans`,
      `${route("catalogSchema")}?descriptionCategoryId=42&typeId=73&language=zh_hans`,
    ])
  } finally {
    stub.restore()
  }
})

test("stop while refreshing expired fields prevents another prepare request", async () => {
  setCardContext({ psdTemplateSha256: "" })
  let releaseSchema!: () => void
  const heldSchema = new Promise<void>((resolve) => { releaseSchema = resolve })
  let sawSchema!: () => void
  const schemaStarted = new Promise<void>((resolve) => { sawSchema = resolve })
  let plans = 0
  const stub = record(async (call) => {
    if (call.url.endsWith("/prepare")) return ++plans === 1
      ? new Response(JSON.stringify({ code: "schema_sync_required", error: "目录已过期" }), { status: 409 })
      : { outcome: "ready", jobs: [] }
    if (call.url.startsWith(route("catalogSchema"))) {
      sawSchema()
      await heldSchema
      return { description_category_id: 42, type_id: 73, language: "zh_hans", fetched_at_ms: 1, fields: [] }
    }
    return { ...ROW, payload: { descriptionCategoryId: 42, typeId: 73, language: "zh_hans" } }
  })
  try {
    const { runRows } = await import("./run-rows")
    const running = withStubbedDevice(() => runRows({ row_ids: [ROW.id], expected_revisions: [] }, "recognize"))
    await schemaStarted
    requestStop([ROW.id])
    releaseSchema()
    const [result] = await running
    assert.equal(plans, 1, "Stop must prevent the retry from enqueueing work")
    assert.equal(stub.calls.some((call) => call.url.endsWith("/claim") || call.url.endsWith("/ocr/completions")), false)
    assert.equal(result?.outcome, "noop")
    assert.equal(result?.noop_reason, "cancelled")
  } finally {
    releaseSchema()
    stub.restore()
  }
})

test("a verb with no template refuses before it spends a pin", async () => {
  setCardContext({ psdTemplateSha256: "" })
  const stub = record(() => ROW)
  try {
    const { runRows } = await import("./run-rows")
    const results = await runRows(
      { row_ids: ["row-1"], expected_revisions: [{ row_id: "row-1", revision: 9 }] },
      "slice",
    )
    assert.deepEqual(results, [{ row_id: "row-1", outcome: "blocked", blockers: ["missing_template"] }])
    assert.deepEqual(stub.calls, [])
  } finally {
    stub.restore()
    setCardContext({ psdTemplateSha256: "" })
  }
})

test("slice refuses an unisolated browser before it creates a Cloud job", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "crossOriginIsolated")
  Object.defineProperty(globalThis, "crossOriginIsolated", { configurable: true, value: false })
  setCardContext({ psdTemplateSha256: "template-sha" })
  const stub = record(() => ROW)
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await runRows({ row_ids: ["row-1"], expected_revisions: [] }, "slice")
    assert.equal(result?.outcome, "blocked")
    assert.equal(result?.error?.code, "RENDER_ISOLATION_REQUIRED")
    assert.match(result?.error?.message ?? "", /Chrome 或 Edge/)
    assert.deepEqual(stub.calls, [])
  } finally {
    if (previous) Object.defineProperty(globalThis, "crossOriginIsolated", previous)
    else Reflect.deleteProperty(globalThis, "crossOriginIsolated")
    stub.restore()
  }
})

test("prepare keeps AI but refuses render in an unisolated browser", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "crossOriginIsolated")
  Object.defineProperty(globalThis, "crossOriginIsolated", { configurable: true, value: false })
  setCardContext({ psdTemplateSha256: "template-sha" })
  const stub = record(call => {
    if (call.url.endsWith("/prepare")) return { outcome: "running", jobs: [
      { id: "job-ai", kind: "ai.recognize", payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "prompt" } } },
      { id: "job-render", kind: "media.render", payload: { psd_template_sha256: "template-sha" } },
    ] }
    if (call.url.endsWith("/ocr/completions")) return COMPLETION
    if (call.url.endsWith("/ai/settle")) return RECOGNISED
    return ROW
  })
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await withStubbedDevice(() => runRows({ row_ids: ["row-1"], expected_revisions: [] }, "prepare"))
    assert.equal(result?.product?.lifecycle.ai, "ready")
    assert.equal(result?.error?.code, "RENDER_ISOLATION_REQUIRED")
    assert.match(result?.error?.message ?? "", /Chrome 或 Edge/)
    assert.equal(stub.calls.filter(call => call.url.endsWith("/ocr/completions")).length, 1)
    assert.equal(stub.calls.some(call => call.url.endsWith("/media")), false)
  } finally {
    if (previous) Object.defineProperty(globalThis, "crossOriginIsolated", previous)
    else Reflect.deleteProperty(globalThis, "crossOriginIsolated")
    stub.restore()
  }
})

test("the batch tail keeps the newest Cloud view when edit revisions are equal", async () => {
  const previous = globalThis.fetch
  const job = { id: "view-order-ai", kind: "ai.recognize", payload: {
    source_sha256: "source-sha", recognition_contract_version: RECOGNITION_CONTRACT_VERSION,
    recognition_prompt: { fixed_tags: FIXED_TAGS, content: "prompt" },
  } }
  globalThis.fetch = (async input => {
    const url = String(input)
    const data = url.endsWith("/prepare") ? { outcome: "running", jobs: [job] }
      : url.endsWith("/claim-window") ? [grantedClaim(job)]
      : url.endsWith("/ocr/completions") ? COMPLETION
      : url.endsWith("/ai/settle") ? { ...RECOGNISED, revision: 12, view_revision: 21 }
      : url.endsWith("/ai/ocr/uploads") ? { upload_ticket: "view-order-ocr", upload: {
          url: "https://s3.example.invalid/ocr", headers: { content_type: "image/png", if_none_match: "*" },
          expires_at_ms: Date.now() + 600000, } }
      : url === "https://s3.example.invalid/ocr" ? null
      : { ...ROW, revision: 12, view_revision: 20 }
    return new Response(JSON.stringify({ data }), { status: 200 })
  }) as typeof fetch
  try {
    const { runRows } = await import("./run-rows")
    const streamed: WorkflowOperationRowResult[] = []
    const [result] = await withStubbedDevice(() => runRows(
      { row_ids: ["row-1"], expected_revisions: [] }, "prepare", row => streamed.push(row),
    ))
    assert.equal(result?.product?.lifecycle.ai, "ready")
    assert.equal(result?.product?.lifecycle.revision, 12)
    assert.equal(result?.product?.lifecycle.view_revision, 21)
    assert.deepEqual(streamed.filter(row => row.product).map(row => row.product?.lifecycle.view_revision), [20, 21, 21])
  } finally { globalThis.fetch = previous }
})

test("parallel stages stream increasing Cloud revisions and retry a render CAS without rerendering", async () => {
  setCardContext({ psdTemplateSha256: "template-sha" })
  let refused = false
  let renders = 0
  let manifest: unknown
  const stub = record((call) => {
    if (call.url.endsWith("/prepare")) {
      const operation = call.body?.operation
      if (operation === "prepare" || operation === "recognize") return { outcome: "running", jobs: [
        { id: "job-ai", kind: "ai.recognize", payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "prompt" } } },
        { id: "job-render", kind: "media.render", payload: { psd_template_sha256: "template-sha" } },
      ] }
      if (operation === "slice") return { outcome: "running", jobs: [
        { id: "job-render", kind: "media.render", payload: { psd_template_sha256: "template-sha" } },
      ] }
      if (operation === "upload") return { outcome: "running", jobs: [
        { id: "job-upload", kind: "media.upload", payload: { manifest_digest: "manifest:test:job-render", manifest } },
      ] }
      return { outcome: "prepared", jobs: [] }
    }
    if (call.url.endsWith("/ocr/completions")) return COMPLETION
    if (call.url.endsWith("/ai/settle")) return RECOGNISED
    if (call.url.endsWith("/media")) {
      if (!refused) { refused = true; return { applied: false, row: RECOGNISED, jobs: [] } }
      manifest = { renderer: call.body.payload.render_evidence.manifest, images: call.body.payload.media.images }
      return { applied: true, row: RECOGNISED, jobs: [] }
    }
    if (call.method === "PUT") return { publicUrl: "https://cdn.invalid/image.jpg", objectKey: "image.jpg", accountId: "account" }
    return refused ? RECOGNISED : ROW
  })
  try {
    const { runRows } = await import("./run-rows")
    const streamed: WorkflowOperationRowResult[] = []
    const results = await withStubbedDevice(() => runRows({ row_ids: ["row-1"], expected_revisions: [] }, "prepare", row => streamed.push(row)), {}, {
      renderProduct: async () => { renders += 1; return { manifest: {}, slices: [{ index: 0, groupName: "main", fileName: "image.jpg", width: 1, height: 1, contentHash: `sha256:${SLICE_DIGEST}`, bytes: new Uint8Array([1]) }] } },
    })
    const writes = stub.calls.filter(call => call.url.endsWith("/media"))
    assert.equal(writes.length, 2)
    assert.deepEqual(writes[0]!.body.payload, writes[1]!.body.payload)
    assert.equal(renders, 1)
    assert.equal(results[0]?.error, undefined)
    assert.equal(results[0]?.product?.lifecycle.media, "ready")
    assert.equal(results[0]?.product?.lifecycle.ai, "ready")
    assert.equal(stub.calls.some(call => call.method === "PATCH"), false)
    assert.deepEqual(results[0]?.preparation_progress, [])
    assert.ok(streamed.some(row => row.preparation_progress?.some(progress => progress.stage === "ai" && progress.state === "running")))
    assert.ok(streamed.some(row => row.preparation_progress?.some(progress => progress.stage === "render" && progress.state === "running")))
    assert.ok(streamed.some(row => row.preparation_progress?.some(progress => progress.stage === "upload" && progress.message.includes("已确认上传"))))
    const revisions = streamed.flatMap(row => row.product ? [row.product.lifecycle.revision] : [])
    assert.deepEqual(revisions, [...revisions].sort((a, b) => a - b))
    // The last interim stream carries the final row state; only its flag differs.
    assert.deepEqual(results.map(row => ({ ...row, interim: true })), [{ ...streamed.at(-1), interim: true }])
  } finally { stub.restore() }
})

test("Prepare executes its available AI rail while reporting the missing template", async () => {
  setCardContext({ psdTemplateSha256: "" })
  const stub = record(call => {
    if (call.url.endsWith("/prepare")) return {
      outcome: "running",
      issues: [{ kind: "media.render", blockers: ["missing_template"] }],
      jobs: [{ id: "partial-ai", kind: "ai.recognize", idempotency_key: "partial-key", payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "prompt" } } }],
    }
    if (call.url.endsWith("/ocr/completions")) return COMPLETION
    if (call.url.endsWith("/ai/settle")) return RECOGNISED
    return ROW
  })
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await withStubbedDevice(() => runRows({ row_ids: ["row-1"], expected_revisions: [] }, "prepare"))
    assert.equal(result?.outcome, "blocked")
    assert.deepEqual(result?.blockers, ["missing_template"])
    assert.equal(result?.product?.lifecycle.ai, "ready")
    assert.equal(stub.calls.filter(call => call.url.endsWith("/ocr/completions")).length, 1)
  } finally { stub.restore() }
})

test("a long cooldown is reported in minutes, a short one in seconds", () => {
  // The AI relay's unbilled ceiling answers 429 with up to an hour of
  // Retry-After; "3600 秒" is not a readable wait, "60 分钟" is.
  assert.equal(waitLabel(0), "1 秒")
  assert.equal(waitLabel(3_000), "3 秒")
  assert.equal(waitLabel(90_000), "90 秒")
  assert.equal(waitLabel(3_600_000), "60 分钟")
})

test("automation planning keeps execution proof in headers, not the durable command body", async () => {
  const scope = { operationId: "operation-1", runtimeId: "tab-1", claimEpoch: 7 }
  const stub = record(() => ({ outcome: "prepared", jobs: [] }))
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await runRows({ row_ids: [ROW.id], expected_revisions: [] }, "recognize", undefined, scope)
    assert.equal(result?.outcome, "noop")
    const plans = stub.calls.filter(call => call.url.endsWith("/prepare"))
    assert.equal(plans.length, 1)
    const plan = plans[0]!
    assert.equal(plan.headers["X-Automation-Operation"], scope.operationId)
    assert.equal(plan.headers["X-Automation-Runtime"], scope.runtimeId)
    assert.equal(plan.headers["X-Automation-Claim-Epoch"], String(scope.claimEpoch))
    assert.equal(typeof plan.body.command_id, "string")
    assert.equal(plan.body.operation, "recognize")
    assert.equal(plan.body.renderer_contract_version, RENDERER_CONTRACT_VERSION)
    assert.equal("operation_id" in plan.body || "runtime_id" in plan.body || "claim_epoch" in plan.body, false)
  } finally { stub.restore() }
})

test("mutating an observer's progress snapshot cannot change later row feedback", async () => {
  const snapshots: WorkflowOperationRowResult[] = []
  const stub = record(() => ({ outcome: "prepared", jobs: [] }))
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await runRows({ row_ids: [ROW.id], expected_revisions: [] }, "recognize", row => {
      snapshots.push(structuredClone(row))
      const stage = row.preparation_progress?.[0]
      if (stage) { stage.state = "failed"; stage.message = "observer poison" }
    })
    assert.ok(snapshots.some(row => row.preparation_progress?.some(stage => stage.state === "running")))
    assert.ok(snapshots.every(row => row.preparation_progress?.every(stage => stage.message !== "observer poison")))
    assert.deepEqual(result?.preparation_progress, [])
    assert.equal(result?.error, undefined)
  } finally { stub.restore() }
})
