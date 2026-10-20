import assert from "node:assert/strict"
import test from "node:test"
import type {
  WorkflowProductLifecycle,
  WorkflowProductStatusView,
  WorkflowReadinessReport,
} from "@/bindings/commands"
import { settledRowMessage } from "../batch-operation"
import { activeRunnerCount } from "../card-runner"
import { resolvePublishRemediation } from "../model/publish-remediation"
import {
  preparationActivityCopy,
  preparationFailureCopy,
  prepareWaitReason,
  publishStateDetail,
  readinessBlockerCopy,
} from "../model/workflow-readiness"
import { NO_PREPARATION_ACTIVITY } from "../prepare/preparation-tracks"
import { idleLifecycle, needsPreparation, row } from "./workbench-test-fixtures"

test("the runner count keeps concurrent AI visible after render settles the row", () => {
  const target = row(1, { status: "pending" })
  assert.equal(
    activeRunnerCount([target], {
      ai: new Set([target.id]),
      render: new Set(),
      deliver: new Set(),
    }),
    1,
  )
})

test("a Seller exception does not count as an active runner", () => {
  const target = row(1, { status: "exception" })
  assert.equal(activeRunnerCount([target], NO_PREPARATION_ACTIVITY), 0)
})

test("prepare UI reads wait_reason and blocker copy from the ListingRowView report", () => {
  const report = {
    ready_to_publish: false,
    can_start_publish_attempt: false,
    blockers: ["ai_running", "media_pending"],
    allowed_actions: ["prepare", "edit_fields"],
  } as WorkflowReadinessReport
  assert.equal(prepareWaitReason(idleLifecycle, report), "AI 正在识别")
  assert.deepEqual(
    report.blockers.map((blocker) => readinessBlockerCopy[blocker]),
    ["AI 正在识别", "图片渲染与上传尚未开始"],
  )
})

test("accepted products name the seller back office until a mirror SKU exists", () => {
  const report: WorkflowReadinessReport = {
    ready_to_publish: false, can_start_publish_attempt: false,
    blockers: [], allowed_actions: [],
  }
  for (const stage of ["accepted"] as const) {
    const lifecycle = { ...idleLifecycle, stage }
    const detail = publishStateDetail(lifecycle, report, "发送完成", false)
    assert.deepEqual(detail, {
      text: "Ozon 已受理，后续审核与可售以卖家后台为准。",
      fullText: "Ozon 已受理，后续审核与可售以卖家后台为准。",
    })
    assert.doesNotMatch(detail.text, /正在处理|等待 SKU/)
    assert.equal(
      publishStateDetail({ ...lifecycle, ozon_sku: 123 }, report, "发送完成", false).text,
      "商品镜像已有该货号的 SKU，可售状态仍需核对。",
    )
  }
})

test("stopped preparation and recognition noops do not claim missing slices", () => {
  assert.deepEqual(settledRowMessage({ row_id: "row-1", outcome: "noop", noop_reason: "cancelled", blockers: [] }, "准备完成"),
    { message: "准备已停止", failed: false })
  assert.deepEqual(settledRowMessage({ row_id: "row-1", outcome: "noop", blockers: [] }, "识别完成"),
    { message: "当前状态无需重复执行", failed: false })
})

test("a prepare noop with no slices is a failure, not completion", () => {
  const empty = settledRowMessage({
    row_id: "row-1",
    outcome: "noop",
    blockers: [],
    product: { lifecycle: { ...idleLifecycle, media: "ready", image_total: 0, image_completed: 0 } } as WorkflowProductStatusView,
  }, "准备已完成")
  assert.equal(empty.failed, true)
  assert.equal(empty.message, "切片不完整，请重新切片")
  const complete = settledRowMessage({
    row_id: "row-1",
    outcome: "noop",
    blockers: [],
    product: { lifecycle: { ...idleLifecycle, media: "ready", image_total: 6, image_completed: 6 } } as WorkflowProductStatusView,
  }, "准备已完成")
  assert.equal(complete.failed, false)
  assert.equal(complete.message, "当前状态无需重复执行")
})

