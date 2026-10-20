import assert from "node:assert/strict"
import test from "node:test"
import type { WorkflowProductLifecycle, WorkflowReadinessReport } from "@/bindings/commands"
import { preparationFailureCopy, publishStateDetail } from "./workflow-readiness"

const baseLifecycle = {
  revision: 3, view_revision: 3, stage: "publish_rejected", ai: "ready", media: "ready",
  fields: "valid", image_total: 8, image_completed: 8, images: [], failure_log: [],
  ai_candidates: [], product_videos: [],
} satisfies WorkflowProductLifecycle

const exceptional = (blockers: WorkflowReadinessReport["blockers"]): WorkflowReadinessReport => ({
  ready_to_publish: false, can_start_publish_attempt: false,
  blockers, allowed_actions: [],
})

test("recovered preparation history cannot replace the current failure reason", () => {
  const rows: Array<[WorkflowProductLifecycle, WorkflowReadinessReport, string, RegExp, RegExp]> = [
    [
      {
        ...baseLifecycle,
        failure_log: [{ stage: "media", code: "cloud_validation", message: "昨晚媒体切片清单不一致", occurred_at_ms: 1 }],
      },
      exceptional(["publish_conflict"]),
      "已恢复 · conflict",
      /发布结果存在冲突/,
      /昨晚媒体切片/,
    ],
    [
      {
        ...baseLifecycle, stage: "publish_rejected",
        failure_log: [{ stage: "media", code: "cloud_validation", message: "昨晚媒体切片清单不一致", occurred_at_ms: 1 }],
      },
      exceptional(["publish_rejected"]),
      "已恢复 · rejected",
      /发布未成功/,
      /昨晚媒体切片/,
    ],
    [
      { ...baseLifecycle, stage: "publish_rejected" },
      exceptional(["publish_rejected"]),
      "当前图片对象不存在，请重新上传",
      /当前图片对象不存在，请重新上传/,
      /发布未成功/,
    ],
    [
      {
        ...baseLifecycle, stage: "recognition_failed", media: "failed",
        failure_log: [
          { stage: "media", code: "cloud_validation", message: "媒体切片清单不一致", remediation: "请重新切片", occurred_at_ms: 2 },
          { stage: "ai", code: "old_ai_error", message: "已恢复的识别错误", occurred_at_ms: 3 },
        ],
      },
      exceptional(["media_failed"]),
      "",
      /媒体切片清单不一致.*请重新切片/,
      /失败原因：/,
    ],
    [
      {
        ...baseLifecycle, stage: "recognition_failed", ai: "failed",
        failure_log: [{ stage: "ai", code: "workflow_quota_exceeded", message: "钱包余额不足", remediation: "请充值后重试", occurred_at_ms: 3 }],
      },
      exceptional(["ai_failed"]),
      "",
      /钱包余额不足.*请充值后重试/,
      /失败原因：/,
    ],
  ]

  for (const [lifecycle, report, rowLog, expected, absent] of rows) {
    const original = JSON.stringify(lifecycle.failure_log)
    const detail = publishStateDetail(lifecycle, report, rowLog, true)
    assert.match(detail.text, expected)
    assert.doesNotMatch(detail.text, absent)
    assert.equal(JSON.stringify(lifecycle.failure_log), original)
  }
})

test("transient refresh logs do not hide an unresolved publish outcome", () => {
  const detail = publishStateDetail(
    { ...baseLifecycle, stage: "outcome_unknown" },
    {
      ready_to_publish: false, can_start_publish_attempt: false,
      blockers: [], allowed_actions: [],
    },
    "发送状态已刷新",
    true,
  )

  assert.equal(detail.text, "已提交 Ozon，结果未返回，系统会自动核对；确认未创建前不要重新发送")
  assert.doesNotMatch(detail.fullText, /发送状态已刷新/)
})

test("unknown outcome authority dominates stale server error detail", () => {
  const detail = publishStateDetail(
    {
      ...baseLifecycle,
      last_error_code: "publish_timeout",
      last_error_detail: "发送超时，请检查发送记录",
    },
    {
      ready_to_publish: false, can_start_publish_attempt: false,
      blockers: ["outcome_unknown"], allowed_actions: ["reconcile"],
    },
    "",
    true,
  )

  assert.equal(detail.text, "已提交 Ozon，结果未返回，系统会自动核对；确认未创建前不要重新发送")
  assert.doesNotMatch(detail.fullText, /publish_timeout|发送超时/)
  assert.match(detail.text, /不要重新发送/)
})

test("the projected reconcile sentence is the unknown detail", () => {
  for (const sentence of [
    "未取得响应；正在自动核对是否已创建，不会自动重发",
    "自动核对已停止；请在卖家后台查看该货号，不会自动重发",
  ]) {
    const detail = publishStateDetail(
      { ...baseLifecycle, stage: "outcome_unknown", last_error_detail: sentence },
      exceptional(["outcome_unknown"]),
      "发送超时，请检查发送记录",
      true,
    )
    assert.equal(detail.text, sentence)
    assert.doesNotMatch(detail.fullText, /发送超时/)
  }
})

