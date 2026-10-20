import { errorMessage } from "@/lib/error-message"
import { acceptedPublishCopy } from "./accepted-status"
import { contractSolution } from "./publish-solutions-controls"
import { issueSolution, solutionScope } from "./publish-solutions"
import type {
  RowStage,
  WorkflowProductLifecycle,
  WorkflowReadinessBlockerCode,
  WorkflowReadinessReport,
  WorkflowValidationIssue,
} from "@/bindings/commands"
import type { TrackStatus } from "../prepare/pipeline-machine"

export const PREPARATION_WAIT_LOG = "排队等待，资源可用后自动继续"

/**
 * The fallback title a row stage reads as, when no more specific detail
 * (issue, failure log, activity) applies: preparation lanes read 仍需准备, the
 * send pipeline 等待发送结果.
 */
export const stageCopy: Record<RowStage, { title: string }> = {
  awaiting_content: { title: "仍需准备" },
  recognizing: { title: "仍需准备" },
  rendering: { title: "仍需准备" },
  uploading: { title: "仍需准备" },
  recognition_failed: { title: "需要处理" },
  media_failed: { title: "需要处理" },
  candidates_pending: { title: "等待人工确认" },
  build_stale: { title: "可以发送" },
  fields_invalid: { title: "需要处理" },
  ready_to_publish: { title: "可以发送" },
  queued: { title: "等待发送结果" },
  submitting: { title: "等待发送结果" },
  outcome_unknown: { title: "发送结果待核实" },
  accepted: { title: "发送完成" },
  publish_rejected: { title: "需要处理" },
  operator_attested: { title: "人工封存" },
}

/** Whether the stage still owes preparation work. */
function needsPreparation(stage: RowStage): boolean {
  return stage === "awaiting_content" || stage === "recognizing" || stage === "rendering" || stage === "uploading"
}

export const readinessBlockerCopy: Record<WorkflowReadinessBlockerCode, string> = {
  ai_pending: "AI 识别尚未开始",
  ai_running: "AI 正在识别",
  ai_failed: "AI 识别失败",
  candidates_unsettled: "AI 候选字段尚未全部确认或忽略",
  media_pending: "图片渲染与上传尚未开始",
  media_running: "图片正在渲染或上传",
  media_failed: "图片渲染或上传失败",
  fields_dirty: "Listing 发布校验尚未运行",
  fields_validating: "Listing 正在校验字段",
  fields_invalid: "字段未通过 Listing 校验",
  outcome_unknown: "已提交 Ozon，结果未返回，系统会自动核对，不会自动重发",
  operator_attested: "操作员已封存证据缺口，但尚未证明 Ozon 已上架",
  publish_conflict: "发布结果存在冲突，请检查发送记录",
  publish_rejected: "发布未成功，请检查发送记录",
}

/** Server wait copy when the row is blocked on a running rail or a Wait issue. */
export function prepareWaitReason(
  lifecycle: WorkflowProductLifecycle,
  report: WorkflowReadinessReport,
): string | undefined {
  const issue = lifecycle.submission_issue
  if (issue && issue.input_revision === lifecycle.revision && issue.resolved_at_ms == null
    && issueSolution(issue) !== contractSolution && issue.allowed_actions.includes("wait")) return issue.summary
  if (report.blockers.includes("ai_running")) return readinessBlockerCopy.ai_running
  if (report.blockers.includes("media_running")) return readinessBlockerCopy.media_running
  return undefined
}

const RESTORED_PHASE_LOG = /^已恢复\s*·\s*[a-z_]+$/i

/**
 * A send this client refused before enqueueing — the row is still server-side
 * ready, but the operator clicked 发送 and nothing happened. These logs are
 * written by the publish queue (`commitRowLog`) and must surface in the cell,
 * otherwise 可发送 reads as if the click never happened.
 */
const SEND_REFUSAL_LOG = /(已在 Ozon 存在|未重复创建|发送未执行|商品已更新，请刷新后再发送|当前状态不能发送)/
const SEND_PROGRESS_LOG = /(正在提交发送|已进入发送队列)/