test("a send refusal is written back into the publish cell of a ready row", () => {
  const ready = { ...idleLifecycle, stage: "ready_to_publish" as const }
  const readyReport: WorkflowReadinessReport = {
        ready_to_publish: true,
    can_start_publish_attempt: true,
    blockers: [],
    allowed_actions: ["publish", "edit_fields"],
  }
  // A ready row with no refusal keeps its title.
  assert.equal(publishStateDetail(ready, readyReport, "", false).text, "可以发送")
  for (const [result, expected] of [
    [{ row_id: "row-1", outcome: "blocked", blockers: [], noop_reason: "revision_mismatch" }, "商品已更新，请刷新后再发送"],
    [{ row_id: "row-1", outcome: "blocked", blockers: ["missing_template"] }, "缺少 PSD 模板，请先选择模板再切片"],
    [{ row_id: "row-1", outcome: "blocked", blockers: ["target_store_missing"] }, "商品尚未绑定目标店铺，请先绑定店铺后再发送"],
    [{ row_id: "row-1", outcome: "blocked", blockers: ["missing_render_evidence"], error: { code: "cloud_validation", message: "当前状态无法执行此操作", remediation: null } }, "缺少已提交的切片，请先完成切片再上传"],
    [{ row_id: "row-1", outcome: "blocked", blockers: [], error: { code: "compose_failed", message: "价格必须大于零", remediation: null } }, "价格必须大于零"],
  ] as const) {
    const message = settledRowMessage({ ...result, blockers: [...result.blockers] }, "发送失败").message
    assert.equal(message, expected)
    const log = `发送未执行：${message}`
    assert.equal(publishStateDetail(ready, readyReport, log, false).text, log)
  }
  // The publish queue writes the refusal onto the row log; the cell must show it.
  const refusal = "货号 SZ-9BXIE0611-0004 已在 Ozon 存在（Ozon SKU 4678734398），未重复发送"
  assert.equal(
    publishStateDetail(ready, readyReport, refusal, false).text,
    refusal,
  )
  // In-flight and restore markers never read as refusals.
  assert.equal(
    publishStateDetail(ready, readyReport, "AI 识别已开始", false).text,
    "可以发送",
  )
})

test("a progress log is not an AI recognition failure reason", () => {
  const detail = publishStateDetail(
    { ...idleLifecycle, ai: "failed" },
    {
      ready_to_publish: false, can_start_publish_attempt: false,
      blockers: ["ai_failed"],
      allowed_actions: ["retry_ai", "edit_fields"],
    },
    "AI 识别已开始",
    true,
  )

  assert.match(detail.text, /AI 识别失败/)
  assert.doesNotMatch(detail.text, /已开始/)
})

/// 待处理 rows in a batch read what they are doing, not 仍需准备 until done: the
/// leg in flight in the order the legs run, then a leg that failed on this
/// device before Cloud has a verdict. Any other phase keeps its own title.
test("the publish column names the preparation leg a 仍需准备 row is on", () => {
  const preparing = { ...idleLifecycle, stage: "recognizing" as const, ai: "running" as const }
  const detail = (tracks: Parameters<typeof preparationActivityCopy>[0]) =>
    publishStateDetail(preparing, needsPreparation, "一键准备已开始", false, tracks).text
  assert.equal(detail({ ai: "running", render: "running", upload: "idle" }), "识别中")
  assert.equal(detail({ ai: "done", render: "running", upload: "idle" }), "切片中")
  assert.equal(detail({ ai: "done", render: "done", upload: "running" }), "上传中")
  assert.equal(detail({ ai: "failed", render: "idle", upload: "idle" }), "识别失败")
  assert.equal(detail({ ai: "done", render: "failed", upload: "idle" }), "切片失败")
  assert.equal(detail({ ai: "done", render: "done", upload: "failed" }), "上传失败")
  assert.equal(preparationFailureCopy({ ai: "done", render: "failed", upload: "idle" }), "切片失败")
  assert.equal(
    preparationFailureCopy({ ai: "running", render: "running", upload: "idle" }),
    undefined,
    "a leg in flight is not a failure",
  )
  assert.equal(detail({ ai: "idle", render: "idle", upload: "idle" }), "仍需准备")
  assert.equal(
    publishStateDetail(preparing, needsPreparation, "一键准备已开始", false).text,
    "仍需准备",
    "without tracks the readiness title stands",
  )
  assert.equal(
    publishStateDetail(
      { ...idleLifecycle, stage: "build_stale" },
      { ...needsPreparation },
      "",
      false,
      { ai: "running", render: "idle", upload: "idle" },
    ).text,
    "可以发送",
    "only 仍需准备 rows read their leg",
  )
})

test("restart and skip logs do not hide an unresolved publish outcome", () => {
  for (const log of [
    "本地源图不可用；已上传媒体仍可发送，重新识别或切片需重新导入",
    "未就绪，已跳过 · 不是 Ozon 拒绝",
  ]) {
    const detail = publishStateDetail(
      { ...idleLifecycle, stage: "outcome_unknown" },
      {
        ready_to_publish: false, can_start_publish_attempt: false,
        blockers: ["outcome_unknown"],
        allowed_actions: ["reconcile"],
      },
      log,
      true,
    )
    assert.equal(detail.text, "已提交 Ozon，结果未返回，系统会自动核对；确认未创建前不要重新发送")
    assert.equal(detail.fullText, detail.text)
    assert.doesNotMatch(detail.text, /源图不可用|已跳过/)
  }
})

test("a recorded failure reason reaches the operator instead of its code", () => {
  // The exact entry a zero wallet writes. It names the number the operator
  // needs and the amount the attempt wanted; the table used to show
  // `失败原因：workflow_quota_exceeded` instead, so a problem they can fix in
  // one click read as "AI is broken".
  const detail = publishStateDetail(
    {
      ...idleLifecycle,
      ai: "failed",
      last_error_code: "workflow_quota_exceeded",
      failure_log: [
        {
          stage: "ai",
          code: "workflow_quota_exceeded",
          message: "钱包余额不足：可用 0 microfen，本次需要预占 400000 microfen",
          occurred_at_ms: 1788138356376,
        },
      ],
    },
    {
      ready_to_publish: false,
      can_start_publish_attempt: false,
      blockers: ["ai_failed"],
      allowed_actions: ["retry_ai", "edit_fields"],
    },
    "",
    true,
  )

  assert.match(detail.text, /钱包余额不足/)
  assert.doesNotMatch(detail.text, /失败原因：workflow_quota_exceeded/)
})

