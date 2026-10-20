import { isRecord } from "@/bindings/http-listing-intents"
import type { OzonListingIssueEvidence, OzonSubmissionError } from "../submit/ozon-admission-refusal"
import type { PublishRemediation } from "./publish-problem"
import { resolvePublishSolution, solutionScope } from "./publish-solutions"
import { contractSolution, offerBusySolution, unknownSolution } from "./publish-solutions-controls"

/** Local diagnostic identity. It grants neither an Intent identity nor actions. */
export type PublishRequestIdentity = {
  scope: number
  mediaEpoch: number
  cardId: string
  storeId: string
  rowId: string
  revision: number
  viewRevision: number
}
type RequestCause = NonNullable<OzonSubmissionError["requestCause"]>
export type PublishRequestEvidence = {
  identity: PublishRequestIdentity
  code: string
  message: string
  remediation: string | null
  requestCause?: RequestCause
  listingIssue?: OzonListingIssueEvidence
  contractInvalid: boolean
}

const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096
const id = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value)
const trace = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(value)
function admission(value: unknown): value is NonNullable<RequestCause["admission"]> {
  return value === "store_busy" || value === "store_unavailable" || value === "submit_capacity_full" || value === "offer_busy"
}
function safeIssue(value: unknown): value is OzonListingIssueEvidence {
  return isRecord(value) && ["code", "phase", "scope", "summary", "remediation", "allowedActions", "traceId", "intentId", "rowId", "storeId", "dispatchEvidence"]
    .every((key) => Object.hasOwn(value, key)) && ["code", "phase", "summary", "remediation"].every((key) => text(value[key]))
    && trace(value.traceId) && ["intentId", "rowId", "storeId"].every((key) => id(value[key]))
    && (value.scope === "row" || value.scope === "store")
    && (value.dispatchEvidence === "not_dispatched" || value.dispatchEvidence === "rejected" || value.dispatchEvidence === "unknown")
    && Array.isArray(value.allowedActions) && value.allowedActions.every((action) =>
      action === "edit_row" || action === "check_store" || action === "resume" || action === "wait" || action === "reconcile" || action === "recover")
}

/** Validate the transport's local extension without changing CommandError's wire triple. */
export function capturePublishRequestEvidence(error: unknown, identity: PublishRequestIdentity): PublishRequestEvidence | undefined {
  if (!isRecord(error) || (!Object.hasOwn(error, "requestCause") && !Object.hasOwn(error, "listingIssue"))) return undefined
  const evidence: PublishRequestEvidence = { identity: { ...identity }, code: text(error.code) ? error.code : "contract_invalid",
    message: text(error.message) ? error.message : "", remediation: text(error.remediation) ? error.remediation : null,
    contractInvalid: !["code", "message", "remediation"].every((key) => Object.hasOwn(error, key))
      || !text(error.code) || !text(error.message) || (error.remediation !== null && !text(error.remediation)) }
  const cause = error.requestCause
  if (Object.hasOwn(error, "requestCause")) {
    if (!isRecord(cause) || !Object.hasOwn(cause, "kind") || !Object.hasOwn(cause, "scope")
      || !Object.hasOwn(cause, "storeId") || !Object.hasOwn(cause, "rowIds")
      || !["status", "serverCode", "traceId", "admission"].every((key) => cause[key] === undefined || Object.hasOwn(cause, key))
      || (cause.kind !== "request_refusal" && cause.kind !== "result_unconfirmed") || cause.scope !== "request"
      || cause.storeId !== identity.storeId || !id(cause.storeId) || !Array.isArray(cause.rowIds)
      || !cause.rowIds.length || cause.rowIds.length > 100 || !cause.rowIds.every(id)
      || new Set(cause.rowIds).size !== cause.rowIds.length || !cause.rowIds.includes(identity.rowId)
      || (cause.status !== undefined && (typeof cause.status !== "number" || !Number.isInteger(cause.status) || cause.status < 100 || cause.status > 599))
      || (cause.serverCode !== undefined && !id(cause.serverCode)) || (cause.traceId !== undefined && !trace(cause.traceId))
      || (cause.admission !== undefined && (!admission(cause.admission) || cause.status !== 409 || cause.serverCode !== cause.admission))) {
      evidence.contractInvalid = true
    } else {
      evidence.requestCause = { kind: cause.kind, scope: "request", storeId: cause.storeId, rowIds: [...cause.rowIds],
        ...(typeof cause.status === "number" ? { status: cause.status } : {}),
        ...(id(cause.serverCode) ? { serverCode: cause.serverCode } : {}),
        ...(trace(cause.traceId) ? { traceId: cause.traceId } : {}),
        ...(admission(cause.admission) ? { admission: cause.admission } : {}) }
    }
  }
  if (Object.hasOwn(error, "listingIssue")) {
    if (!safeIssue(error.listingIssue) || error.listingIssue.rowId !== identity.rowId || error.listingIssue.storeId !== identity.storeId) {
      evidence.contractInvalid = true
    } else {
      const issue = error.listingIssue
      // Freshness fields are deliberately absent. Never turn this diagnostic
      // projection into lifecycle.submission_issue or a repair permission.
      evidence.listingIssue = { code: issue.code, phase: issue.phase, scope: issue.scope, summary: issue.summary,
        remediation: issue.remediation, allowedActions: [...issue.allowedActions], traceId: issue.traceId,
        intentId: issue.intentId, rowId: issue.rowId, storeId: issue.storeId, dispatchEvidence: issue.dispatchEvidence }
    }
  }
  return evidence
}

