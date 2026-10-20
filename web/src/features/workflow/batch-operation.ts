import type { WorkflowDraftView, WorkflowOperationRowResult, WorkflowRowsActionRequest } from "@/bindings/commands"
import type { BatchRowDeps } from "./batch-actions"
import { batchErrorFeedback } from "./batch-error-feedback"
import type { ListingRow } from "./model/listing-row"
import { listingRowLifecyclePatch } from "./model/listing-row-lifecycle"
import { PREPARATION_WAIT_LOG } from "./model/workflow-readiness"
import { operationBlockerMessage } from "./prepare/execution-context"
import { rowsReadyForPreparation } from "./product-instances"
import { listingWorkbenchScope, listingScopeCurrent } from "./workbench/listing-workbench-store"
import { commandError } from "./workflow-shared"

/** A row without a durable Product Instance cannot be prepared. */
const MISSING_INSTANCE_LOG = "找不到该图片对应的商品。"

/**
 * The one admission gate all three preparation verbs pass through. A row whose
 * Product Instance never became durable is failed on the row rather than sent to
 * Cloud, where it would fail with a far less legible message.
 */
function admitDurableRows(
  targets: readonly ListingRow[],
  deps: BatchRowDeps,
  onMissing: (row: ListingRow) => void,
): ListingRow[] {
  const drafts = deps.drafts()
  const { runnable, missing } = rowsReadyForPreparation(targets, drafts)
  for (const target of missing) {
    onMissing(target)
    deps.settleProgress(target.id, true)
    deps.patchRow(target.id, { status: "failed", log: MISSING_INSTANCE_LOG })
  }
  return runnable
}

export function workflowRowsActionRequest(
  rows: readonly ListingRow[],
  drafts: Record<string, WorkflowDraftView | undefined>,
): WorkflowRowsActionRequest {
  return {
    row_ids: rows.map((row) => row.draftId),
    expected_revisions: rows.map((row) => {
      const lifecycle = drafts[row.draftId]?.lifecycle
      if (!lifecycle) throw new Error(MISSING_INSTANCE_LOG)
      return { row_id: row.draftId, revision: lifecycle.revision, store_id: drafts[row.draftId]?.target_store_id }
    }),
  }
}

/** A settled row result as the row's log line. */
export function settledRowMessage(
  result: WorkflowOperationRowResult | undefined,
  completedLog: string,
): { message: string; failed: boolean } {
  if (!result) return { message: "云端未返回该商品的执行结果", failed: true }
  if (result.outcome === "blocked" && result.noop_reason === "revision_mismatch") {
    return { message: "商品已更新，请刷新后再发送", failed: true }
  }
  if (result.outcome === "blocked") {
    if (result.noop_reason === "store_unbound") return { message: "商品尚未绑定目标店铺", failed: true }
    if (result.noop_reason === "store_mismatch") return { message: "商品绑定的店铺与本次发送不一致", failed: true }
    if (result.noop_reason === "not_found") return { message: "商品云端记录不存在，请刷新后重试", failed: true }
    const issues = result.product?.issues?.map((issue) => issue.message.trim()).filter(Boolean)
    if (issues?.length) {
      return { message: `字段校验未通过：${[...new Set(issues)].join("、")}`, failed: true }
    }
  }
  // A 422 envelope says「当前状态无法执行此操作」and also carries blockers.
  // Map the blockers; the envelope is not a diagnosis.
  if (result.blockers.length) {
    return {
      message: result.blockers.map(operationBlockerMessage).join("、") || "当前状态不允许执行",
      failed: true,
    }
  }
  if (result.error) return { message: commandError(result.error, completedLog), failed: true }
  if (result.outcome === "blocked") {
    return { message: "当前状态不允许执行", failed: true }
  }
  if (result.outcome === "noop") {
    if (result.noop_reason === "cancelled") return { message: "准备已停止", failed: false }
    const lifecycle = result.product?.lifecycle
    const total = lifecycle?.image_total ?? 0
    if (total === 0 && /准备|切片|上传/.test(completedLog)) {
      return { message: "切片不完整，请重新切片", failed: true }
    }
    const expectsReady = completedLog.includes("准备") || completedLog.includes("上传")
    if (expectsReady && (lifecycle?.media !== "ready" || lifecycle.image_completed !== total)) {
      return { message: "切片不完整，请重新切片", failed: true }
    }
    return { message: "当前状态无需重复执行", failed: false }
  }
  const message =
    result.outcome === "wait"
      ? result.noop_reason === "queue_busy" ? "准备队列仍繁忙，稍后再次准备" : "相同任务已在运行"
      : result.outcome === "needs_review"
        ? "准备完成，等待确认 AI 候选"
        : completedLog
  return { message, failed: false }
}

