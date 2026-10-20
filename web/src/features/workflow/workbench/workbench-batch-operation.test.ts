import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { runWorkflowOperationBatch, workflowRowsActionRequest } from "../batch-operation"
import { operationBlockerMessage } from "../prepare/execution-context"
import { publishStateDetail } from "../model/workflow-readiness"
import {
  idleLifecycle,
  instance,
  needsPreparation,
  projection,
  row,
} from "./workbench-test-fixtures"
import { harness } from "./workbench-test-harness"

// ---------------------------------------------------------------------------
// Fixed operation command boundary
// ---------------------------------------------------------------------------

test("operation requests freeze Draft IDs, revisions and Store routing together", () => {
  const target = row(1)
  const product = instance(target, { ...idleLifecycle, revision: 7, view_revision: 7 })
  product.target_store_id = "store-at-click"
  assert.deepEqual(workflowRowsActionRequest([target], { [target.draftId]: product }), {
    row_ids: [target.draftId],
    expected_revisions: [{ row_id: target.draftId, revision: 7, store_id: "store-at-click" }],
  })
})

test("a structured kernel blocker settles the matching UI row", async () => {
  const target = row(1)
  const product = instance(target)
  let request: unknown
  let settled: { log: string; failed: boolean } | undefined
  const failures = await runWorkflowOperationBatch(
    [target],
    {
      drafts: () => ({ [target.draftId]: product }),
      patchRow: () => undefined,
      startRows: () => undefined,
      commitProduct: () => undefined,
      settleProgress: () => undefined,
      settleRow: async (_row, log, failed) => {
        settled = { log, failed }
      },
    },
    async (value) => {
      request = value
      return [{
        row_id: target.draftId,
        outcome: "blocked",
        blockers: [JSON.stringify("missing_template")],
      }]
    },
    { status: "running" },
    "切片已完成",
  )
  assert.deepEqual(request, workflowRowsActionRequest([target], { [target.draftId]: product }))
  assert.deepEqual(settled, { log: "缺少 PSD 模板，请先选择模板再切片", failed: true })
  assert.equal(failures.length, 1)
  assert.equal(operationBlockerMessage("not-json"), "当前状态不允许执行")
  assert.equal(operationBlockerMessage("validation_stale"), "字段需要重新校验，请保存字段后再发送")
  assert.equal(
    operationBlockerMessage("missing_render_evidence"),
    "缺少已提交的切片，请先完成切片再上传",
  )
  assert.equal(
    operationBlockerMessage(JSON.stringify({ missing_render_evidence: null })),
    "缺少已提交的切片，请先完成切片再上传",
  )
})

// Rendering (`media.render`) and delivery (`media.upload`) are browser-executor
// Jobs; guided preparation reaches them only through Cloud's `prepare` combinator.

