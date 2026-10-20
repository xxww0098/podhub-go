import { errorMessage } from "@/lib/error-message"
import type { WorkflowProductLifecycle, WorkflowReadinessReport } from "@/bindings/commands"
import type { PublishRemediation, PublishRemediationFacts } from "./publish-problem"
import { preparationStepViews, STAGE_LABEL as LEG_LABEL, STAGE_RETRY_LABEL, visiblePreparationProgress } from "../prepare/preparation-branches"
import type { PreparationVerb } from "../prepare/preparation-tracks"
import { offerIdFromView } from "../submit/publish-policy"
import { publishStateDetail, readinessBlockerCopy } from "./workflow-readiness"
import { contractSolution } from "./publish-solutions-controls"

// Legacy templates receive normalized view facts; interpretation of stages and
// latest row-log refusals stays in legacy-publish-input.
export const LEGACY_PUBLISH_PLATFORM = "Ozon"
export type LegacyRefusalKind = "psd" | "stale" | "candidates" | "fields" | "existing" | "store" | "other"
const MISSING_SOURCE = /(缺少源图|源图不可用|重新导入原图)/
const RESEND_WHEN_READY = "保存后通过字段校验；确认此行允许发送且没有未确认的旧操作，再明确发送"

function platformOf(facts: PublishRemediationFacts): string {
  return facts.platform?.trim() || LEGACY_PUBLISH_PLATFORM
}

/** Cloud re-injects the source stem as the offer ID before every send. */
function offerOf(facts: PublishRemediationFacts): string {
  const stem = offerIdFromView(undefined, facts.imageName ?? facts.lifecycle.source_file_name ?? "")
  return stem ? `「${stem}」` : "（本行源图文件名）"
}

function mediaClause(lifecycle: WorkflowProductLifecycle): string {
  return lifecycle.media === "ready" && lifecycle.image_total > 0
    ? `已上传的 ${lifecycle.image_total} 张商品图片保留，无需重新切片或上传`
    : "本行已有的识别与图片准备结果保持不变"
}

function notDispatched(facts: PublishRemediationFacts): string {
  return `仅此行；本次发送在派发前被拒绝，未提交到 ${platformOf(facts)}；${mediaClause(facts.lifecycle)}`
}

/** The recorded sentence with its code, without repeating a code it already names. */
function withCode(detail: string | undefined, code: string | undefined): string | undefined {
  const text = detail ? errorMessage({ message: detail }, "") : undefined
  const tag = code?.trim()
  if (!text) return undefined
  return tag && !text.includes(tag) ? `${text}（错误代码 ${tag}）` : text
}

function receiptStep(facts: PublishRemediationFacts, summary: string): string {
  const { lifecycle } = facts
  const platform = platformOf(facts)
  const task = lifecycle.taskId ? `，并核对导入任务 ${lifecycle.taskId}` : ""
  return lifecycle.submissionReceipt
    ? `展开「${summary}」，核对平台响应原文与提交批次`
    : `此行没有保存平台响应：到 ${platform} 卖家后台按货号${offerOf(facts)}查看导入记录${task}`
}

/**
 * The manual path Unknown and attested rows share. The import probe may accept
 * a found product or release two absences; this copy still does not promise a
 * resend, and it does not promise the row becomes sellable by itself.
 */
function manualCheckSteps(facts: PublishRemediationFacts): string[] {
  const { lifecycle } = facts
  const platform = platformOf(facts)
  const task = lifecycle.taskId ? `，并核对导入任务 ${lifecycle.taskId}` : ""
  return [
    `打开 ${platform} 卖家后台，按货号${offerOf(facts)}查找商品${task}`,
    lifecycle.submissionReceipt
      ? "展开「查看提交详情」，把回执与平台上的商品、任务状态逐项比对"
      : "此行没有保存平台回执或任务号，只能按货号在卖家后台核对",
    `已查到商品：直接在 ${platform} 卖家后台管理和核对该商品；本应用目前不会自动核实它是否可售，此行状态也不会因此自动更新`,
    "保留此行及其提交记录作为本次提交的凭证：不要删除此行，也不要重新发送",
  ]
}

function unknownOutcome(facts: PublishRemediationFacts): PublishRemediation {
  const platform = platformOf(facts)
  return {
    cause: "outcome_unknown",
    traceId: facts.lifecycle.submission_issue?.trace_id,
    reportable: true, diagnosticCode: "result_unknown",
    reason: `请求可能已到达 ${platform}，系统正在按货号核对是否已创建，不会自动重发`,
    scope: `仅此行；${platform} 可能已创建或更新该商品，此行已锁定，不能重新发送或重试`,
    steps: [
      ...manualCheckSteps(facts),
      "恢复待核对必须先取得原店铺确切 Intent ID 和操作权限，释放后重新读回同一操作并通过原生校验；本页未接入该能力时请管理员核对，不能仅凭货号解锁",
    ],
  }
}