/** Durable submission evidence a local refusal line must never outrank. */
/** Shown when Cloud has not yet projected an import-probe sentence. */
export const UNKNOWN_PUBLISH_FALLBACK =
  "已提交 Ozon，结果未返回，系统会自动核对；确认未创建前不要重新发送"

const DURABLE_SUBMISSION_STAGES: readonly RowStage[] = [
  "queued",
  "submitting",
  "accepted",
  "outcome_unknown",
  "operator_attested",
]

/**
 * The refusal this client wrote for the operator's latest 发送 click, when it
 * is still the row's current truth. It outranks a historical rejection
 * (`last_error_detail` describes the previous attempt), but never a dispatched,
 * accepted or unresolved submission: those rows already carry Cloud evidence,
 * and a stale local line must not reopen them.
 */
export function currentSendRefusal(
  lifecycle: WorkflowProductLifecycle,
  report: WorkflowReadinessReport,
  rowLog: string,
): string | undefined {
  if (DURABLE_SUBMISSION_STAGES.includes(lifecycle.stage)) return undefined
  if (report.blockers.includes("outcome_unknown") || report.blockers.includes("operator_attested")) {
    return undefined
  }
  const log = rowLog.trim()
  return SEND_REFUSAL_LOG.test(log) ? log : undefined
}

/** Start / success markers written while a verb is in flight — not failure reasons. */
const TRANSIENT_ROW_LOG =
  /^(AI 识别已开始|已排队等待渲染槽位|媒体槽位已获取，正在独立进程渲染|正在上传切片|切片已生成，等待上传|切片已公网可读|AI 字段已写入商品草稿|发送状态已刷新|本地源图不可用；已上传媒体仍可发送，重新识别或切片需重新导入|未就绪，已跳过 · 不是 Ozon 拒绝)$/

/** Verb completion. It says the step finished, not which field failed. */
const COMPLETION_ROW_LOG = /^(准备已完成)$/

function interruptedPreparationCopy(
  lifecycle: WorkflowProductLifecycle,
  report: WorkflowReadinessReport,
): string {
  const retryAi = lifecycle.ai === "failed" || report.blockers.includes("ai_failed")
  const retryMedia = lifecycle.media === "failed" || report.blockers.includes("media_failed")
  if (retryAi && retryMedia) return "准备被中断，请重试识别和图片准备"
  if (retryAi) return "AI 识别被中断，请重试识别"
  if (retryMedia) return "图片准备被中断，请重试切片或上传"
  return "准备过程被中断，请重试失败步骤"
}

function blockerDetail(report: WorkflowReadinessReport): string | undefined {
  const blocker = report.blockers[0]
  if (!blocker) return undefined
  const problem = readinessBlockerCopy[blocker]
  if (report.allowed_actions.includes("retry_ai")) return `${problem}，请重试识别`
  if (report.allowed_actions.includes("retry_media")) return `${problem}，请重试图片准备`
  if (report.allowed_actions.includes("recover")) return `${problem}，可按原货号恢复重试`
  if (report.allowed_actions.includes("reconcile")) return `${problem}，请先对账`
  if (report.allowed_actions.includes("edit_fields")) return `${problem}，请检查字段`
  return problem
}

/** The three preparation tracks a row carries, as the publish cell reads them. */
export type RowPreparationTracks = Record<"ai" | "render" | "upload", TrackStatus>

/**
 * What a 仍需准备 row is doing right now, from its three tracks: the leg in
 * flight first (识别 before 切片 before 上传, the order the legs run in), then
 * a leg that failed on this device and has no Cloud verdict yet. Undefined when
 * nothing is moving — the readiness title stands on its own then.
 */
export function preparationActivityCopy(tracks: RowPreparationTracks): string | undefined {
  if (tracks.ai === "running") return "识别中"
  if (tracks.render === "running") return "切片中"
  if (tracks.upload === "running") return "上传中"
  return preparationFailureCopy(tracks)
}

