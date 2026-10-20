import { resolveLegacyPublishRemediation } from "./legacy-publish-input"
import type { PublishRemediation, PublishRemediationFacts, PublishProblem } from "./publish-problem"
import { issueSolution, solutionScope, resolvePublishSolution, type NativeIssueKey } from "./publish-solutions"
import { contractSolution, offerBusySolution, psdSolutions } from "./publish-solutions-controls"
import { currentPublishRequestEvidence, requestEvidenceRemediation } from "./publish-request-evidence"
import { brandRepairIssueCurrent } from "../brand-repair"
import { wbLocationPresentation } from "./publish-wb-location"

export { brandRepairRowIds } from "./legacy-publish-input"
export type { PublishRemediation, PublishRemediationFacts } from "./publish-problem"

/** Presentation composition, independent of whether input arrived from a row or an Intent. */
export function resolvePublishRemediation(facts: PublishRemediationFacts | PublishProblem): PublishRemediation | undefined {
  if (!("lifecycle" in facts)) {
    const location = facts.location === undefined ? undefined : wbLocationPresentation(facts)
    const invalidLocation = facts.location !== undefined && !location
    const solution = invalidLocation ? contractSolution : resolvePublishSolution(facts)
    if ((facts.platform === "wb" || facts.location !== undefined) && solution === contractSolution) return {
      cause: "contract_invalid", reason: contractSolution.reason,
      scope: "WB 预览问题的坐标或分类无法确认；尚未定位到商品组、变体或特征",
      steps: ["保留本机诊断编号，请管理员核对 WB 原生问题坐标、分类与本地模块版本；重新载入原预览记录后明确校验，确认前不要按此问题修改某个变体"],
      traceId: facts.traceId, reportable: contractSolution.reportable, diagnosticCode: contractSolution.diagnosticCode,
    }
    const platform = facts.platform === "ozon" ? "Ozon" : facts.platform === "wb" ? "WB" : "未识别平台"
    const stages = { metadata: "类目材料", validate: "字段校验", freeze: "发送快照",
      pre_dispatch: "派发前检查", submit: "发送", preview: "预览", render: "切片", save: "保存" } satisfies Record<NativeIssueKey["stage"] | "render" | "save", string>
    const field = facts.field && /^[a-zA-Z0-9_.-]{1,96}$/.test(facts.field) ? `；字段 ${facts.field}` : ""
    const missingWbLocation = facts.platform === "wb" && facts.family === undefined && !location
    const scope = location?.scope ?? (missingWbLocation ? `原生问题未提供完整商品组位置${field}` : `${solutionScope(solution.scope)}${field}`)
    return { cause: solution === contractSolution ? "contract_invalid" : "structured_issue",
      reason: solution.reason, scope: `${platform} · ${Object.entries(stages).find(([stage]) => stage === facts.stage)?.[1] ?? "契约校验"}；${scope}`,
      steps: [...(location ? [location.step] : missingWbLocation ? ["重新载入原 WB 预览记录并明确校验，以取得商品组与原生变体位置；不要猜测应修改的变体"] : []), ...solution.steps],
      traceId: facts.traceId, reportable: solution.reportable, diagnosticCode: solution.diagnosticCode }
  }
  const { lifecycle } = facts
  if (["queued", "submitting", "accepted"].includes(lifecycle.stage)) return undefined
  const evidence = currentPublishRequestEvidence(facts.requestEvidence, facts.requestIdentity)
  const request = evidence && requestEvidenceRemediation(evidence)
  const fenced = (value: PublishRemediation | undefined) => value && request
    ? { ...value, scope: `${value.scope}；${request.scope}`, traceId: request.traceId ?? value.traceId,
      steps: [...new Set([...value.steps, ...request.steps])] } : value
  if (facts.localUnconfirmed) return fenced(resolveLegacyPublishRemediation({ ...facts, lifecycle: { ...lifecycle, stage: "outcome_unknown" } }))
  if (["outcome_unknown", "operator_attested"].includes(lifecycle.stage)
    || facts.readiness?.blockers.some((code) => code === "outcome_unknown" || code === "operator_attested")) {
    return fenced(resolveLegacyPublishRemediation(facts))
  }
  if (request && evidence?.requestCause) return request
  const failure = facts.psdTemplateFailure
  if (failure && facts.tracks?.render === "failed"
    && facts.tracks.preparationRender?.since_ms === failure.attemptSinceMs) {
    const solution = psdSolutions[failure.cause]
    return { cause: "prepare_leg", reason: failure.message, scope: "仅此行当前切片尝试；识别和已有媒体结果保留",
      steps: [...solution.steps], action: { kind: "retry_stage", verb: "render", label: "重试切片" } }
  }
  const issue = lifecycle.submission_issue
  if (issue && issue.resolved_at_ms == null && issue.input_revision === lifecycle.revision) {
    const solution = issueSolution(issue, facts.platform?.toLowerCase() ?? "ozon")
    const repair = lifecycle.stage === "publish_rejected" && facts.brandRepairable && solution.actions.includes("edit_row")
      && brandRepairIssueCurrent(lifecycle, issue.row_id, issue.store_id)
      ? resolveLegacyPublishRemediation(facts)?.action : undefined
    return {
      cause: solution === contractSolution ? "contract_invalid" : "structured_issue",
      reason: solution.reason, scope: solutionScope(solution.scope), steps: [...solution.steps],
      traceId: issue.trace_id, reportable: solution.reportable, diagnosticCode: solution.diagnosticCode,
      // Reuse only the admitted brand action; Cloud keeps ownership of the copy.
      ...(repair?.kind === "repair_brand" ? { action: repair } : {}),
    }
  }
  if (request) return request
  if (!facts.requestEvidence && facts.rowLog.includes(offerBusySolution.reason)) {
    return { cause: "request_offer_busy", reason: offerBusySolution.reason,
      scope: solutionScope(offerBusySolution.scope), steps: [...offerBusySolution.steps] }
  }
  return resolveLegacyPublishRemediation({ ...facts,
    rowLog: facts.requestEvidence && !evidence ? "" : facts.rowLog,
    // An old/resolved Cloud issue cannot regain brand permission via legacy copy.
    brandRepairable: facts.brandRepairable && !issue })
}