test("a local failed leg while Cloud awaits content reads as exactly the glyph's words", () => {
  // The cell hides a detail equal to `preparationFailureCopy`, so the inline
  // ⚠ glyph is not echoed by a short paragraph outside the remediation.
  for (const [tracks, words] of [
    [{ ai: "failed", render: "idle", upload: "idle" }, "识别失败"],
    [{ ai: "done", render: "failed", upload: "idle" }, "切片失败"],
    [{ ai: "done", render: "done", upload: "failed" }, "上传失败"],
  ] as const) {
    assert.equal(preparationFailureCopy(tracks), words)
    const detail = publishStateDetail({ ...baseLifecycle, stage: "awaiting_content" }, exceptional(["media_pending"]), "", false, tracks)
    assert.equal(detail.text, words)
  }
  assert.equal(preparationFailureCopy({ ai: "done", render: "done", upload: "done" }), undefined)
})

const PSD_REFUSAL = "发送未执行：PSD 尚未云端保存或未绑定该类目，请重新绑定模板"
const KILL_DETAIL = "上次发送：Ozon 写入已被暂停；等待维护解除后重新发送。此后草稿已修改，请核对后重新发送"

test("the current pre-dispatch refusal beats an older rejection and drops its code", () => {
  const detail = publishStateDetail(
    { ...baseLifecycle, last_error_code: "OZON_WRITES_DISABLED", last_error_detail: KILL_DETAIL },
    exceptional(["publish_rejected"]),
    PSD_REFUSAL,
    true,
  )
  assert.equal(detail.text, PSD_REFUSAL)
  assert.equal(detail.fullText, PSD_REFUSAL)
  assert.doesNotMatch(detail.fullText, /OZON_WRITES_DISABLED|写入已被暂停/)
})

test("durable submission evidence is never replaced by a stale refusal line", () => {
  const unknown = publishStateDetail(
    { ...baseLifecycle, stage: "outcome_unknown" },
    exceptional(["outcome_unknown"]),
    PSD_REFUSAL,
    true,
  )
  assert.equal(unknown.text, "已提交 Ozon，结果未返回，系统会自动核对；确认未创建前不要重新发送")

  const unknownBlocker = publishStateDetail(
    { ...baseLifecycle, last_error_code: "publish_timeout", last_error_detail: "发送超时，请检查发送记录" },
    exceptional(["outcome_unknown"]),
    PSD_REFUSAL,
    true,
  )
  assert.equal(unknownBlocker.text, "已提交 Ozon，结果未返回，系统会自动核对；确认未创建前不要重新发送")

  const attested = publishStateDetail({ ...baseLifecycle, stage: "operator_attested" }, exceptional(["operator_attested"]), PSD_REFUSAL, true)
  assert.doesNotMatch(attested.text, /PSD/)

  for (const [stage, text] of [["queued", "等待发送，尚未派发"], ["submitting", "已提交，等待 Ozon 回执"]] as const) {
    assert.equal(publishStateDetail({ ...baseLifecycle, stage }, exceptional([]), PSD_REFUSAL, false).text, text)
  }
})

test("current dispatch evidence overrides stale accepted logs", () => {
  for (const [stage, text] of [
    ["queued", "等待发送，尚未派发"],
    ["submitting", "已提交，等待 Ozon 回执"],
    ["outcome_unknown", "已提交 Ozon，结果未返回，系统会自动核对；确认未创建前不要重新发送"],
  ] as const) {
    const unknown = stage === "outcome_unknown"
    const detail = publishStateDetail(
      { ...baseLifecycle, stage },
      {
        ready_to_publish: false, can_start_publish_attempt: false,
        blockers: unknown ? ["outcome_unknown"] : [],
        allowed_actions: unknown ? ["reconcile"] : [],
      },
      "Ozon 已接收请求，但尚无确定回执，请先对账",
      unknown,
    )
    assert.equal(detail.text, text)
    assert.doesNotMatch(detail.fullText, /已接收|已受理/)
  }
})

const fieldIssues = [
  { field_key: "currency_code", code: "required" as const, message: "价格币种为必填项" },
  { field_key: "currency_code", code: "required" as const, message: "价格币种为必填项" },
  { field_key: "attribute_7109", code: "required" as const, message: "主题为必填项" },
]

test("a completed prepare does not hide the fields that failed validation", () => {
  const detail = publishStateDetail(
    { ...baseLifecycle, stage: "fields_invalid", fields: "invalid" },
    { ...exceptional(["fields_invalid"]), allowed_actions: ["edit_fields"] },
    "准备已完成",
    true,
    undefined,
    fieldIssues,
  )
  assert.equal(detail.text, "价格币种为必填项、主题为必填项")
  assert.equal(detail.fullText, detail.text)
})

test("without structured issues, prepare completion falls through to the recorded validation sentence", () => {
  const detail = publishStateDetail(
    {
      ...baseLifecycle, stage: "fields_invalid", fields: "invalid",
      failure_log: [{ stage: "validation", code: "required", message: "缺少品牌", occurred_at_ms: 1 }],
    },
    exceptional(["fields_invalid"]),
    "准备已完成",
    true,
  )
  assert.equal(detail.text, "缺少品牌")
  assert.doesNotMatch(detail.text, /准备已完成/)
})

test("field issues do not replace a publish rejection or another row's exact log", () => {
  const rejected = publishStateDetail(
    { ...baseLifecycle, stage: "publish_rejected" },
    exceptional(["publish_rejected"]),
    "当前图片对象不存在，请重新上传",
    true,
    undefined,
    fieldIssues,
  )
  assert.equal(rejected.text, "当前图片对象不存在，请重新上传")
})