function attested(facts: PublishRemediationFacts): PublishRemediation {
  const platform = platformOf(facts)
  return {
    cause: "operator_attested",
    reason: `已人工封存，但尚未证明 ${platform} 已上架`,
    scope: "仅此行；此行已封存，系统不会重试或重新发送",
    steps: manualCheckSteps(facts),
  }
}

function sendRefusal(kind: LegacyRefusalKind, refusal: string, facts: PublishRemediationFacts): PublishRemediation {
  const scope = notDispatched(facts)
  if (kind === "psd") {
    return {
      cause: "send_refused_psd",
      reason: refusal,
      scope,
      steps: [
        "返回「上架方案」列表，找到此行所属的上架方案",
        "点该方案的 PSD 绑定，重新选择此前使用的同一个原始 PSD 文件（不要换成其他 PSD）",
        "等待页面确认 PSD 已在云端保存，再回到此工作台",
        RESEND_WHEN_READY,
      ],
    }
  }
  if (kind === "stale") {
    return {
      cause: "send_refused_stale",
      reason: refusal,
      scope,
      steps: ["刷新页面，载入此行的最新版本", "核对此行字段是否仍符合预期", RESEND_WHEN_READY],
    }
  }
  if (kind === "candidates") {
    return {
      cause: "send_refused_candidates",
      reason: refusal,
      scope,
      steps: ["打开「审阅建议」，逐项确认或忽略此行的 AI 候选", RESEND_WHEN_READY],
      action: { kind: "review_candidates", label: "审阅建议" },
    }
  }
  if (kind === "fields") {
    return {
      cause: "send_refused_fields",
      reason: refusal,
      scope,
      steps: ["查看此行标红的字段，或打开「默认字段」检查缺少的必填项", "修改并保存，保存后会自动重新校验", RESEND_WHEN_READY],
    }
  }
  if (kind === "existing") {
    return {
      cause: "send_refused_existing",
      reason: refusal,
      scope: `仅此行；${platformOf(facts)} 已有此前发送的商品，本次没有重复创建`,
      steps: [
        `到 ${platformOf(facts)} 卖家后台按货号${offerOf(facts)}核对已有商品`,
        "需要修改时在卖家后台处理已有商品，不要在此重复发送",
      ],
    }
  }
  if (kind === "store") {
    return {
      cause: "send_refused_store",
      reason: refusal,
      scope,
      steps: [
        "返回「上架方案」检查绑定的店铺；多店铺方案请确认此行分配的店铺仍在方案中",
        "店铺显示未配置或密钥过期时，到「店铺」页处理（本页不显示密钥）",
        RESEND_WHEN_READY,
      ],
    }
  }
  return {
    cause: "send_refused",
    reason: refusal,
    scope,
    steps: ["刷新页面，核对此行最新状态", "按此行状态提示完成缺少的步骤", RESEND_WHEN_READY],
  }
}

function durableLegFailure(lifecycle: WorkflowProductLifecycle): boolean {
  return lifecycle.ai === "failed" || lifecycle.media === "failed" ||
    lifecycle.stage === "recognition_failed" || lifecycle.stage === "media_failed"
}

const PROGRESS_STAGE = { ai: "ai", render: "render", deliver: "upload" } as const

const LEG_STEPS: Record<PreparationVerb, string[]> = {
  ai: ["点「重试识别」只重新识别此行（识别按次计费）", "识别完成后确认 AI 候选，再继续切片和上传"],
  render: ["确认上架方案绑定的 PSD 模板仍可用", "点「重试切片」只重新切片此行", "切片完成后继续上传"],
  deliver: ["点「重试上传」只重新上传此行未交付的切片", "反复失败时请联系管理员检查媒体存储配置"],
}

