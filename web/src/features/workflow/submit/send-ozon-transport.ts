/**
 * The authorized Ozon send channel: the existing persistent-intent
 * `POST /api/listing/submit` (one Store per call). Only row ids and the
 * click's revision pins travel; Cloud re-authenticates, checks the pins,
 * freezes the canonical Seller body optimistically and checks its revision
 * with CAS before committing the intent and job. The locally frozen body stays a local preview;
 * request failures leave reporting to the caller's normalization boundary.
 *
 * Every Cloud answer is kept as the row result the workbench already renders
 * (receipt, product projection, skip reason); the platform outcome is derived
 * from it. Only a response with a status proves Cloud judged the request: no
 * status, or a 5xx, means the attempt may have landed and is `unknown`.
 */
import { request } from "@/api/client"
import type { RequestEvidence } from "@/api/client-options"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"
import type { WorkflowOperationOutcome, WorkflowOperationRowResult } from "@/bindings/commands"
import type { ListingRowView } from "@/bindings/listing-projection"
import { rememberListingRows, rowCacheScope } from "@/bindings/listing-row-cache"
import { TRACE_ID_PATTERN } from "@/lib/utils"
import type { FrozenItem } from "../platforms/core"
import type { OzonBody } from "../platforms/ozon"
import { rowStatusView } from "../model/row-state"
import { ozonAdmissionFailure, projectOzonListingIssue, type OzonSubmissionError } from "./ozon-admission-refusal"
import { cancelledResult, revisionMismatch } from "./send-local"
import { createPublishDiagnosticOperation } from "./queue/diagnostics"
import type { PublishDiagnosticDispatch, PublishDiagnosticReference } from "../model/publish-diagnostic"

type SubmitData = components["schemas"]["SubmitListingBatchData"]
type SubmitItem = SubmitData["items"][number]
export type OzonRowResult = Omit<WorkflowOperationRowResult, "error"> & { error?: OzonSubmissionError; publishDiagnostic?: PublishDiagnosticReference }

/** Path, status and x-request-id of the batch submit that produced a row result. */
export type SendHttpExchange = { apiPath: string; apiStatus?: number; requestId?: string }
const sendExchanges = new WeakMap<object, SendHttpExchange>()
export function readSendHttpExchange(result: object): SendHttpExchange | undefined {
  return sendExchanges.get(result)
}
function rememberSendExchange(result: object, exchange: SendHttpExchange) {
  sendExchanges.set(result, exchange)
}

const REFUSED = ["blocked", "revision_mismatch", "compose_failed", "store_mismatch", "store_unbound", "not_found"]

/** A Cloud x-request-id candidate this rail may surface to the operator. */
function safeTraceId(value: unknown): string | undefined {
  return typeof value === "string" && TRACE_ID_PATTERN.test(value) ? value : undefined
}

export type OzonSendContext = {
  storeId: string
  pins: ReadonlyMap<string, { revision: number }>
  shouldStop: (rowId: string) => boolean
  /** Exact request-local evidence; the observer owns its lifetime and reporting. */
  onRequestEvidence?: (evidence: RequestEvidence) => void
  onDispatch?: () => void
  diagnostics?: PublishDiagnosticDispatch
  /** Cloud's own answer per row, as the workbench renders it. */
  results: Map<string, OzonRowResult>
  /** Set when Cloud proved nothing was written because its schema cache is cold. */
  syncRequired: boolean
  /** The one safe replay was already spent: a second sync refusal is final. */
  replayed: boolean
}

export function cloudRowResult(item: SubmitItem): OzonRowResult {
  const intent = item.intent
  const receipt = intent?.submission_receipt ?? undefined
  const listingIssue = projectOzonListingIssue(intent?.current_issue)
  const error: OzonSubmissionError | undefined = item.skipped === "revision_mismatch"
    ? revisionMismatch(item.row_id).error : listingIssue
    ? { code: listingIssue.code, message: listingIssue.summary, remediation: listingIssue.remediation, listingIssue }
    : item.detail ? { code: "workflow_compose_failed", message: "该商品在云端拼接时被拒绝，请重新校验商品字段", remediation: "查看字段校验结果并修正；仍失败请联系管理员核对该商品。" } : undefined
  return {
    row_id: item.row_id,
    outcome: item.created ? "start" : REFUSED.includes(item.skipped ?? "") ? "blocked" : "noop",
    blockers: (item.blockers ?? []).map((blocker) => typeof blocker === "string" ? blocker : JSON.stringify(blocker)),
    noop_reason: item.skipped ?? undefined,
    job_id: intent?.id,
    ...(receipt ? { submissionReceipt: receipt } : {}),
    ...(typeof intent?.external_task_id === "string" ? { taskId: intent.external_task_id } : {}),
    ...(item.row ? { product: rowStatusView(item.row as ListingRowView) } : {}),
    error,
  }
}

