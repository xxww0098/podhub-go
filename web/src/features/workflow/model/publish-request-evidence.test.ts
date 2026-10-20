import assert from "node:assert/strict"
import test from "node:test"
import { capturePublishRequestEvidence, currentPublishRequestEvidence, requestEvidenceRemediation, type PublishRequestIdentity } from "./publish-request-evidence"
import { resolvePublishRemediation } from "./publish-remediation"
import { product } from "../cloud-fanout-tests/fixtures"

const identity: PublishRequestIdentity = { scope: 1, mediaEpoch: 0, cardId: "card", storeId: "store", rowId: "row", revision: 1, viewRevision: 1 }
const error = { code: "cloud_offer_busy", message: "old per-offer message must not grant scope", remediation: "old retry text",
  requestCause: { kind: "request_refusal", scope: "request", storeId: "store", rowIds: ["row", "different-offer"],
    status: 409, serverCode: "offer_busy", admission: "offer_busy", traceId: "safe-request-trace" } }

test("structured OfferBusy retains the attempted whole block and safe trace without per-offer claims", () => {
  const evidence = capturePublishRequestEvidence(error, identity)!
  assert.equal(evidence.contractInvalid, false)
  assert.deepEqual(evidence.requestCause?.rowIds, ["row", "different-offer"])
  const solution = requestEvidenceRemediation(evidence)
  assert.equal(solution.cause, "request_offer_busy")
  assert.match(solution.reason, /整块未入队.*不表示.*每个货号都冲突/)
  assert.match(solution.scope, /Ozon.*原店铺 store.*整块 2 件.*其它货号/)
  assert.match(solution.steps.join("；"), /确切.*Intent ID.*重新读回.*原生校验.*用户明确发送/)
  assert.equal(solution.traceId, "safe-request-trace")
  assert.equal(solution.action, undefined)
  assert.doesNotMatch(solution.reason + solution.steps.join("；"), /old per-offer|old retry/)
  error.requestCause.rowIds.push("late-mutation")
  assert.deepEqual(evidence.requestCause?.rowIds, ["row", "different-offer"])
  error.requestCause.rowIds.pop()
})

test("validated ListingIssue trace wins request trace without upgrading absent freshness into authority", () => {
  const issue = { code: "OZON_ROW_REJECTED", phase: "submit", scope: "row", summary: "Cloud original summary",
    remediation: "Cloud original steps", allowedActions: ["edit_row"], traceId: "listing-issue-trace", intentId: "exact",
    rowId: "row", storeId: "store", dispatchEvidence: "rejected" }
  const evidence = capturePublishRequestEvidence({ ...error, listingIssue: issue }, identity)!
  assert.equal(evidence.contractInvalid, false)
  const view = requestEvidenceRemediation(evidence)
  assert.equal(view.traceId, "listing-issue-trace")
  assert.equal(view.cause, "request_offer_busy")
  assert.equal(view.action, undefined)
  assert.equal(Object.hasOwn(evidence.listingIssue!, "inputRevision"), false)
})

for (const key of ["scope", "mediaEpoch", "cardId", "storeId", "rowId", "revision", "viewRevision"] as const) {
  test(`request evidence cannot cross its ${key} identity fence`, () => {
    const evidence = capturePublishRequestEvidence(error, identity)!
    const changed = { ...identity, [key]: typeof identity[key] === "number" ? Number(identity[key]) + 1 : "foreign" }
    assert.equal(currentPublishRequestEvidence(evidence, changed), undefined)
    assert.equal(currentPublishRequestEvidence(evidence, undefined), undefined)
    assert.equal(currentPublishRequestEvidence(evidence, identity), evidence)
  })
}

for (const cause of [
  { ...error.requestCause, storeId: "foreign" }, { ...error.requestCause, rowIds: ["different-offer"] },
  { ...error.requestCause, rowIds: ["row", "row"] }, { ...error.requestCause, rowIds: Array.from({ length: 101 }, (_, i) => `row-${i}`) },
  { ...error.requestCause, admission: "offer_busy", serverCode: "unknown_code" },
  { ...error.requestCause, traceId: "<raw exception>" }, Object.create(error.requestCause),
  { ...error.requestCause, traceId: "trace:outside-privacy-grammar" },
]) {
  test(`malformed or foreign request evidence stays manual (${JSON.stringify(cause)})`, () => {
    const evidence = capturePublishRequestEvidence({ ...error, requestCause: cause }, identity)!
    assert.equal(evidence.contractInvalid, true)
    assert.equal(evidence.requestCause, undefined)
    const solution = requestEvidenceRemediation(evidence)
    assert.equal(solution.cause, "contract_invalid")
    assert.equal(solution.reportable, true)
    assert.equal(solution.action, undefined)
    assert.doesNotMatch(solution.reason, /raw exception|unknown_code/)
  })
}