function legFailure(
  leg: PreparationVerb, facts: PublishRemediationFacts, report: WorkflowReadinessReport,
): PublishRemediation {
  const { lifecycle } = facts
  const label = LEG_LABEL[leg]
  const progress = facts.tracks
    ? visiblePreparationProgress(facts.tracks)
      .find((entry) => entry.state === "failed" && entry.stage === PROGRESS_STAGE[leg])?.message.trim()
    : undefined
  // A bare local ⚠ has neither Cloud's verdict nor the browser's words; any
  // readiness line would describe a different problem (仍需准备, a pending rail).
  const local = !progress && !durableLegFailure(lifecycle)
  const recordedReason = progress || (local
    ? `此行的${label}步骤在本机没有完成，且没有保存详细的异常信息`
    : publishStateDetail(lifecycle, report, facts.rowLog, true, trackStates(facts)).text)
  const reason = facts.hasSource === true && MISSING_SOURCE.test(recordedReason)
    ? `原图已恢复；上次${label}未完成，请重试${label}` : recordedReason
  const retained = (["ai", "render", "deliver"] as const)
    .filter((verb) => verb !== leg && legDone(verb, facts))
    .map((verb) => LEG_LABEL[verb])
  const kept = retained.length ? `${retained.join("、")}结果已完成并保留` : "此行尚无已完成的准备步骤"
  const scope = `仅此行的${label}步骤；${kept}，尚未发送到 ${platformOf(facts)}`
  // `failure_log` keeps older entries; only a failure Cloud or the browser still
  // reports may read one as its cause.
  const failureCode = local ? undefined : [...(lifecycle.failure_log ?? [])].reverse().find((entry) =>
    (leg === "ai" && entry.stage === "ai") || (leg !== "ai" && entry.stage === "media"))?.code

  if (failureCode === "workflow_quota_exceeded") {
    return {
      cause: "wallet_balance",
      reason,
      scope,
      steps: [
        "请 Workspace 管理员先为钱包充值（余额不足时重试同样会失败）",
        `充值完成后，点此行${label}步骤的 ⚠ 图标「${STAGE_RETRY_LABEL[leg]}」`,
      ],
    }
  }
  if (leg !== "deliver" && (facts.hasSource === false || (facts.hasSource !== true && MISSING_SOURCE.test(reason)))) {
    const file = lifecycle.source_file_name?.trim() || facts.imageName?.trim()
    return {
      cause: "missing_source",
      reason,
      scope: `${scope}；本机已找不到原图，${label}无法重试`,
      steps: [
        `用「导入」重新导入同一张原图${file ? `「${file}」` : ""}，不要改名或另存（货号由文件名生成）`,
        "确认此行缩略图已恢复",
        `再点「${STAGE_RETRY_LABEL[leg]}」；原图恢复前重试不会成功`,
      ],
    }
  }
  const check = local ? [`将指针移到此行${label}步骤的 ⚠ 图标，查看本机最后记录的状态`] : []
  return {
    cause: "prepare_leg",
    reason,
    scope,
    steps: [...check, ...LEG_STEPS[leg], RESEND_WHEN_READY],
    action: { kind: "retry_stage", verb: leg, label: STAGE_RETRY_LABEL[leg] },
  }
}

function trackStates({ tracks }: PublishRemediationFacts) {
  return tracks && { ai: tracks.ai ?? "idle", render: tracks.render ?? "idle", upload: tracks.upload ?? "idle" }
}

function legDone(verb: PreparationVerb, facts: PublishRemediationFacts): boolean {
  if (facts.tracks) {
    return preparationStepViews(facts.tracks).find((step) => step.verb === verb)?.state === "done"
  }
  const { lifecycle } = facts
  if (verb === "ai") return lifecycle.ai === "ready"
  if (verb === "render") {
    return ["rendered", "uploading", "ready"].includes(lifecycle.media) ||
      (lifecycle.media === "failed" && lifecycle.media_failure_stage === "upload")
  }
  return lifecycle.media === "ready"
}

function writesDisabled(facts: PublishRemediationFacts): PublishRemediation {
  const { lifecycle } = facts
  const platform = platformOf(facts)
  return {
    cause: "writes_disabled",
    reason: withCode(lifecycle.last_error_detail, lifecycle.last_error_code) ?? `PodHub 已暂停向 ${platform} 发送商品，本次尚未发送`,
    scope: `所有用户向 ${platform} 发送商品均受影响；此商品上次未发送到 ${platform}；${mediaClause(lifecycle)}`,
    steps: [
      "请联系 PodHub 管理员恢复发送服务；系统不会自动恢复，也不会自动重发",
      "恢复后刷新页面；如果修改过商品信息，请先核对",
      "选中商品并点击「发送」，无需重新识别或生成图片",
    ],
  }
}

function brandHashtag(facts: PublishRemediationFacts, report: WorkflowReadinessReport): PublishRemediation {
  const { lifecycle } = facts
  const reason = withCode(lifecycle.last_error_detail, lifecycle.last_error_code) ??
    `${platformOf(facts)} 拒绝了含品牌词的搜索标签（错误代码 BR_hashtag_brand）`
  const scope = "仅此行；识别结果和已上传图片保留，只需处理搜索标签"
  if (facts.brandRepairable) {
    return {
      cause: "brand_hashtag",
      reason,
      scope,
      steps: [
        "点「修复品牌字段」：清空此行违规的搜索标签并发送到 Ozon，复用识别结果和已上传图片",
        "发送后 Ozon 后台按新标签更新；未确认的旧发送仍保持锁定",
      ],
      action: { kind: "repair_brand", label: "修复品牌字段" },
    }
  }
  return {
    cause: "brand_hashtag",
    reason,
    scope,
    steps: [
      "在此行「标签」列删除含品牌名的搜索标签并保存",
      report.can_start_publish_attempt && report.allowed_actions.includes("publish")
        ? "保存后重新发送此行"
        : RESEND_WHEN_READY,
    ],
  }
}

