import { RowErrorFeedback } from "./row-error-feedback"
import { useReducer } from "react"
import type { WorkflowProductLifecycle } from "@/bindings/commands"
import { cachedListingRow } from "@/bindings/listing-row-cache"
import { Button } from "@/components/ui/button"
import { TONE_INK, TONE_SOLID } from "@/lib/receipt-state"
import { cn } from "@/lib/utils"
import { preparationOpen } from "../batch-actions"
import type { ListingRow } from "../model/listing-row"
import {
  bucketOf,
  canCancelPublishIntent,
  lifecycleSealed,
  prepareUiLabel,
  STAGE_LABEL,
  workbenchRowTone,
} from "../model/listing-row-lifecycle"
import { resolvePublishRemediation } from "../model/publish-remediation"
import { currentPublishRequestEvidence } from "../model/publish-request-evidence"
import { publishStoreAssignments } from "../submit/publish-policy"
import {
  preparationFailureCopy,
  prepareWaitReason,
  publishStateDetail,
} from "../model/workflow-readiness"
import { visiblePreparationProgress } from "../prepare/preparation-branches"
import type { PreparationVerb } from "../prepare/preparation-tracks"
import type { StoreTone } from "../store-tone"
import { ClampedTextTooltip } from "./clamped-text-tooltip"
import { PreparationStepLines } from "./preparation-step-lines"
import { PublishRemediation } from "./publish-remediation"
import { PublishSubmissionState } from "./publish-submission-state"
import { peekListingWorkbench } from "./listing-workbench-store"
import { currentWorkbenchDiagnostic } from "./publish-diagnostic-producer"
import { PublishDiagnosticDetails } from "./publish-diagnostic-details"
import { StoreAssignmentBadge } from "./store-assignment-badge"