test("a restored operator attestation never falls back to Complete copy", () => {
  const detail = publishStateDetail(
    {
      ...idleLifecycle,
      last_error_code: "OZON_EVIDENCE_ABSENT_OPERATOR_ATTESTED",
    },
    {
      ready_to_publish: false, can_start_publish_attempt: false,
      blockers: ["operator_attested"],
      allowed_actions: [],
    },
    "已恢复 · operator_attested",
    true,
  )

  assert.match(detail.text, /尚未证明 Ozon 已上架/)
  assert.doesNotMatch(detail.fullText, /发送完成|Ozon 已受理/)
})

test("a title-mismatch exception shows both titles instead of the in-flight log", () => {
  const issue: NonNullable<WorkflowProductLifecycle["submission_issue"]> = {
    phase: "submit", code: "OZON_ROW_REJECTED", input_revision: idleLifecycle.revision,
    row_id: "workflow_instance_1", store_id: "store-1", intent_id: "title-intent-1",
    dispatch_evidence: "rejected", scope: "store", allowed_actions: [],
    summary: "本机标题与 Ozon 商品名不一致。本机：「30х40」· Ozon：「40х50」。",
    remediation: "请在原店铺核对 SKU：本机「30х40」与 Ozon「40х50」，确认后修改标题并重新校验。",
    trace_id: "title-trace-1", created_at_ms: 1, credential_revision: 1,
    endpoint: "import", request_hash: "title-request-hash", safe_message: "", retry_after_fallback: false,
  }
  const lifecycle: WorkflowProductLifecycle = {
    ...idleLifecycle, stage: "publish_rejected", submission_issue: issue,
    last_error_code: issue.code, ozon_sku: 4996083345,
  }
  const report: WorkflowReadinessReport = {
    ready_to_publish: false, can_start_publish_attempt: false,
    blockers: ["publish_conflict"], allowed_actions: ["edit_fields"],
  }
  const progress = "Ozon 返回异常 · Task 5488249648 · 队列已安全暂停"
  const detail = publishStateDetail(lifecycle, report, progress, true)
  const remediation = resolvePublishRemediation({ lifecycle, readiness: report, rowLog: progress })

  assert.equal(detail.text, issue.summary)
  assert.match(detail.text, /30х40/)
  assert.match(detail.text, /40х50/)
  assert.doesNotMatch(detail.text, /Task 5488249648/)
  assert.equal(detail.fullText, `${issue.summary} · 当前店铺及绑定该店铺的商品 · ${issue.remediation}`)
  assert.ok(remediation)
  assert.equal(remediation.cause, "structured_issue")
  assert.equal(remediation.reason, issue.summary)
  assert.equal(remediation.scope, "当前店铺及绑定该店铺的商品")
  assert.deepEqual(remediation.steps, [issue.remediation])
  assert.equal(remediation.traceId, issue.trace_id)
  assert.equal(remediation.action, undefined)
  assert.equal(remediation.diagnosticId, undefined)
})

test("an unclassified historical title detail remains contract-invalid and actionless", () => {
  const lifecycle: WorkflowProductLifecycle = {
    ...idleLifecycle,
    stage: "publish_rejected",
    last_error_code: "OZON_RECONCILE_CONFLICT",
    last_error_detail:
      "本机标题与 Ozon 商品名不一致。本机：「30х40」· Ozon：「40х50」。请打开 SKU 核对后再改标题或重发。",
    ozon_sku: 4996083345,
  }
  const report: WorkflowReadinessReport = {
    ready_to_publish: false, can_start_publish_attempt: false,
    blockers: ["publish_conflict"], allowed_actions: ["edit_fields"],
  }
  const progress = "Ozon 返回异常 · Task 5488249648 · 队列已安全暂停"
  const detail = publishStateDetail(
    lifecycle, report, progress,
    true,
  )
  const remediation = resolvePublishRemediation({ lifecycle, readiness: report, rowLog: progress })

  assert.match(detail.text, /发布结果与当前接口合同不符/)
  assert.match(detail.fullText, /联系管理员|核对/)
  assert.ok(remediation)
  assert.equal(remediation.cause, "contract_invalid")
  assert.equal(remediation.action, undefined)
  assert.equal(remediation.diagnosticId, undefined)
  assert.equal(remediation.reportable, true)
  assert.equal(remediation.diagnosticCode, "contract_violation")
  assert.doesNotMatch(detail.fullText, /30х40|40х50|OZON_RECONCILE_CONFLICT|Task 5488249648/)
  assert.doesNotMatch(JSON.stringify(remediation), /30х40|40х50|OZON_RECONCILE_CONFLICT|Task 5488249648/)
})