/**
 * The failed leg's own two words, when the publish strip draws that leg as a ⚠
 * that retries it. The glyph's tooltip already says this, so the cell drops the
 * sentence instead of printing the same state twice; cause, scope and the
 * leg-only retry live in the row's collapsed remediation (`publish-remediation`).
 */
export function preparationFailureCopy(tracks: RowPreparationTracks): string | undefined {
  if (tracks.ai === "failed") return "识别失败"
  if (tracks.render === "failed") return "切片失败"
  if (tracks.upload === "failed") return "上传失败"
  return undefined
}

/**
 * The row's own words for why this row failed.
 *
 * `failure_log` carries a Chinese sentence, and often the operator's next step,
 * written where the failure happened — `钱包余额不足：可用 0 microfen，本次需要
 * 预占 400000 microfen` rather than `workflow_quota_exceeded`. It has been
 * unread: the table showed the bare code, so a
 * problem the operator can fix in one click read as "AI is broken".
 *
 * Newest entry for the currently failed rail, because a retry appends rather
 * than replaces and restored rows can retain older entries from another rail.
 */
function recordedFailure(
  lifecycle: WorkflowProductLifecycle,
  report: WorkflowReadinessReport,
): string | undefined {
  const entry = lifecycle.failure_log
    ?.slice()
    .reverse()
    .find((item) =>
      (item.stage === "ai" && (lifecycle.ai === "failed" || report.blockers.includes("ai_failed"))) ||
      (item.stage === "media" && (lifecycle.media === "failed" || report.blockers.includes("media_failed"))) ||
      (item.stage === "validation" && (lifecycle.fields === "invalid" || report.blockers.includes("fields_invalid"))),
    )
  if (!entry?.message?.trim()) return undefined
  const message = entry.message.trim()
  const remediation = entry.remediation?.trim()
  return remediation && !message.includes(remediation)
    ? `${message} · ${remediation}`
    : message
}

/**
 * Exact, operator-facing status detail for the fixed-width publish cell.
 * Lifecycle and readiness remain the authority; the transient row log is used
 * only when it carries a real error, not a restore marker or an in-flight
 * progress line such as「AI 识别已开始」. A 仍需准备 row with a leg in flight
 * names that leg instead (`preparationActivityCopy`), so a batch reads
 * 识别中 → 切片中 → 上传中 row by row rather than 仍需准备 until it is done.
 */
/** Unique field sentences for the current verdict. Duplicate rules collapse. */
export function fieldIssueSummary(
  issues: readonly Pick<WorkflowValidationIssue, "message">[] | undefined,
): string | undefined {
  if (!issues?.length) return undefined
  const messages = [...new Set(issues.map((issue) => issue.message.trim()).filter(Boolean))]
  return messages.length ? messages.join("、") : undefined
}

