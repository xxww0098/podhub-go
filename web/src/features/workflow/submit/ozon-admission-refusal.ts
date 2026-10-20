/** Safe handoff to row presentation; structurally extends the legacy CommandError triple. */
import type { CloudRefusal } from "@/api/client"
import type { components } from "@/api/schema"
import { draftAdmissionRefusal } from "@/bindings/http-listing-submit"
import { isRecord } from "@/bindings/http-listing-intents"
import { offerBusySolution } from "../model/publish-solutions-controls"

type ListingIssue = components["schemas"]["ListingIssue"]
/** Local evidence projection: wire snake_case fields keep their SPA camelCase names. */
export type OzonListingIssueEvidence = Pick<ListingIssue, "code" | "phase" | "scope" | "summary" | "remediation"> & {
  allowedActions: ListingIssue["allowed_actions"]
  traceId: ListingIssue["trace_id"]
  intentId: ListingIssue["intent_id"]
  rowId: ListingIssue["row_id"]
  storeId: ListingIssue["store_id"]
  dispatchEvidence: ListingIssue["dispatch_evidence"]
}
export type OzonSubmissionError = {
  code: string
  serverCode?: string
  traceId?: string
  message: string
  remediation: string | null
  requestCause?: {
    kind: "request_refusal" | "result_unconfirmed"
    scope: "request"
    storeId: string
    rowIds: readonly string[]
    status?: number
    serverCode?: string
    traceId?: string
    admission?: ReturnType<typeof draftAdmissionRefusal>
  }
  listingIssue?: OzonListingIssueEvidence
}

/** Only actual Intent.currentIssue evidence enters here, never request message text. */
export function projectOzonListingIssue(value: unknown): OzonListingIssueEvidence | undefined {
  if (!isRecord(value) || !["code", "phase", "summary", "remediation", "trace_id", "intent_id", "row_id", "store_id"].every((key) => typeof value[key] === "string")
    || (value.scope !== "row" && value.scope !== "store")
    || !["not_dispatched", "rejected", "unknown"].includes(String(value.dispatch_evidence))
    || !Array.isArray(value.allowed_actions) || !value.allowed_actions.every((action) => ["edit_row", "check_store", "resume", "wait", "reconcile", "recover"].includes(String(action)))) return undefined
  const issue = value as ListingIssue
  return { code: issue.code, phase: issue.phase, scope: issue.scope, summary: issue.summary, remediation: issue.remediation,
    allowedActions: [...issue.allowed_actions], traceId: issue.trace_id, intentId: issue.intent_id, rowId: issue.row_id, storeId: issue.store_id, dispatchEvidence: issue.dispatch_evidence }
}

export function ozonAdmissionFailure(reason: unknown, storeId: string, rowIds: readonly string[]): OzonSubmissionError {
  const refusal = reason instanceof Error ? reason as Partial<CloudRefusal> : undefined
  const status = typeof refusal?.status === "number" && Number.isInteger(refusal.status) ? refusal.status : undefined
  const serverCode = typeof refusal?.serverCode === "string" ? refusal.serverCode : undefined
  const traceId = typeof refusal?.traceId === "string" ? refusal.traceId : undefined
  const admission = draftAdmissionRefusal(reason)
  const unconfirmed = status === undefined || status >= 500 || (status === 409 && !admission && serverCode !== "schema_sync_required")
    || refusal?.code === "cloud_bad_response" || refusal?.code === "cloud_unavailable"
  const code = status === 429 ? "cloud_rate_limited" : typeof refusal?.code === "string" ? refusal.code : "cloud_request_failed"
  return {
    code,
    serverCode,
    traceId,
    message: admission === "offer_busy"
      ? offerBusySolution.reason
      : unconfirmed ? "本次提交结果未确认，请核对原店铺的发送记录" : "云端拒绝了本次请求，本块未获受理；请核对请求范围和提交条件",
    remediation: admission === "offer_busy" ? offerBusySolution.steps.join("；")
      : unconfirmed ? "核对该店铺原 Intent 和平台记录；结果未确认时不要重复发送。"
        : "检查所选店铺和商品的提交条件并重新校验；仍被拒绝时携带请求标识联系管理员。",
    requestCause: { kind: unconfirmed ? "result_unconfirmed" : "request_refusal", scope: "request", storeId, rowIds: [...rowIds], status, serverCode, traceId, admission },
  }
}
