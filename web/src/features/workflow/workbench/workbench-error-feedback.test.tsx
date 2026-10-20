import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { toast } from "@/components/ui/toast"
import { preparationBatch } from "../prepare/preparation-batch"
import { createPreparationTracks } from "../prepare/preparation-tracks"
import { errorFields } from "../prepare/execution-context"
import { runWorkflowOperationBatch } from "../batch-operation"
import { instance, row } from "./workbench-test-fixtures"
import { harness } from "./workbench-test-harness"
import { listingWorkbenchScope, patchListingWorkbench, resetListingWorkbench } from "./listing-workbench-store"
import { RowErrorFeedback } from "./row-error-feedback"

const refusal = { code: "prepare_failed", message: "图片处理失败", remediation: "请检查图片后重试。" }

test("one row receipt survives streamed and returned settlement and reaches reporting with draft/card context", async () => {
  const target = row(1)
  const scene = harness([target], { [target.draftId]: instance(target) })
  const report = mock.method(console, "log", () => {})
  let streamedId: string | undefined
  try {
    const result = { row_id: target.draftId, outcome: "blocked" as const, blockers: [], error: errorFields({ ...refusal, code: "cloud_gateway", serverCode: "receipt_stream_test", status: 502, traceId: "trace-502" }) }
    const failures = await runWorkflowOperationBatch([target], {
      ...scene.deps, feedbackContext: { stage: "ai", cardId: "card-1" },
      settleRow: async (target, log) => { scene.deps.patchRow(target.id, { log, status: "failed" }) },
    }, async (_request, onRow) => {
      onRow(result)
      streamedId = scene.row(target.id).errorFeedback?.errorId
      onRow(result)
      return [result]
    }, { status: "running" }, "识别完成")
    assert.match(streamedId!, /^[0-9]{20}$/)
    assert.equal(scene.row(target.id).errorFeedback?.errorId, streamedId)
    assert.equal(scene.row(target.id).errorFeedback?.traceId, "trace-502")
    assert.equal(scene.row(target.id).errorFeedback?.status, 502)
    assert.equal(scene.row(target.id).errorFeedback?.code, "receipt_stream_test")
    assert.match(String(report.mock.calls[0]?.arguments[0]), /traceId=trace-502/)
    assert.equal(failures.length, 1)
    assert.equal(report.mock.calls.length, 1)
    assert.match(String(report.mock.calls[0]?.arguments[0]), new RegExp(`\\[feedback\\].*errorId=${streamedId}.*row=${target.draftId}.*card=card-1`))
    await runWorkflowOperationBatch([target], scene.deps, async () => {
      assert.equal(scene.row(target.id).errorFeedback, undefined, "new attempt clears the previous receipt")
      return [{ ...result, error: undefined, outcome: "noop", noop_reason: "cancelled" }]
    }, { status: "running" }, "识别完成")
    assert.equal(scene.row(target.id).errorFeedback, undefined)
  } finally { report.mock.restore() }
})

test("thrown batch errors produce distinct image receipts but never report an old card scope", async () => {
  const targets = [row(1), row(2)]
  const scene = harness(targets, Object.fromEntries(targets.map(target => [target.draftId, instance(target)])))
  const report = mock.method(console, "log", () => {})
  const deps = { ...scene.deps, settleRow: async () => {} }
  try {
    await runWorkflowOperationBatch(targets, deps, async () => { throw { ...refusal, code: "receipt_throw_test" } }, {}, "准备完成")
    const ids = targets.map(target => scene.row(target.id).errorFeedback?.errorId)
    assert.equal(new Set(ids).size, 2)
    assert.equal(report.mock.calls.length, 2)
    await runWorkflowOperationBatch(targets, deps, async () => {
      resetListingWorkbench()
      throw { ...refusal, code: "receipt_throw_test" }
    }, {}, "准备完成")
    assert.equal(report.mock.calls.length, 2)
  } finally { report.mock.restore() }
})

test("row receipt displays labeled safe copy and an unknown result never invites resubmission", () => {
  const feedback = { errorId: "00000000000000000001", code: "prepare_failed", outcome: "unknown" as const, summary: "操作未完成", action: "重试", traceId: "technical-trace" }
  const markup = renderToStaticMarkup(createElement(RowErrorFeedback, { feedback, unknownOutcome: true }))
  assert.match(markup, /原因/)
  assert.match(markup, /建议/)
  assert.match(markup, /编号/)
  assert.match(markup, /00000000000000000001/)
  assert.match(markup, /刷新核对结果，请勿重复提交/)
  assert.doesNotMatch(markup, /technical-trace|prepare_failed|>重试</)
})


test("errorFields ignores inherited transport metadata and never invokes error getters", () => {
  const inherited = Object.create({ traceId: "inherited", status: 502, serverCode: "inherited" })
  Object.defineProperty(inherited, "traceId", { get: () => assert.fail("must not invoke getter") })
  assert.deepEqual(errorFields(inherited), { code: "workflow_executor_failed", message: "图片处理失败", remediation: null })
  assert.deepEqual(errorFields({ code: "gateway", traceId: "https://secret", status: 600, serverCode: "bad code" }),
    { code: "gateway", message: "图片处理失败", remediation: null })
})


test("batch notice shows only the failure count and routes details to images with card context", () => {
  resetListingWorkbench()
  patchListingWorkbench({ cardId: "batch-feedback-card" })
  const logs = mock.method(console, "log", () => {})
  const notices = mock.method(toast, "add", () => "notice")
  try {
    const batch = preparationBatch({ cardId: "batch-feedback-card",
      preparationTracks: { current: createPreparationTracks() }, guidedPreparationLock: { current: false },
      activeWork: { current: new Set() }, pendingFailures: { current: { ai: [], render: [], deliver: [] } },
      pendingFailureScope: { current: listingWorkbenchScope() },
    })
    batch.finishPreparationBatch("ai", ["first raw failure", "second raw failure"], "识别")
    const notice = notices.mock.calls[0]?.arguments[0]
    assert.equal(notice?.title, "2 个商品识别失败")
    const markup = renderToStaticMarkup(createElement("div", null, notice?.description))
    assert.match(markup, /查看各图片的错误详情。/)
    assert.doesNotMatch(markup, /first raw failure|second raw failure/)
    assert.equal(logs.mock.calls.length, 1)
    assert.ok(logs.mock.calls.some(call => /\[notify\].*code=preparation_failed.*stage=prepare.*card=batch-feedback-card/.test(String(call.arguments[0]))))
  } finally { logs.mock.restore(); notices.mock.restore(); resetListingWorkbench() }
})
