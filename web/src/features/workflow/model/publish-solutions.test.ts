import assert from "node:assert/strict"
import test from "node:test"
import type { components } from "@/api/schema"
import { allowedPublishActions } from "./publish-actions"
import { resolvePublishRemediation } from "./publish-remediation"
import { issueSolution, nativeSolutions, publishSolutions, resolvePublishSolution, solutionScope } from "./publish-solutions"
import { contractSolution, offerBusySolution } from "./publish-solutions-controls"
import { nativeSolution } from "./publish-solutions-native"
import { intentSolutions } from "./publish-solutions-intent"

const issue: components["schemas"]["ListingIssue"] = {
  allowed_actions: ["edit_row"], code: "OZON_ROW_REJECTED", created_at_ms: 1,
  credential_revision: 1, dispatch_evidence: "rejected", endpoint: "import", input_revision: 3,
  intent_id: "intent", phase: "submit", remediation: "服务端指定的修改步骤", request_hash: "digest",
  retry_after_fallback: false, row_id: "row", safe_message: "", scope: "store", store_id: "store",
  summary: "服务端指定的字段原因", trace_id: "trace-original",
}
const lifecycle = {
  revision: 3, view_revision: 3, stage: "publish_rejected" as const, ai: "ready" as const,
  media: "ready" as const, fields: "valid" as const, image_total: 1, image_completed: 1,
  images: [], failure_log: [], ai_candidates: [], product_videos: [], submission_issue: issue,
}

test("every native tuple and every separate closed family has cause, scope and manual steps", () => {
  let count = 0
  for (const [platform, stages] of Object.entries(nativeSolutions)) {
    for (const [stage, codes] of Object.entries(stages)) {
      for (const [code, expected] of Object.entries(codes)) {
        const solution = resolvePublishSolution({ platform, stage, code })
        assert.equal(solution, expected)
        assert.ok(solution.reason && solutionScope(solution.scope) && solution.steps.length)
        assert.ok(solution.steps.every((step) => step.length > 0))
        if (stage === "validate") assert.equal(solution.reportable, false)
        const view = resolvePublishRemediation({ platform, stage, code, field: "attribute_123", traceId: "same-trace" })!
        assert.equal(view.reason, solution.reason)
        assert.match(view.scope, /字段 attribute_123/)
        assert.equal(view.traceId, "same-trace")
        count += 1
      }
    }
  }
  // The ratchet: every declared (platform, stage, code) needs its own copy.
  // 19 validate + 6 freeze + 7 pre_dispatch + 6 submit + 9 preview (Ozon),
  // 4 metadata + 12 validate + 2 preview (WB).
  assert.equal(count, 65)
  for (const table of Object.values(publishSolutions)) for (const solution of Object.values(table)) {
    assert.ok(solution.reason && solution.steps.length && solutionScope(solution.scope))
  }
})

test("the global write pause is not presented as affecting only the recorded row", () => {
  const paused: components["schemas"]["ListingIssue"] = {
    ...issue, phase: "pre_dispatch", code: "OZON_WRITES_DISABLED", scope: "row",
    dispatch_evidence: "not_dispatched", allowed_actions: ["resume"],
    summary: "Ozon 写入已被暂停", remediation: "等待维护解除后重新发送",
  }
  const result = resolvePublishRemediation({ lifecycle: { ...lifecycle, submission_issue: paused }, rowLog: "" })!
  assert.equal(result.reason, paused.summary)
  assert.equal(result.scope, "所有用户向 Ozon 发送商品均受影响")
  assert.equal(result.action, undefined)
  const native = resolvePublishSolution({ platform: "ozon", stage: "pre_dispatch", code: paused.code })
  assert.match(native.reason, /PodHub.*本次尚未发送/)
  assert.match(native.steps.join(""), /管理员.*刷新页面.*点击「发送」.*不会自动重发/)
})

test("the canonical Intent lookup reuses one closed table and rejects inherited codes", () => {
  assert.equal(publishSolutions.intent, intentSolutions)
  assert.equal(Object.keys(intentSolutions).length, 21)
  for (const [code, solution] of Object.entries(intentSolutions)) {
    for (const stage of ["pre_dispatch", "submit"]) {
      assert.equal(resolvePublishSolution({ platform: "ozon", stage, family: "intent", code }), solution)
    }
  }
  for (const code of ["__proto__", "constructor", "toString"]) {
    assert.equal(resolvePublishSolution({ platform: "ozon", stage: "submit", family: "intent", code }), contractSolution)
  }
})

test("unknown platform, stage, code and inherited keys have one actionless contract exit", () => {
  for (const input of [
    { platform: "other", stage: "validate", code: "required" },
    { platform: "ozon", stage: "other", code: "required" },
    { platform: "ozon", stage: "validate", code: "future_rule" },
    { platform: "ozon", stage: "validate", code: "toString" },
    ...["__proto__", "constructor", "toString"].flatMap((key) => [
      { platform: key, stage: "validate", code: "required" },
      { platform: "ozon", stage: key, code: "required" },
      { platform: "ozon", stage: "validate", code: key },
    ]),
    { platform: "ozon", stage: "validate", code: "unknown_characteristic" },
    { platform: "wb", stage: "validate", code: "invalid_price" },
    { platform: "ozon", stage: "freeze", code: "required" },
  ]) {
    assert.equal(nativeSolution(input.platform, input.stage, input.code), undefined)
    assert.equal(resolvePublishSolution(input), contractSolution)
    assert.deepEqual(resolvePublishSolution(input).actions, [])
    assert.equal(resolvePublishSolution(input).reportable, true)
  }
})