test("freshness-less ListingIssue remains diagnostic and cannot fabricate a current issue or brand repair", () => {
  const issue = { code: "OZON_ROW_REJECTED", phase: "submit", scope: "row", summary: "Cloud original summary",
    remediation: "Cloud original steps", allowedActions: ["edit_row"], traceId: "issue-trace", intentId: "exact",
    rowId: "row", storeId: "store", dispatchEvidence: "rejected", inputRevision: 1, resolvedAtMs: null }
  const evidence = capturePublishRequestEvidence({ code: issue.code, message: issue.summary, remediation: issue.remediation, listingIssue: issue }, identity)!
  assert.equal(evidence.contractInvalid, false)
  assert.equal(evidence.listingIssue?.summary, issue.summary)
  assert.equal(evidence.listingIssue?.remediation, issue.remediation)
  assert.deepEqual(evidence.listingIssue?.allowedActions, ["edit_row"])
  assert.equal(Object.hasOwn(evidence.listingIssue!, "inputRevision"), false)
  assert.equal(Object.hasOwn(evidence.listingIssue!, "resolvedAtMs"), false)
  const solution = resolvePublishRemediation({ lifecycle: product("row").lifecycle, rowLog: "",
    requestEvidence: evidence, requestIdentity: identity, brandRepairable: true })!
  assert.equal(solution.cause, "contract_invalid")
  assert.equal(solution.traceId, "issue-trace")
  assert.equal(solution.action, undefined)
})

test("400 system media refusal preserves its named group and remove-save steps", () => {
  const evidence = capturePublishRequestEvidence({ code: "cloud_validation", message: "系统媒体组 product_video 不能加入默认字段",
    remediation: "从默认字段移除 product_video 组并重新保存，再明确发送",
    requestCause: { kind: "request_refusal", scope: "request", storeId: "store", rowIds: ["row"], status: 400, serverCode: "validation", traceId: "400-trace" } }, identity)!
  const solution = requestEvidenceRemediation(evidence)
  assert.equal(solution.reason, "系统媒体组 product_video 不能加入默认字段")
  assert.match(solution.steps.join("；"), /移除 product_video 组.*重新保存/)
  assert.equal(solution.reportable, false)
  assert.equal(solution.action, undefined)
})

test("unconfirmed request evidence cannot inherit an editable 400 refusal reason or assert non-dispatch", () => {
  const evidence = capturePublishRequestEvidence({ code: "cloud_validation", message: "old editable field refusal",
    remediation: "old remove-and-send step", requestCause: { kind: "result_unconfirmed", scope: "request", storeId: "store",
      rowIds: ["row"], status: 400, serverCode: "validation", traceId: "unknown-trace" } }, identity)!
  const solution = requestEvidenceRemediation(evidence)
  assert.equal(solution.cause, "outcome_unknown")
  assert.equal(solution.reportable, true)
  assert.equal(solution.action, undefined)
  assert.match(solution.scope, /结果未确认.*不能据此断言已拒绝或未发送/)
  assert.doesNotMatch(solution.reason + solution.steps.join("；"), /old editable|old remove-and-send/)
})

test("authoritative Unknown and accepted stages dominate request refusal and stale logs", () => {
  const evidence = capturePublishRequestEvidence(error, identity)!
  const facts = { lifecycle: product("row").lifecycle, rowLog: "", requestEvidence: evidence, requestIdentity: identity, brandRepairable: true }
  const unknown = resolvePublishRemediation({ ...facts, lifecycle: { ...facts.lifecycle, stage: "outcome_unknown" } })!
  assert.equal(unknown.cause, "outcome_unknown")
  assert.equal(unknown.action, undefined)
  assert.equal(unknown.traceId, "safe-request-trace")
  assert.match(unknown.steps.join("；"), /不要重新发送/)
  assert.equal(resolvePublishRemediation({ ...facts, lifecycle: { ...facts.lifecycle, stage: "accepted" } }), undefined)
  assert.equal(resolvePublishRemediation({ ...facts, requestIdentity: { ...identity, viewRevision: 2 },
    rowLog: requestEvidenceRemediation(evidence).reason }), undefined)
})
