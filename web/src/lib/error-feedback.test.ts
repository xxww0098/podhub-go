import assert from "node:assert/strict"
import test from "node:test"
import { createErrorFeedback } from "./error-feedback"

test("feedback separates recovery from the reason and uses canonical Base32 receipts", () => {
  const reason = { code: "cloud_request_failed", status: 502, traceId: "request-1",
    message: "云端未确认本次操作结果（HTTP 502）", remediation: "请刷新核对云端记录；不要重复提交已发起的操作。" }
  const feedback = createErrorFeedback(reason, "准备失败")
  assert.match(feedback.errorId, /^[0-9A-F][0-9A-HJKMNP-TV-Z]{12}$/)
  assert.equal(feedback.summary, "云端结果待确认")
  assert.equal(feedback.action, "刷新核对结果，请勿重复提交。")
  assert.equal(feedback.status, 502)
  assert.equal(feedback.traceId, "request-1")
  assert.notEqual(createErrorFeedback(reason, "准备失败").errorId, feedback.errorId)
  const refusal = createErrorFeedback({ code: "validation", message: "名称未填写", remediation: "请补全名称" }, "校验失败")
  assert.equal(refusal.summary, "名称未填写")
  assert.equal(refusal.action, "请补全名称")
})

test("untrusted getters and raw exception text never become user feedback", () => {
  const reason = Object.defineProperty({}, "message", { get() { throw new Error("must not execute") } })
  assert.equal(createErrorFeedback(reason, "上传失败").summary, "上传失败")
  const feedback = createErrorFeedback({ message: "请求失败 token=secret", code: "https://secret", traceId: "Bearer secret", remediation: "https://secret" }, "上传失败")
  assert.equal(feedback.summary, "上传失败")
  assert.equal(feedback.code, "operation_failed")
  assert.equal(feedback.action, undefined)
  assert.equal(feedback.traceId, undefined)
})

test("a missing model has the same actionable guidance for direct and combined preparation", () => {
  for (const reason of [
    { code: "validation", blockers: ["missing_model"], message: "请先配置识别模型" },
    { blockers: ["missing_model"], message: "请先配置识别模型" },
  ]) {
    const feedback = createErrorFeedback(reason, "准备失败")
    assert.match(feedback.action ?? "", /系统默认识图模型.*管理员.*重试识别.*一键准备.*已完成图片保留/)
    assert.doesNotMatch(feedback.action ?? "", /选择|可用项/)
  }
})

test("a missing slice R2 account points to settings unless the reason brings its own remediation", () => {
  const blocked = createErrorFeedback({ message: "上传被阻止", blockers: ["missing_media_account"] }, "x")
  assert.equal(blocked.code, "missing_media_account")
  assert.match(blocked.action ?? "", /工作空间所有者.*设置 → 存储桶/)
  assert.equal(createErrorFeedback({ message: "上传被阻止", blockers: ["missing_media_account"], remediation: "联系管理员" }, "x").action, "联系管理员")
  assert.equal(createErrorFeedback({ message: "别的失败", code: "prepare_failed" }, "x").action, undefined)
})