test("structured Cloud issue owns its copy, scope and trace ahead of stale local logs", () => {
  const result = resolvePublishRemediation({ lifecycle, rowLog: "发送未执行：旧 PSD 日志" })!
  assert.equal(result.reason, issue.summary)
  assert.equal(result.steps[0], issue.remediation)
  assert.match(result.scope, /当前店铺/)
  assert.equal(result.traceId, issue.trace_id)
  assert.equal(result.action, undefined)
  for (const stage of ["queued", "submitting", "accepted"] as const) {
    assert.equal(resolvePublishRemediation({ lifecycle: { ...lifecycle, stage }, rowLog: "发送未执行：旧日志" }), undefined)
  }
  const unknown = resolvePublishRemediation({ lifecycle: { ...lifecycle, stage: "outcome_unknown" }, rowLog: "" })!
  assert.equal(unknown.cause, "outcome_unknown")
  assert.equal(unknown.action, undefined)
})

test("unknown structured issues do not render raw codes or grant Cloud supplied actions", () => {
  const result = resolvePublishRemediation({ lifecycle: { ...lifecycle,
    submission_issue: { ...issue, code: "credential=secret", summary: "不应显示的未分类原文" } }, rowLog: "" })!
  assert.equal(result.cause, "contract_invalid")
  assert.equal(result.reason, contractSolution.reason)
  assert.equal(result.traceId, issue.trace_id)
  assert.equal(result.action, undefined)
})

test("actions intersect solution, Cloud allowance, identity, permission and installed callback", () => {
  const solution = issueSolution(issue)
  const available = { current: true, permitted: true, callbacks: ["edit_row" as const] }
  assert.deepEqual(allowedPublishActions(solution, issue, available), ["edit_row"])
  for (const guard of [{ ...available, current: false }, { ...available, permitted: false }, { ...available, callbacks: [] }]) {
    assert.deepEqual(allowedPublishActions(solution, issue, guard), [])
  }
  assert.deepEqual(allowedPublishActions(solution, { ...issue, allowed_actions: [] }, available), [])
  assert.deepEqual(issueSolution({ ...issue, allowed_actions: [] }).steps, [issue.remediation],
    "the frontend does not invent an edit or resend step Cloud has not permitted")
  assert.deepEqual(allowedPublishActions(solution, { ...issue, dispatch_evidence: "unknown" }, available), [])
})

test("request offer_busy names the block and never invents a conflicting Intent", () => {
  assert.equal(offerBusySolution.scope, "block")
  assert.match(offerBusySolution.reason, /不表示块内每个货号都冲突/)
  assert.match(offerBusySolution.steps.join(""), /确切.*读回.*原生校验.*用户明确发送/)
  assert.deepEqual(offerBusySolution.actions, [])
  assert.equal(publishSolutions.draft_skip.offer_busy.scope, "row")
  assert.match(offerBusySolution.reason, /发送中.*结果未确认.*已受理/)
  assert.doesNotMatch(offerBusySolution.steps.join(""), /释放/)
})

test("local credential and media errors describe their actual pre-dispatch causes", () => {
  for (const [code, reason] of [
    ["STORE_CREDENTIAL_MISSING", /尚未配置/], ["STORE_CREDENTIAL_EXPIRED", /已过期/],
    ["STORE_CREDENTIAL_ERROR", /无法读取/], ["MEDIA_LEASE_UNAVAILABLE", /保留凭证/],
    ["MEDIA_OBJECT_MISSING", /图片文件已不可用/], ["OZON_SUBMIT_IN_FLIGHT", /已派发.*尚未取得/],
  ] as const) {
    const solution = resolvePublishSolution({ platform: "ozon", stage: "submit", family: "intent", code })
    assert.match(solution.reason, reason)
    assert.doesNotMatch(solution.reason, /平台拒绝了店铺凭据|媒体证据已过期/)
  }
})

test("WB not_enabled preserves the native preview with a manual path and no retry", () => {
  const result = resolvePublishSolution({ platform: "wb", stage: "submit", family: "control", code: "not_enabled" })
  assert.match(result.reason, /WB.*尚未启用/)
  assert.match(result.steps.join(""), /保留 WB 原生预览.*卖家后台.*不会转发/)
  assert.deepEqual(result.actions, [])
  assert.equal(result.reportable, false)
})


test("stale or resolved issue prose cannot replace the current field failure", () => {
  for (const oldIssue of [{ ...issue, input_revision: 2 }, { ...issue, resolved_at_ms: 9 }]) {
    const result = resolvePublishRemediation({ lifecycle: { ...lifecycle, stage: "fields_invalid", fields: "invalid",
      submission_issue: oldIssue,
      failure_log: [{ stage: "validation", code: "required", message: "当前行缺少品牌", occurred_at_ms: 10 }] },
      rowLog: "" })!
    assert.match(result.reason, /当前行缺少品牌/)
    assert.doesNotMatch(result.reason, /服务端指定/)
  }
})