function duplicateSpu(facts: PublishRemediationFacts): PublishRemediation {
  const { lifecycle } = facts
  const platform = platformOf(facts)
  return {
    cause: "duplicate_spu",
    reason: withCode(lifecycle.last_error_detail, lifecycle.last_error_code) ??
      "其他账号已有相同商品（跨账号 SPU 重复）",
    scope: `仅此行；${platform} 未为此行创建商品，${mediaClause(lifecycle)}`,
    steps: [
      `在 ${platform} 卖家后台按货号${offerOf(facts)}和提示中的店铺，核对重复的已有商品及其归属`,
      "应由另一店铺销售时，保留那边的商品，此行不要重发",
      `需要在本店上架时，先在 ${platform} 处理 SPU 归属再回到此行发送；系统不会自动重试或生成新货号`,
    ],
  }
}

function credentialExpired(facts: PublishRemediationFacts): PublishRemediation {
  const { lifecycle } = facts
  return {
    cause: "credential_expired",
    reason: withCode(lifecycle.last_error_detail, lifecycle.last_error_code) ?? "店铺密钥已过期",
    scope: `此行未发送；绑定同一店铺的其他行也会遇到同样问题；${mediaClause(lifecycle)}`,
    steps: [
      "在卖家后台重新生成密钥，到「店铺」页登记到该店铺（本页不显示密钥）",
      "登记后刷新页面",
      RESEND_WHEN_READY,
    ],
  }
}

function fieldsInvalid(facts: PublishRemediationFacts, report: WorkflowReadinessReport): PublishRemediation {
  const { lifecycle } = facts
  // Current structured issues are resolved by the composition layer; an old
  // issue must not replace this validation attempt's own field evidence.
  const reason = publishStateDetail(lifecycle, report, facts.rowLog, true, trackStates(facts), facts.issues).text
  const candidates = report.blockers.includes("candidates_unsettled") ||
    lifecycle.ai_candidates.some((candidate) => candidate.state === "proposed" || candidate.state === "unresolved")
  return {
    cause: "fields_invalid",
    reason,
    scope: `仅此行；尚未发送到 ${platformOf(facts)}，识别与图片结果保留`,
    steps: [
      ...(candidates ? ["打开「审阅建议」，逐项确认或忽略此行的 AI 候选"] : []),
      "查看此行标红的字段，或打开「默认字段」检查缺少的必填项",
      "修改并保存，保存后会自动重新校验",
      RESEND_WHEN_READY,
    ],
    ...(candidates ? { action: { kind: "review_candidates" as const, label: "审阅建议" } } : {}),
  }
}

function providerRejected(facts: PublishRemediationFacts, report: WorkflowReadinessReport): PublishRemediation {
  const { lifecycle } = facts
  const platform = platformOf(facts)
  const code = lifecycle.last_error_code?.trim()
  if (code) return { cause: "contract_invalid", reason: contractSolution.reason,
    scope: "此行的发布拒绝记录；代码未分类，不能据此授予重发或修复权限",
    steps: [...contractSolution.steps], reportable: true, diagnosticCode: contractSolution.diagnosticCode }
  const conflict = report.blockers.includes("publish_conflict")
  const reason = withCode(lifecycle.last_error_detail, code) ??
    (code
      ? `${platform} 拒绝了此行（错误代码 ${code}），但没有记录中文原因`
      : conflict
        ? readinessBlockerCopy.publish_conflict
        : `${platform} 没有接受此行，但系统没有记录拒绝原因或错误代码`)
  const canResend = report.can_start_publish_attempt && report.allowed_actions.includes("publish")
  return {
    cause: "provider_rejected",
    reportable: true, diagnosticCode: "unclassified_server",
    reason,
    scope: `仅此行；${platform} 未上架此行，识别结果和已上传图片保留`,
    steps: [
      receiptStep(facts, "查看失败详情"),
      "按平台指出的字段修改此行并保存",
      canResend ? "此行当前可以重新发送；修改保存后再发送" : RESEND_WHEN_READY,
    ],
  }
}

export const legacySolutions = {
  unknownOutcome, attested, sendRefusal, legFailure, writesDisabled,
  brandHashtag, duplicateSpu, credentialExpired, fieldsInvalid, providerRejected,
}