export function publishStateDetail(
  lifecycle: WorkflowProductLifecycle,
  report: WorkflowReadinessReport,
  rowLog: string,
  exceptional: boolean,
  tracks?: RowPreparationTracks,
  issues?: readonly Pick<WorkflowValidationIssue, "message">[],
): { text: string; fullText: string } {
  if (!exceptional) {
    if (lifecycle.stage === "queued" || lifecycle.stage === "submitting") {
      const text = lifecycle.stage === "queued" ? "等待发送，尚未派发" : "已提交，等待 Ozon 回执"
      return { text, fullText: text }
    }
    if (lifecycle.stage === "accepted") {
      const text = acceptedPublishCopy(lifecycle).detail
      return { text, fullText: text }
    }
    const activity =
      needsPreparation(lifecycle.stage) && tracks ? preparationActivityCopy(tracks) : undefined
    const refusal = SEND_REFUSAL_LOG.test(rowLog) ? rowLog.trim() : undefined
    const progress = SEND_PROGRESS_LOG.test(rowLog) ? rowLog.trim() : undefined
    const waiting = needsPreparation(lifecycle.stage) && rowLog === PREPARATION_WAIT_LOG ? "排队等待，自动继续" : undefined
    const text = refusal ?? progress ?? waiting ?? activity ?? stageCopy[lifecycle.stage].title
    return { text, fullText: rowLog.trim() || text }
  }

  if (lifecycle.stage === "operator_attested") {
    const text = "已人工封存，但尚未证明 Ozon 已上架"
    return { text, fullText: text }
  }

  if (lifecycle.stage === "outcome_unknown" || report.blockers.includes("outcome_unknown")) {
    const detail = lifecycle.last_error_detail?.trim()
    // Only the projected reconcile sentence. A leftover timeout or refusal
    // line belongs to an earlier attempt and must not replace this stage.
    const text = detail?.includes("自动核对") ? detail : UNKNOWN_PUBLISH_FALLBACK
    return { text, fullText: text }
  }
  const issue = lifecycle.submission_issue
  if (issue && issue.resolved_at_ms == null && issue.input_revision === lifecycle.revision) {
    const solution = issueSolution(issue)
    return { text: solution.reason, fullText: `${solution.reason} · ${solutionScope(solution.scope)} · ${solution.steps.join("；")}` }
  }

  // The latest click's own refusal is the current cause; the projected detail
  // and its code belong to the earlier attempt and are not appended to it.
  const refusal = currentSendRefusal(lifecycle, report, rowLog)
  if (refusal) return { text: refusal, fullText: refusal }

  const publicationCode = lifecycle.last_error_code?.trim()
  if (lifecycle.stage === "publish_rejected" && publicationCode
    && !["OZON_WRITES_DISABLED", "BR_hashtag_brand", "SPU_ALREADY_EXISTS_IN_ANOTHER_ACCOUNT", "CREDENTIAL_EXPIRED"].includes(publicationCode)) {
    return { text: contractSolution.reason, fullText: `${contractSolution.reason}；${contractSolution.steps.join("；")}` }
  }
  const projected = lifecycle.last_error_detail ? errorMessage({ message: lifecycle.last_error_detail }, "") : undefined
  if (projected) {
    const code = lifecycle.last_error_code?.trim()
    const fullText = code && !projected.includes(code) ? `${projected} · ${code}` : projected
    return { text: projected, fullText }
  }

  // Structured issues are this validation attempt. A prepare completion line
  // ("准备已完成") must not outrank them or the recorded validation sentence.
  const fieldIssues = lifecycle.stage === "fields_invalid" || report.blockers.includes("fields_invalid")
    ? fieldIssueSummary(issues)
    : undefined
  if (fieldIssues) return { text: fieldIssues, fullText: fieldIssues }

  const publishBlocker = report.blockers.find(
    (blocker) => blocker === "publish_conflict" || blocker === "publish_rejected",
  )
  const trimmedLog = rowLog.trim()
  const hasExactLog =
    trimmedLog.length > 0 &&
    !RESTORED_PHASE_LOG.test(trimmedLog) &&
    !TRANSIENT_ROW_LOG.test(trimmedLog) &&
    !COMPLETION_ROW_LOG.test(trimmedLog)
  const code = lifecycle.last_error_code?.trim()
  const text = code === "preparation_interrupted"
    ? interruptedPreparationCopy(lifecycle, report)
    : hasExactLog
      ? trimmedLog
      // The recorded sentence first. `blockerDetail` is this file's generic
      // copy for a blocker class ("AI 识别失败，请重试识别"); `failure_log`
      // carries what actually happened and what it would take to fix it. The
      // generic line stays as the fallback for blockers nothing recorded.
      : (publishBlocker ? readinessBlockerCopy[publishBlocker] : undefined)
        ?? recordedFailure(lifecycle, report)
        ?? blockerDetail(report)
        ?? (code ? "此行的处理记录缺少可识别原因；请核对失败步骤并保留诊断编号联系管理员" : stageCopy[lifecycle.stage].title)
  return { text, fullText: text }
}
