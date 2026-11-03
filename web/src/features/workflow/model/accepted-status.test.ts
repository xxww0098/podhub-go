import assert from "node:assert/strict"
import test from "node:test"
import { acceptedPublishCopy } from "./accepted-status"
import type { WorkflowProductLifecycle } from "@/bindings/commands"

test("an accepted row without a follow-up keeps the previous sentences", () => {
  assert.equal(acceptedPublishCopy({}).label, "已受理")
  assert.match(acceptedPublishCopy({}).detail, /后续审核与可售以卖家后台为准/)
  assert.equal(acceptedPublishCopy({ ozon_sku: 42 }).label, "商品已创建")
  assert.match(acceptedPublishCopy({ ozon_sku: 42 }).detail, /可售状态仍需核对/)
})

test("import and moderation progress replace 已受理 without opening a resend", () => {
  const pending = acceptedPublishCopy({
    importFollowup: { phase: "pending", detail: "Ozon 正在导入该商品，完成后会更新到这一行。" },
  })
  assert.equal(pending.label, "导入处理中")
  assert.equal(pending.failed, false)

  const review = acceptedPublishCopy({
    importFollowup: { phase: "moderating", detail: "商品正在审核，通过后会更新到这一行。" },
  })
  assert.equal(review.label, "审核中")
  assert.equal(acceptedPublishCopy({
    ozon_sku: 42,
    importFollowup: { phase: "moderating", detail: "商品正在审核，通过后会更新到这一行。" },
  }).label, "商品已创建")

  const declined = acceptedPublishCopy({
    ozon_sku: 42,
    importFollowup: { phase: "moderation_failed", detail: "审核未通过，请到卖家后台查看原因。" },
  })
  assert.equal(declined.label, "审核未通过")
  assert.equal(declined.failed, true)
  assert.doesNotMatch(declined.detail, /重新发送|重发/)

  const created = acceptedPublishCopy({
    importFollowup: { phase: "created", detail: "商品已创建，可售状态仍需核对。" },
  })
  assert.equal(created.label, "商品已创建")
})

test("a current unresolved async failure outranks an older SKU or progress; stale evidence does not", () => {
  const issue: NonNullable<WorkflowProductLifecycle["submission_issue"]> = {
    code: "OZON_ROW_REJECTED", phase: "submit", scope: "row", summary: "Ozon 异步导入失败，请检查商品字段。",
    remediation: "请核对卖家后台", allowed_actions: [], trace_id: "trace", endpoint: "/v1/product/import/info",
    safe_message: "", dispatch_evidence: "rejected", intent_id: "intent", input_revision: 7,
    request_hash: "digest", row_id: "row", store_id: "store", credential_revision: 1,
    retry_after_fallback: false, created_at_ms: 1,
  }
  const facts = { revision: 7, ozon_sku: 42, last_error_code: issue.code, submission_issue: issue,
    importFollowup: { phase: "pending" as const, detail: "旧的处理中记录" } }
  assert.deepEqual(acceptedPublishCopy(facts), { label: "受理后未通过", detail: issue.summary, failed: true })
  for (const patch of [
    { submission_issue: { ...issue, resolved_at_ms: 2 } },
    { submission_issue: { ...issue, input_revision: 6 } },
    { submission_issue: { ...issue, code: "OZON_PERMISSION_DENIED" } },
    { last_error_code: undefined },
  ]) assert.equal(acceptedPublishCopy({ ...facts, ...patch }).failed, false)
  for (const revision of [undefined, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(acceptedPublishCopy({ ...facts, revision,
      submission_issue: { ...issue, input_revision: revision as unknown as number } }).failed, false,
    "missing or invalid matching revisions cannot establish a current failure")
  }
})
