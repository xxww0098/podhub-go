import assert from "node:assert/strict"
import test from "node:test"
import { createErrorFeedback } from "./error-feedback"

test("feedback separates recovery from the reason and uses exact decimal receipts", () => {
  const reason = { code: "cloud_request_failed", status: 502, traceId: "request-1",
    message: "云端未确认本次操作结果（HTTP 502）", remediation: "请刷新核对云端记录；不要重复提交已发起的操作。" }
  const feedback = createErrorFeedback(reason, "准备失败")
  assert.match(feedback.errorId, /^\d{20}$/)
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