export function currentPublishRequestEvidence(evidence: PublishRequestEvidence | undefined, identity: PublishRequestIdentity | undefined): PublishRequestEvidence | undefined {
  if (!evidence || !identity) return undefined
  const before = evidence.identity
  return before.scope === identity.scope && before.mediaEpoch === identity.mediaEpoch && before.cardId === identity.cardId
    && before.storeId === identity.storeId && before.rowId === identity.rowId && before.revision === identity.revision
    && before.viewRevision === identity.viewRevision ? evidence : undefined
}

/** Persistent, manual-only projection over the existing unique solution table. */
export function requestEvidenceRemediation(evidence: PublishRequestEvidence): PublishRemediation {
  const cause = evidence.requestCause
  const unknown = cause?.kind === "result_unconfirmed"
  const busy = !evidence.contractInvalid && cause?.kind === "request_refusal" && cause.admission === "offer_busy"
  const solution = evidence.contractInvalid ? contractSolution : unknown ? unknownSolution : busy ? offerBusySolution
    : cause ? resolvePublishSolution({ platform: "ozon", stage: "pre_dispatch", family: "request", code: cause.serverCode ?? evidence.code.replace(/^cloud_/, "") })
    : contractSolution
  const validation = !evidence.contractInvalid && cause?.kind === "request_refusal" && cause.status === 400 && cause.serverCode === "validation"
  const issue = evidence.listingIssue
  return { cause: solution === contractSolution ? "contract_invalid" : unknown ? "outcome_unknown" : busy ? "request_offer_busy" : "request_refused",
    reason: validation && evidence.message ? evidence.message : solution.reason,
    scope: `Ozon · ${unknown ? "发送结果" : "派发前检查"}；原店铺 ${evidence.identity.storeId}；${cause
      ? `本次尝试的整块 ${cause.rowIds.length} 件商品；${unknown ? "这些已发出请求的商品结果未确认；不能据此断言已拒绝或未发送" : solutionScope("block")}`
      : "仅此商品行的诊断记录"}`,
    steps: validation && evidence.remediation ? [evidence.remediation, ...solution.steps] : [...solution.steps],
    traceId: issue?.traceId ?? cause?.traceId, reportable: solution.reportable, diagnosticCode: solution.diagnosticCode }
}
