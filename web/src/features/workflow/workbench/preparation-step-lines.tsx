import { ChevronRight } from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { TONE_INK } from "@/lib/receipt-state"
import { cn } from "@/lib/utils"
import type { ListingRow } from "../model/listing-row"
import {
  preparationStepHint,
  preparationStepRetryable,
  preparationStepViews,
  STAGE_RETRY_LABEL,
  STAGE_STATE_LABEL,
  visiblePreparationProgress,
} from "../prepare/preparation-branches"
import type { PreparationVerb } from "../prepare/preparation-tracks"
import {
  PREPARE_STEP_STAGE,
  PREPARE_STEP_TONE,
  PreparationStepGlyph,
  RetryGlyphButton,
} from "./preparation-step-glyph"

export function PreparationStepLines({
  row,
  failureWords,
  retryAllowed,
  onRetryStage,
}: {
  row: ListingRow
  failureWords?: string
  /**
   * Whether this row may be prepared again at all. The publish cell derives it
   * from the same `preparationOpen` fence the batch verbs apply.
   */
  retryAllowed: boolean
  onRetryStage: (verb: PreparationVerb) => void
}) {
  if (row.status === "sent" || row.status === "ready") return null
  // The failing leg's own browser words win over the row log: they were written
  // where that leg failed, and the glyph under the pointer is that leg's.
  const progressWords = new Map(
    visiblePreparationProgress(row)
      .filter((entry) => entry.state === "failed" && entry.message.trim())
      .map((entry) => [entry.stage, entry.message.trim()]),
  )
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1" aria-label="准备流程：识别 → 切片 → 上传">
      {preparationStepViews(row).map((step, index) => (
        <PreparationStepLine
          key={step.verb}
          step={step}
          separator={index > 0}
          reason={
            (step.state === "failed" ? row.errorFeedback?.summary : undefined) ??
            progressWords.get(PREPARE_STEP_STAGE[step.verb]) ??
            (step.state === "failed" ? failureWords : undefined)
          }
          retryAllowed={retryAllowed}
          onRetryStage={onRetryStage}
        />
      ))}
    </div>
  )
}

function PreparationStepLine({
  step,
  separator,
  reason,
  retryAllowed,
  onRetryStage,
}: {
  step: ReturnType<typeof preparationStepViews>[number]
  separator: boolean
  reason?: string
  retryAllowed: boolean
  onRetryStage: (verb: PreparationVerb) => void
}) {
  const tone =
    step.state === "idle"
      ? "text-muted-foreground/60"
      : TONE_INK[PREPARE_STEP_TONE[step.state]]
  // Done and failed are the two states an operator can act on: the glyph the
  // step is already read by becomes its retry. Idle has nothing to repeat yet,
  // and running is owned by a batch, so both keep the passive stage icon. A
  // sealed or receipt-holding row keeps every glyph passive: the verb it would
  // invite skips that row, so a retry control there could only mislead.
  const retryable = retryAllowed && preparationStepRetryable(step.state)
  // Every word this strip would otherwise print stands here instead: the state,
  // the failing leg's own reason, and what the click does — or, fenced, only
  // the state and the reason, with no click to offer.
  const hint = retryAllowed
    ? preparationStepHint(step, reason)
    : [`${step.title}：${STAGE_STATE_LABEL[step.state]}`, reason?.trim()]
        .filter(Boolean)
        .join(" · ")
  return (
    <span className="inline-flex min-w-0 items-center gap-1" data-preparation-step={step.verb} data-state={step.state}>
      {separator ? (
        <ChevronRight aria-hidden className="size-3 shrink-0 text-muted-foreground/40" />
      ) : null}
      {retryable ? (
        <RetryGlyphButton
          label={`${step.title}：${STAGE_STATE_LABEL[step.state]}，${STAGE_RETRY_LABEL[step.verb]}`}
          tooltip={hint}
          className={tone}
          onRetry={() => onRetryStage(step.verb)}
        >
          <PreparationStepGlyph verb={step.verb} state={step.state} />
        </RetryGlyphButton>
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                aria-label={hint}
                className={cn(
                  "inline-flex size-5 items-center justify-center [&_svg:not([class*='size-'])]:size-3.5",
                  tone,
                )}
              />
            }
          >
            <PreparationStepGlyph verb={step.verb} state={step.state} />
          </TooltipTrigger>
          <TooltipContent>{hint}</TooltipContent>
        </Tooltip>
      )}
    </span>
  )
}