test("guided preparation uses the fixed Cloud combinator", () => {
  const source = readFileSync(new URL("../prepare/use-preparation.ts", import.meta.url), "utf8")
  const start = source.indexOf("async function runGuidedPreparation")
  const end = source.indexOf("function stopPreparation", start)
  const guided = source.slice(start, end)
  assert.match(guided, /workflowActions\.workflowPrepare/)
  assert.doesNotMatch(guided, /runAiRows\(|runRenderRows\(|runDeliverRows\(/)
})

test("an older batch tail cannot repaint the newer streamed result as failed", async () => {
  const target = row(1)
  const scene = harness([target], { [target.draftId]: instance(target) })
  const current = projection(target, { ...idleLifecycle, revision: 12, view_revision: 12, ai: "ready" }, { name: { kind: "text", value: "new title" } })
  const stale = projection(target, { ...idleLifecycle, revision: 11, view_revision: 11, ai: "failed" }, { name: { kind: "text", value: "old title" } })
  const failures = await runWorkflowOperationBatch([target], {
    ...scene.deps,
    settleRow: async () => { assert.fail("a stale tail must not trigger an error repaint or recovery read") },
  }, async (_request, onRow) => {
    onRow({ row_id: target.draftId, outcome: "start", blockers: [], product: current })
    onRow({ row_id: target.draftId, outcome: "start", blockers: [], product: stale, error: { code: "prepare_failed", message: "old failure", remediation: null } })
    return [{ row_id: target.draftId, outcome: "start", blockers: [], product: stale, error: { code: "prepare_failed", message: "old failure", remediation: null } }]
  }, { status: "running" }, "latest complete")
  assert.deepEqual(failures, [])
  assert.equal(scene.products[target.draftId]?.draft.values.name?.value, "new title")
  assert.equal(scene.row(target.id).log, "latest complete")
})

test("a completed operation releases its progress claim even when its snapshot is older", async () => {
  const target = row(1)
  const scene = harness([target], { [target.draftId]: instance(target) })
  const complete = projection(target, { ...idleLifecycle, revision: 11, view_revision: 11, ai: "ready" })
  const outcomes: boolean[] = []
  const result = { row_id: target.draftId, outcome: "start" as const, blockers: [], product: complete }
  await runWorkflowOperationBatch([target], {
    ...scene.deps,
    settleProgress: (_id, failed) => { if (!outcomes.length) outcomes.push(failed) },
  }, async (_request, onRow) => {
    scene.products[target.draftId] = { ...instance(target), lifecycle: { ...idleLifecycle, revision: 12, view_revision: 12 } }
    onRow(result)
    assert.deepEqual(outcomes, [false], "the stream closes this operation immediately")
    return [result]
  }, { status: "running" }, "done")
  assert.deepEqual(outcomes, [false])
  assert.equal(scene.products[target.draftId]?.lifecycle.revision, 12)
})

test("busy interim progress stays pending and does not complete the batch", async () => {
  const target = row(1)
  const scene = harness([target], { [target.draftId]: instance(target) })
  const outcomes: boolean[] = []
  await runWorkflowOperationBatch([target], {
    ...scene.deps,
    settleProgress: (_id, failed) => { outcomes.push(failed) },
  }, async (_request, onRow) => {
    onRow({ row_id: target.draftId, outcome: "wait", noop_reason: "queue_busy", blockers: [], interim: true })
    assert.equal(scene.row(target.id).log, "排队等待，资源可用后自动继续")
    assert.equal(publishStateDetail(idleLifecycle, needsPreparation, scene.row(target.id).log, false).text, "排队等待，自动继续")
    assert.deepEqual(outcomes, [], "waiting is not completion")
    const completed = { row_id: target.draftId, outcome: "start" as const, blockers: [], product: projection(target, { ...idleLifecycle, ai: "ready" }) }
    onRow(completed)
    return [completed]
  }, { status: "running" }, "done")
  assert.ok(outcomes.length > 0)
})

test("preparation feedback names local waiting without settling or losing the other stage", async () => {
  const target = row(1)
  const scene = harness([target], { [target.draftId]: instance(target) })
  const outcomes: boolean[] = []
  const feedback = [{ stage: "render" as const, state: "waiting" as const, message: "等待上传容量，上传完成后自动继续切片", since_ms: 1000 }]
  const failures = await runWorkflowOperationBatch([target], {
    ...scene.deps, settleProgress: (_id, failed) => outcomes.push(failed),
  }, async (_request, onRow) => {
    onRow({ row_id: target.draftId, outcome: "wait", blockers: [], interim: true, preparation_progress: feedback })
    assert.deepEqual(scene.row(target.id).preparationRender, feedback[0])
    assert.deepEqual(outcomes, [])
    const newerFeedback = [{ ...feedback[0]!, message: "等待本机渲染资源" }]
    onRow({ row_id: target.draftId, outcome: "wait", blockers: [], interim: true,
      product: projection(target, { ...idleLifecycle, view_revision: -1 }), preparation_progress: newerFeedback })
    assert.deepEqual(scene.row(target.id).preparationRender, newerFeedback[0], "stale Cloud snapshots must not discard current browser feedback")
    onRow({ row_id: target.draftId, outcome: "wait", blockers: [], interim: true, preparation_progress: feedback })
    onRow({ row_id: target.draftId, outcome: "start", blockers: [], interim: true,
      product: projection(target, { ...idleLifecycle, ai: "ready", stage: "rendering" }) })
    assert.deepEqual(scene.row(target.id).preparationRender, feedback[0], "AI completion must preserve media waiting")
    const result = { row_id: target.draftId, outcome: "start" as const, blockers: [], preparation_progress: [] }
    onRow(result)
    assert.deepEqual(scene.row(target.id).preparationRender, undefined, "completion clears waiting without needing another server projection")
    return [{ ...result, product: projection(target, { ...idleLifecycle, ai: "ready", stage: "rendering" }) }]
  }, { status: "running" }, "准备完成")
  assert.deepEqual(failures, [])
})
