import type { ListingWorkbenchRuntime } from "../workbench/listing-workbench-store"
import { projectListingRowLifecycle } from "../model/listing-row-lifecycle"
import { publishSkipMessage, publishStoreAssignments } from "./publish-policy"
import type { WorkflowOperationRowResult } from "@/bindings/commands"
import { commandErrorCode, errorMessage } from "@/lib/error-message"
import { settledRowMessage } from "../batch-operation"
import { offerBusySolution, requestSolutions, unknownSolution } from "../model/publish-solutions-controls"
import { capturePublishRequestEvidence } from "../model/publish-request-evidence"
import { diagnosticReferenceFrom } from "../model/publish-diagnostic"

/** Request-level refusal is attached to every attempted row, with block scope. */
export function blockedPublishMessage(result: WorkflowOperationRowResult): string {
  if (commandErrorCode(result.error) === "cloud_offer_busy") {
    return `发送未执行：${offerBusySolution.reason}`
  }
  return `发送未执行：${settledRowMessage(result, "本行未通过发送检查；请核对字段、店铺及原 Intent 后再操作").message}`
}

/** No submit started: preserve the trusted command's field/group and removal steps. */
export function beforeDispatchFailure(reason: unknown): string {
  const solution = requestSolutions.validation
  return `发送未执行：${errorMessage(reason, `${solution.reason}；${solution.steps.join("；")}`)}`
}
export const UNCONFIRMED_PUBLISH_MESSAGE = `${unknownSolution.reason}；${unknownSolution.steps.join("；")}。`

/** Preserve newer authority and restore only the optimistic state this click wrote. */
export function projectPublishResults(
  current: ListingWorkbenchRuntime,
  beforeState: ListingWorkbenchRuntime,
  results: readonly WorkflowOperationRowResult[],
  blockedLogs: ReadonlyMap<string, string>,
  draftIds: string[],
): Partial<ListingWorkbenchRuntime> {
  if (current.scope !== beforeState.scope || current.cardId !== beforeState.cardId) return {}
  const resultMap = new Map(results.map((result) => [result.row_id, result]))
  const targets = publishStoreAssignments(beforeState)
  const productDrafts = { ...current.productBases }
  const rows = current.rows.map((row): ListingWorkbenchRuntime["rows"][number] => {
    const result = resultMap.get(row.draftId)
    const before = beforeState.productBases[row.draftId]
    const latest = current.productBases[row.draftId]
    if (!result || !before || !latest) return row
    // The hook commits this exact result's server projection before this local
    // log/evidence pass. Admit that transition, but never a different SSE fact.
    const ownProjection = result.product?.lifecycle === latest.lifecycle
    const storeId = targets.get(row.draftId) ?? latest.target_store_id
    if (!ownProjection && latest.target_store_id !== before.target_store_id) return row
    if (!ownProjection && (latest.lifecycle.revision !== before.lifecycle.revision
      || latest.lifecycle.view_revision > before.lifecycle.view_revision)) return row
    const diagnostic = current.mediaEpoch === beforeState.mediaEpoch ? diagnosticReferenceFrom(result) : undefined
    const bindDiagnostic = (projected: typeof row): typeof row => ({ ...projected, publishDiagnostic: diagnostic && current.cardId ? {
      ...diagnostic, identity: { scope: current.scope, mediaEpoch: current.mediaEpoch, cardId: current.cardId,
        rowId: row.draftId, storeId, revision: latest.lifecycle.revision, viewRevision: latest.lifecycle.view_revision },
    } : undefined })
    const publishRequestEvidence = current.cardId ? capturePublishRequestEvidence(result.error, {
      scope: current.scope, mediaEpoch: beforeState.mediaEpoch, cardId: current.cardId, rowId: row.draftId,
      storeId, revision: latest.lifecycle.revision, viewRevision: latest.lifecycle.view_revision,
    }) : undefined
    const cause = publishRequestEvidence?.requestCause
    if (publishRequestEvidence && cause && cause.rowIds.some((id) => !draftIds.includes(id) || targets.get(id) !== cause.storeId)) {
      publishRequestEvidence.contractInvalid = true
      publishRequestEvidence.requestCause = undefined
    }
    if (result.product && (result.product.target_store_id !== storeId
      || result.product.lifecycle.revision < latest.lifecycle.revision
      || result.product.lifecycle.view_revision < latest.lifecycle.view_revision)) return row
    if (result.product && (result.outcome !== "unknown" || ["accepted", "queued", "submitting"].includes(result.product.lifecycle.stage))) {
      productDrafts[row.draftId] = {
        ...latest,
        lifecycle: {
          ...result.product.lifecycle,
          ...(result.submissionReceipt ? { submissionReceipt: result.submissionReceipt } : {}),
          ...(result.taskId ? { taskId: result.taskId } : {}),
        },
      }
      const evidence = publishRequestEvidence && result.outcome === "blocked" ? { ...publishRequestEvidence,
        identity: { ...publishRequestEvidence.identity, revision: result.product.lifecycle.revision, viewRevision: result.product.lifecycle.view_revision } } : undefined
      return bindDiagnostic({ ...projectListingRowLifecycle(row, result.product.lifecycle, result.product.readiness), publishRequestEvidence: evidence,
        log: blockedLogs.get(result.row_id) ?? (result.submissionReceipt ? "已取得发送响应" : "发送状态已刷新") })
    }
    if (result.outcome === "unknown") {
      const unknown = { ...latest.lifecycle, stage: "outcome_unknown" as const,
        ...(result.submissionReceipt ? { submissionReceipt: result.submissionReceipt } : {}) }
      productDrafts[row.draftId] = { ...latest, lifecycle: unknown }
      return bindDiagnostic({ ...projectListingRowLifecycle(row, unknown), publishUnconfirmed: true, publishRequestEvidence, log: UNCONFIRMED_PUBLISH_MESSAGE })
    }
    if (result.submissionReceipt) {
      productDrafts[row.draftId] = {
        ...latest,
        lifecycle: {
          ...latest.lifecycle,
          submissionReceipt: result.submissionReceipt,
          taskId: result.taskId,
        },
      }
      return bindDiagnostic({ ...row, publishRequestEvidence: undefined, log: "已取得发送响应" })
    }
    if (result.outcome === "start") return bindDiagnostic({ ...row, publishRequestEvidence: undefined, log: "发送状态已刷新" })
    productDrafts[row.draftId] = before
    const original = beforeState.rows.find((item) => item.draftId === row.draftId)!
    // This branch replays the lifecycle we already had. A request refusal is
    // not a server stage that released the offer, so an existing local lock stays.
    const projected = projectListingRowLifecycle(row, before.lifecycle, original.readiness)
    return bindDiagnostic({
      ...projected,
      ...(result.outcome === "blocked" ? { status: "failed" as const } : {}),
      ...(row.publishUnconfirmed ? { publishUnconfirmed: true } : {}),
      publishRequestEvidence,
      log: result.outcome === "blocked"
        ? blockedLogs.get(result.row_id) ?? blockedPublishMessage(result)
        : result.noop_reason ? publishSkipMessage(result.noop_reason) : original.log,
    })
  })
  return { productDrafts, rows, queueFrozenIds: draftIds }
}
