import { legacySolutions, type LegacyRefusalKind } from "./publish-solutions-legacy"
import type { PublishRemediation, PublishRemediationFacts } from "./publish-problem"
import type { WorkflowDraftView, WorkflowReadinessReport } from "@/bindings/commands"
import { brandRepairEligible } from "../brand-repair"
import { preparationStepViews } from "../prepare/preparation-branches"
import type { PreparationActivity, PreparationVerb } from "../prepare/preparation-tracks"
import type { ListingRow } from "./listing-row"
import { currentSendRefusal } from "./workflow-readiness"

/**
 * How one failed or unresolved row gets fixed: what happened, what it touched,
 * and the operator's next steps — plus at most one existing, already
 * authorized row action. Pure: it reads the row facts the workbench already
 * holds and never asks the network.
 *
 * This is the legacy boundary where Ozon lifecycle facts (error codes, the
 * row log the publish queue writes) are read. The platform only reaches the
 * copy as a display label, so the renderer stays platform-free.
 */

const NO_REPORT: WorkflowReadinessReport = {
  ready_to_publish: false, can_start_publish_attempt: false, blockers: [], allowed_actions: [],
}

const PSD_UNBOUND = /PSD.*(云端保存|未绑定|重新绑定)/
const STORE_REFUSAL = /(店铺|密钥)/
const STALE_REFUSAL = /商品已更新，请刷新后再发送/
const CANDIDATE_REFUSAL = /AI 候选/
const FIELD_REFUSAL = /(字段校验未通过|字段需要重新校验|修正标记的字段)/
const EXISTING_REFUSAL = /(已在 Ozon 存在|未重复创建)/

/** Rows the existing brand repair policy admits right now, for the row cell. */
export function brandRepairRowIds(
  rows: readonly ListingRow[],
  productDrafts: Record<string, Pick<WorkflowDraftView, "lifecycle"> | undefined>,
  activity: PreparationActivity,
): ReadonlySet<string> {
  return new Set(rows
    .filter((row) => brandRepairEligible(row, productDrafts[row.draftId]?.lifecycle, row.readiness, activity))
    .map((row) => row.id))
}

export function resolveLegacyPublishRemediation(facts: PublishRemediationFacts): PublishRemediation | undefined {
  const { lifecycle } = facts
  const report = facts.readiness ?? NO_REPORT
  const stage = lifecycle.stage
  // In flight or accepted: the row is not failing, and its receipt stays concise.
  if (stage === "queued" || stage === "submitting" || stage === "accepted") return undefined
  // The Unknown fence comes before every other fact, including a newer local log
  // or a failed device-local track.
  if (stage === "outcome_unknown" || report.blockers.includes("outcome_unknown")) return legacySolutions.unknownOutcome(facts)
  if (stage === "operator_attested" || report.blockers.includes("operator_attested")) return legacySolutions.attested(facts)

  const refusal = currentSendRefusal(lifecycle, report, facts.rowLog)
  if (refusal) return legacySolutions.sendRefusal(refusalKind(refusal), refusal, facts)

  const leg = failedLeg(facts)
  if (leg) return legacySolutions.legFailure(leg, facts, report)

  // `last_error_code` outlives the failure it names; only a row that is still
  // rejected or invalid reads it as its current cause.
  const failing = stage === "publish_rejected" || stage === "fields_invalid" ||
    report.blockers.some((blocker) =>
      blocker === "publish_rejected" || blocker === "publish_conflict" || blocker === "fields_invalid")
  if (!failing) return undefined

  switch (lifecycle.last_error_code?.trim()) {
    case "OZON_WRITES_DISABLED": return legacySolutions.writesDisabled(facts)
    case "BR_hashtag_brand": return legacySolutions.brandHashtag(facts, report)
    case "SPU_ALREADY_EXISTS_IN_ANOTHER_ACCOUNT": return legacySolutions.duplicateSpu(facts)
    case "CREDENTIAL_EXPIRED": return legacySolutions.credentialExpired(facts)
  }
  if (stage === "fields_invalid" || report.blockers.includes("fields_invalid")) return legacySolutions.fieldsInvalid(facts, report)
  return legacySolutions.providerRejected(facts, report)
}

function refusalKind(refusal: string): LegacyRefusalKind {
  if (PSD_UNBOUND.test(refusal)) return "psd"
  if (STALE_REFUSAL.test(refusal)) return "stale"
  if (CANDIDATE_REFUSAL.test(refusal)) return "candidates"
  if (FIELD_REFUSAL.test(refusal)) return "fields"
  if (EXISTING_REFUSAL.test(refusal)) return "existing"
  if (STORE_REFUSAL.test(refusal)) return "store"
  return "other"
}

/**
 * The failed preparation leg: the step the strip draws as ⚠ first — browser
 * progress or a bare device-local track, even while Cloud still reads the row
 * as awaiting content — then the Cloud phases.
 */
function failedLeg(facts: PublishRemediationFacts): PreparationVerb | undefined {
  const drawn = facts.tracks && preparationStepViews(facts.tracks).find((step) => step.state === "failed")
  if (drawn) return drawn.verb
  const { lifecycle } = facts
  if (lifecycle.ai === "failed") return "ai"
  if (lifecycle.media === "failed") return lifecycle.media_failure_stage === "upload" ? "deliver" : "render"
  return undefined
}