export function PublishStateCell({
  row,
  lifecycle: suppliedLifecycle,
  rowStoreLabel,
  storeTone,
  onCancelIntent,
  onReviewCandidates,
  onRetryStage,
  onRepairBrand,
}: {
  row: ListingRow
  /** Threaded by row-window callers; the cell renders identically either way. */
  inView: boolean
  lifecycle?: WorkflowProductLifecycle
  rowStoreLabel?: string
  storeTone?: StoreTone
  onCancelIntent: () => void
  onReviewCandidates: () => void
  onRetryStage: (verb: PreparationVerb) => void
  /** Present only when the existing brand repair policy admits this row. */
  onRepairBrand?: () => void
}) {
  const [, refreshDiagnostic] = useReducer((version: number) => version + 1, 0)
  const lifecycle = row.publishUnconfirmed && suppliedLifecycle
    && !["queued", "submitting", "accepted"].includes(suppliedLifecycle.stage)
    ? { ...suppliedLifecycle, stage: "outcome_unknown" as const } : suppliedLifecycle
  const resident = row.publishRequestEvidence && cachedListingRow(row.draftId)
  const workbench = peekListingWorkbench()
  const diagnostic = currentWorkbenchDiagnostic(row, workbench)
  const targetStore = publishStoreAssignments(workbench).get(row.draftId)
  const fieldIssues = workbench.productBases[row.draftId]?.issues
  const requestIdentity = resident && targetStore && lifecycle && resident.card_id === workbench.cardId
    && resident.revision === lifecycle.revision && resident.view_revision === lifecycle.view_revision
    && workbench.productBases[row.draftId]?.target_store_id === (resident.store_id ?? "") ? {
      scope: workbench.scope, mediaEpoch: workbench.mediaEpoch, cardId: resident.card_id, storeId: targetStore,
      rowId: row.draftId, revision: lifecycle.revision, viewRevision: lifecycle.view_revision,
    } : undefined
  const requestEvidence = currentPublishRequestEvidence(row.publishRequestEvidence, requestIdentity)
  const receiptFeedback = row.errorFeedback ?? diagnostic?.errorFeedback
  const feedback = !(lifecycle && ["accepted", "operator_attested"].includes(lifecycle.stage))
    ? receiptFeedback : undefined
  const rowLog = row.publishRequestEvidence && !requestEvidence ? "" : row.log
  const requestBlocked = requestEvidence?.requestCause?.kind === "request_refusal" && lifecycle
    && !["queued", "submitting", "accepted", "outcome_unknown", "operator_attested"].includes(lifecycle.stage)
  const receipt = lifecycle?.submissionReceipt
  const progress = visiblePreparationProgress(row)
  const preparationFailure = progress.find((entry) => entry.state === "failed")
  const tone = preparationFailure || requestBlocked ? "bad" : lifecycle ? workbenchRowTone(lifecycle) : undefined
  const bucket = lifecycle ? bucketOf(lifecycle) : undefined
  // The badge names the fine-grained stage (06 vocabulary); the six prepare
  // buckets only stand in before the first projection arrives.
  const bucketLabel = preparationFailure
    ? "准备失败"
    : requestBlocked ? "发送受阻" : lifecycle
      ? STAGE_LABEL[lifecycle.stage] ?? prepareUiLabel(lifecycle)
      : undefined
  const detail = preparationFailure
    ? { text: preparationFailure.message, fullText: preparationFailure.message }
    : lifecycle && row.readiness && bucket
    ? publishStateDetail(lifecycle, row.readiness, rowLog, bucket === "exceptions", row, fieldIssues)
    : undefined
  const isRunning = row.status === "running" || (tone === "flight" && row.status !== "sent")
  const waitReason = lifecycle && row.readiness ? prepareWaitReason(lifecycle, row.readiness) : undefined
  const statusLabel = [waitReason, detail?.fullText]
    .filter((part): part is string => Boolean(part))
    .filter((part, index, all) => all.indexOf(part) === index)
    .join(" · ")
  // The strip draws the failed leg as a ⚠ that retries it and whose tooltip
  // carries that leg's own words. A sentence saying nothing but 切片失败 would
  // be the error copy the glyph replaced, so the cell drops it — the row's log
  // and any longer reason still travel, on the glyph the operator retries.
  const failedLeg = preparationFailureCopy({
    ai: row.ai ?? "idle",
    render: row.render ?? "idle",
    upload: row.upload ?? "idle",
  })
  const detailRepeatsGlyph = Boolean(failedLeg && !preparationFailure && detail?.text === failedLeg)
  const failureWords = feedback?.summary ?? preparationFailure?.message ?? detail?.fullText
  const receiptOnly = Boolean(receipt) || Boolean(lifecycle && ["accepted", "outcome_unknown", "operator_attested"].includes(lifecycle.stage))
  // The strip's retry glyphs obey the fence `batch-actions.ts` puts on the
  // verbs: a sealed row (accepted / Unknown / attested) or one holding a
  // submission receipt keeps its stage facts but invites no re-preparation the
  // verb would then skip. A retry is a capability, so it needs evidence: a
  // projected lifecycle that is open. `preparationOpen(undefined)` admits a row
  // the batch verbs have not seen yet, but a row with no lifecycle — or whose
  // own Cloud stage is already sealed — stays a passive description.
  const rowStageSealed = Boolean(lifecycle && row.stage && lifecycleSealed({ ...lifecycle, stage: row.stage }))
  const retryAllowed = feedback?.outcome !== "unknown" && !row.publishUnconfirmed && Boolean(lifecycle) && !receiptOnly && !rowStageSealed && preparationOpen(lifecycle)
  const canCancelIntent = lifecycle ? canCancelPublishIntent(lifecycle) : false
  const resolvedRemediation = lifecycle
    ? resolvePublishRemediation({
        lifecycle, readiness: row.readiness, rowLog, localUnconfirmed: row.publishUnconfirmed, tracks: row, psdTemplateFailure: row.psdTemplateFailure,
        hasSource: Boolean(row.source), imageName: row.imageName, brandRepairable: Boolean(onRepairBrand),
        requestEvidence: row.publishRequestEvidence,
        requestIdentity,
        issues: fieldIssues,
      })
    : undefined
  const remediation = resolvedRemediation && diagnostic?.diagnosticId
    ? { ...resolvedRemediation, diagnosticId: diagnostic.diagnosticId, traceId: diagnostic.traceId } : resolvedRemediation
  return (
    <div className="flex min-w-0 flex-col items-start gap-0.5">
      {(row.candidates ?? lifecycle?.ai_candidates ?? []).some((candidate) => candidate.state === "proposed" || candidate.state === "unresolved") ? (
        <Button size="xs" variant="outline" onClick={(event) => { event.stopPropagation(); onReviewCandidates() }}>审阅建议</Button>
      ) : null}
      {receiptOnly ? (
        <>
          {lifecycle ? <PublishSubmissionState lifecycle={lifecycle} rowLog={rowLog} ownsRemediation={false} /> : null}
          <PreparationStepLines row={row} failureWords={failureWords} retryAllowed={retryAllowed} onRetryStage={onRetryStage} />
        </>
      ) : tone && bucketLabel ? (
        <>
          <span className="flex min-w-0 max-w-full flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <span className="flex items-center gap-1.5 whitespace-nowrap">
              <span
                aria-hidden
                className={cn(
                  "size-2.5 shrink-0 rounded-full transition-transform",
                  TONE_SOLID[tone],
                  isRunning && "animate-pulse",
                )}
              />
              <span className={cn("text-compact font-medium", TONE_INK[tone])}>
                {bucketLabel}
              </span>
            </span>
            {canCancelIntent ? (
              <Button
                type="button"
                size="xs"
                variant="outline"
                className="shrink-0 text-meta"
                aria-label={`取消发送 ${row.imageName}`}
                onClick={(event) => {
                  event.stopPropagation()
                  onCancelIntent()
                }}
              >
                取消发送
              </Button>
            ) : null}
          </span>
          {!feedback && detail && !detailRepeatsGlyph && (preparationFailure || requestBlocked || !progress.length || bucket === "exceptions") ? (
            <ClampedTextTooltip text={statusLabel}>
              <p
                className={cn(
                  "line-clamp-2 max-w-full text-meta leading-4",
                  bucket === "exceptions" || requestBlocked ? cn("font-medium", TONE_INK[tone]) : "text-muted-foreground",
                )}
                aria-label={statusLabel}
              >
                {detail.text}
              </p>
            </ClampedTextTooltip>
          ) : null}
          <PreparationStepLines row={row} failureWords={failureWords} retryAllowed={retryAllowed} onRetryStage={onRetryStage} />
        </>
      ) : (
        <span className="text-meta text-muted-foreground">读取中</span>
      )}
      {feedback && !remediation ? <RowErrorFeedback feedback={feedback} unknownOutcome={row.publishUnconfirmed === true || lifecycle?.stage === "outcome_unknown"} /> : null}
      {remediation ? (
        <PublishRemediation
          remediation={remediation}
          feedback={feedback}
          onRepairBrand={onRepairBrand}
          onRetryStage={onRetryStage}
          onReviewCandidates={onReviewCandidates}
        />
      ) : diagnostic?.diagnosticId ? (
        <details onClick={(event) => event.stopPropagation()} onToggle={(event) => { if (event.currentTarget.open) refreshDiagnostic() }}>
          <summary className="cursor-pointer text-meta text-muted-foreground">技术详情</summary>
          <PublishDiagnosticDetails diagnosticId={diagnostic.diagnosticId} traceId={diagnostic.traceId} />
        </details>
      ) : null}
      {rowStoreLabel ? (
        <StoreAssignmentBadge
          tone={storeTone}
          muted
          ariaLabel={`目标店铺：${rowStoreLabel}`}
        >
          {rowStoreLabel}
        </StoreAssignmentBadge>
      ) : null}
    </div>
  )
}