/**
 * One preparation verb over a set of rows.
 *
 * The executor streams a row result per settled job and returns the settled
 * ones. A job failure never rejects the command: it arrives as `error` on its
 * own row, so one refused product cannot fail its siblings.
 *
 * Every streamed projection is painted the moment it lands — Draft onto the
 * Product Instance, lifecycle onto the row — and a settled row closes its
 * share of the batch counter right there, not when the whole batch returns.
 * An `interim` row is painted
 * but not settled: 一键准备 streams its recognition leg ahead of the media leg.
 * `interimLog` is what such a row says once recognition has landed; while
 * recognition is still running it keeps the start line.
 */
export async function runWorkflowOperationBatch(
  targets: readonly ListingRow[],
  deps: BatchRowDeps,
  action: (
    request: WorkflowRowsActionRequest,
    onRow: (row: WorkflowOperationRowResult) => void,
  ) => Promise<WorkflowOperationRowResult[]>,
  startPatch: Partial<ListingRow>,
  completedLog: string,
  interimLog = completedLog,
): Promise<string[]> {
  const scope = listingWorkbenchScope()
  const failures = new Map<string, string>()
  const feedback = batchErrorFeedback(deps.patchRow, deps.feedbackContext ?? {})
  const runnable = admitDurableRows(targets, deps, (target) => {
    feedback.settle(target, true, undefined, MISSING_INSTANCE_LOG)
    failures.set(target.id, `${target.imageName}：${MISSING_INSTANCE_LOG}`)
  })
  if (!runnable.length) return [...failures.values()]
  if (deps.stopRequested?.() === true) {
    for (const target of runnable) deps.settleProgress(target.id, false)
    return [...failures.values()]
  }
  deps.startRows(runnable.map((row) => row.id), { ...startPatch, errorFeedback: undefined })
  const targetsByDraft = new Map(runnable.map((target) => [target.draftId, target]))
  const feedbackFields = { plan: "preparationPlan", ai: "preparationAi", render: "preparationRender", upload: "preparationUpload" } as const
  const feedbackStages = new Map<string, Set<keyof typeof feedbackFields>>()
  const feedbackSettled = new Set<string>()
  const applyFeedback = (row: WorkflowOperationRowResult) => {
    if (feedbackSettled.has(row.row_id)) return
    const previous = feedbackStages.get(row.row_id) ?? new Set<keyof typeof feedbackFields>()
    if (row.preparation_progress === undefined && row.interim) return
    const next = row.preparation_progress ?? []
    const patch: Partial<ListingRow> = {}
    for (const stage of new Set([...previous, ...next.map((entry) => entry.stage)])) {
      patch[feedbackFields[stage]] = next.find((entry) => entry.stage === stage)
    }
    if (Object.keys(patch).length) deps.patchRow(targetsByDraft.get(row.row_id)!.id, patch)
    feedbackStages.set(row.row_id, new Set(next.map((entry) => entry.stage)))
    if (!row.interim) feedbackSettled.add(row.row_id)
  }
  const failRow = (target: ListingRow, reason: unknown) => {
    const message = commandError(reason, "操作失败")
    feedback.settle(target, true, reason, "操作失败")
    failures.set(target.id, `${target.imageName}：${message}`)
    deps.patchRow(target.id, { status: "failed", log: message })
    deps.settleProgress(target.id, true)
  }
  /**
   * One row's projection as it lands, called from inside the executor's own
   * await chain — a throw out of it would surface as the whole batch failing,
   * so it keeps a guard of its own and fails only the row it was painting.
   */
  const applyStreamedRow = (row: WorkflowOperationRowResult) => {
    const target = targetsByDraft.get(row.row_id)
    if (!target) return
    if (!listingScopeCurrent(scope)) {
      if (!row.interim) deps.settleProgress(target.id, settledRowMessage(row, completedLog).failed)
      return
    }
    const current = deps.drafts()[target.draftId]
    if (!current || (row.product && row.product.lifecycle.view_revision < current.lifecycle.view_revision)) {
      if (current) applyFeedback(row.interim ? row : { ...row, preparation_progress: [] })
      if (!row.interim) deps.settleProgress(target.id, settledRowMessage(row, completedLog).failed)
      return
    }
    try {
      applyFeedback(row)
      if (row.interim) {
        if (row.outcome === "wait" && row.noop_reason === "queue_busy") {
          deps.patchRow(target.id, { log: PREPARATION_WAIT_LOG })
          return
        }
        if (!row.product) return
        deps.commitProduct(target.draftId, row.product)
        deps.patchRow(target.id, {
          ...listingRowLifecyclePatch(row.product.lifecycle, row.product.readiness),
          log: row.product.lifecycle.ai === "ready" ? interimLog : startPatch.log ?? "准备进行中",
        })
        return
      }
      const { message, failed } = settledRowMessage(row, completedLog)
      if (failed) failures.set(target.id, `${target.imageName}：${message}`)
      if (row.product) {
        deps.commitProduct(target.draftId, row.product)
        deps.patchRow(target.id, {
          ...listingRowLifecyclePatch(row.product.lifecycle, row.product.readiness),
          log: message,
        })
      } else if (failed) {
        deps.patchRow(target.id, { status: "failed", log: message })
      }
      feedback.settle(target, failed, row.error, message)
      deps.settleProgress(target.id, failed)
    } catch (reason) {
      failRow(target, reason)
    }
  }
  let results: WorkflowOperationRowResult[]
  try {
    results = await action(
      workflowRowsActionRequest(runnable, deps.drafts()),
      applyStreamedRow,
    )
  } catch (reason) {
    if (!listingScopeCurrent(scope)) return [...failures.values()]
    const message = commandError(reason, completedLog)
    for (const target of runnable) {
      if (!listingScopeCurrent(scope)) break
      if (feedback.has(target) || !deps.drafts()[target.draftId]) continue
      feedback.settle(target, true, reason, "操作失败")
      applyFeedback({ row_id: target.draftId, outcome: "blocked", blockers: [], preparation_progress: [] })
      failures.set(target.id, `${target.imageName}：${message}`)
      await deps.settleRow(target, message, true)
    }
    return [...failures.values()]
  }
  if (!listingScopeCurrent(scope)) return [...failures.values()]
  // The returned array is the fallback for a streamed row the listener missed.
  // A successful projection is already the row Cloud wrote — `settleRow`'s
  // Cloud re-read cannot improve it, and N = 100 would
  // pay 100 extra reads on the InteractiveRead budget. Nor can a row Stop
  // cancelled before any projection landed: Cloud holds nothing newer than the
  // map's lifecycle, and the card stream carries what the stop changes later —
  // re-reading those held a stopped batch of 100 on ~90 serial reads. Failures
  // and missed projections still re-read so the table matches Cloud.
  const byDraft = new Map(results.map((result) => [result.row_id, result]))
  for (const target of runnable) {
    if (!listingScopeCurrent(scope)) break
    const result = byDraft.get(target.draftId)
    // Before the settle, never after: `settleRow` merges the ListingRowView lifecycle
    // onto whatever the map holds, and committing afterwards would put this
    // projection's older lifecycle back over it.
    const current = deps.drafts()[target.draftId]
    if (!current || (result?.product && result.product.lifecycle.view_revision < current.lifecycle.view_revision)) {
      if (current) applyFeedback({ row_id: target.draftId, outcome: "start", blockers: [], preparation_progress: [] })
      deps.settleProgress(target.id, settledRowMessage(result, completedLog).failed)
      continue
    }
    applyFeedback(result ?? { row_id: target.draftId, outcome: "blocked", blockers: [], preparation_progress: [] })
    if (result?.product) deps.commitProduct(target.draftId, result.product)
    const { message, failed } = settledRowMessage(result, completedLog)
    feedback.settle(target, failed, result?.error, message)
    if (failed) failures.set(target.id, `${target.imageName}：${message}`)
    if (result?.product && !failed) {
      deps.settleProgress(target.id, false)
      continue
    }
    if (!failed && result?.noop_reason === "cancelled") {
      deps.patchRow(target.id, { ...listingRowLifecyclePatch(current.lifecycle), log: message })
      deps.settleProgress(target.id, false)
      continue
    }
    await deps.settleRow(target, message, failed)
  }
  return [...failures.values()]
}