export async function submitOzonChunk(context: OzonSendContext, items: readonly FrozenItem<OzonBody>[]): Promise<void> {
  const settle = (rowId: string, result: WorkflowOperationRowResult) => { context.results.set(rowId, result) }
  const expectedRevisions: { row_id: string; revision: number }[] = []
  const sending = items.filter((item) => {
    if (context.shouldStop(item.key)) {
      settle(item.key, cancelledResult(item.key))
      return false
    }
    const pin = context.pins.get(item.key)
    if (!pin || !Number.isSafeInteger(pin.revision) || pin.revision < 0) {
      settle(item.key, revisionMismatch(item.key))
      return false
    }
    expectedRevisions.push({ row_id: item.key, revision: pin.revision })
    return true
  })
  if (sending.length === 0) return
  const rowIds = sending.map((item) => item.key)
  const scope = rowCacheScope()
  const operation = createPublishDiagnosticOperation(context.diagnostics)
  const apiPath = route("listingSubmit")
  let requestId: string | undefined
  const stamp = (result: object, apiStatus?: number) => {
    rememberSendExchange(result, {
      apiPath,
      ...(typeof apiStatus === "number" && apiStatus >= 100 && apiStatus <= 599 ? { apiStatus } : {}),
      ...(requestId ? { requestId } : {}),
    })
  }
  try {
    // Stop closes later admission, not this request; keep its original body deadline.
    const body = {
      store_id: context.storeId,
      row_ids: rowIds,
      expected_revisions: expectedRevisions,
    } satisfies components["schemas"]["SubmitListingBatchRequest"]
    const data = await request<SubmitData>("POST", apiPath, body, {}, 150_000, undefined, { reportOwner: "caller",
      onDispatch: () => { operation.onDispatch(); context.onDispatch?.() },
      onEvidence: (value) => {
        requestId = safeTraceId(value.traceId) ?? requestId
        operation.onEvidence(value)
        context.onRequestEvidence?.(value)
      } })
    rememberListingRows(data.items.flatMap((item) => item.row ? [item.row] : []), scope)
    for (const item of data.items) {
      const result = cloudRowResult(item)
      stamp(result, 200)
      settle(item.row_id, result)
    }
    for (const rowId of rowIds) {
      if (!context.results.has(rowId)) {
        const missing = { row_id: rowId, outcome: "unknown" as const, blockers: [], noop_reason: "result_unconfirmed" }
        stamp(missing, 200)
        settle(rowId, missing)
      }
    }
  } catch (reason) {
    const code = (reason as { code?: string }).code
    if (code === "cloud_schema_sync_required" && !context.replayed) {
      context.syncRequired = true
      operation.clear()
      return
    }
    const error = ozonAdmissionFailure(reason, context.storeId, rowIds)
    const unconfirmed = error.requestCause?.kind === "result_unconfirmed"
    const status = (reason as { status?: unknown }).status
    const apiStatus = typeof status === "number" && Number.isInteger(status) ? status : undefined
    const changed = apiStatus === 409 && (reason as { serverCode?: unknown }).serverCode === "revision_mismatch"
    if (!requestId) requestId = safeTraceId(error.traceId)
    for (const rowId of rowIds) {
      if (context.results.has(rowId)) continue
      const result = changed ? revisionMismatch(rowId) : {
        row_id: rowId,
        outcome: (unconfirmed ? "unknown" : "blocked") as WorkflowOperationOutcome,
        blockers: [],
        ...(unconfirmed ? { noop_reason: "result_unconfirmed" } : {}),
        error,
      }
      stamp(result, apiStatus)
      settle(rowId, result)
    }
  }
  try {
    for (const rowId of rowIds) {
      const result = context.results.get(rowId)
      if (!result) continue
      const issue = result.error?.listingIssue
      const cause = result.error?.requestCause
      const problem = result.outcome === "unknown"
        ? { platform: "ozon", stage: "submit", family: "control" as const, code: "result_unconfirmed", traceId: issue?.traceId }
        : issue ? { platform: "ozon", stage: issue.phase, code: issue.code, traceId: issue.traceId }
        : cause ? { platform: "ozon", stage: "pre_dispatch", family: "request" as const, code: cause.serverCode ?? result.error!.code }
        : undefined
      if (!problem) continue
      const detail = await operation.capture(problem)
      if (detail?.event) result.publishDiagnostic = { eventKey: detail.diagnosticId,
        diagnosticId: detail.diagnosticId, traceId: detail.event.trace_id }
    }
  } finally { operation.clear() }
  return
}
