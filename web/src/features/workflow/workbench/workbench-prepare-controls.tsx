import { Fragment } from "react"
import { Eraser, LoaderCircle, Square, WandSparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { TONE_INK } from "@/lib/receipt-state"
import { cn } from "@/lib/utils"
import type { ListingRow } from "../model/listing-row"
import {
  failedStageRetries,
  preparationSequenceViews,
  STAGE_STATE_LABEL,
} from "../prepare/preparation-branches"
import type {
  GuidedPreparation,
  PreparationActivity,
  PreparationProgress,
  PreparationVerb,
} from "../prepare/preparation-tracks"
import { PREPARE_STEP_TONE, PreparationStepGlyph } from "./preparation-step-glyph"
import { RIBBON_BUTTON } from "./workbench-ribbon-classes"

/** The ordinary path runs 识别 → 切片 → 上传 behind one confirmation. */
export function GuidedPrepareButton({
  count,
  selected,
  guided,
  activity,
  disabled,
  onClick,
  onStop,
}: {
  count: number
  selected: boolean
  guided: GuidedPreparation
  activity: PreparationActivity
  disabled: boolean
  onClick: () => void
  onStop: () => void
}) {
  const idleLabel = selected ? "准备选中" : "一键准备"
  const activeCount = new Set([...activity.ai, ...activity.render, ...activity.deliver]).size
  const running = guided.active || activeCount > 0
  const stopping = running && guided.stopRequested
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant={running ? "destructive" : count > 0 && !disabled ? "brand" : "outline"}
            size="sm"
            className={cn(
              RIBBON_BUTTON,
              count > 0 && !running && !disabled && "shadow-xs font-semibold",
            )}
            disabled={running ? stopping : disabled || !count}
            focusableWhenDisabled
            aria-busy={stopping}
            aria-label={
              running
                ? stopping
                  ? "正在停止准备"
                  : `停止准备（${guided.active ? guided.total : activeCount}）`
                : `${idleLabel}（${count}）`
            }
            onClick={running ? onStop : onClick}
          >
            {stopping ? (
              <LoaderCircle aria-hidden className="animate-spin" />
            ) : running ? (
              <Square aria-hidden />
            ) : (
              <WandSparkles aria-hidden />
            )}
            <span className="tabular-nums">
              {running ? (guided.active ? guided.total : activeCount) : count}
            </span>
          </Button>
        }
      />
      <TooltipContent>
        {running
          ? "立即停止后续步骤；已发出的请求仍会结算"
          : count === 0
            ? "导入商品图片后，一键自动执行 AI 识别、切片并上传"
            : "按识别 → 切片 → 上传补齐未完成步骤；已完成切片自动跳过，发送另确认"}
      </TooltipContent>
    </Tooltip>
  )
}

/** Recognition, slicing, and delivery of rendered media can run independently. */
export function PreparationStepSequence({
  disabled,
  rows,
  activity,
  progress,
  aiTargets,
  renderTargets,
  deliverTargets,
  onRunAiRows,
  onRunRenderRows,
  onRunDeliverRows,
  clearCount,
  clearDisabled,
  onClear,
}: {
  disabled: boolean
  rows: ListingRow[]
  activity: PreparationActivity
  progress: PreparationProgress
  aiTargets: ListingRow[]
  renderTargets: ListingRow[]
  deliverTargets: ListingRow[]
  onRunAiRows: (rowIds: string[]) => void
  onRunRenderRows: (rowIds: string[]) => void
  onRunDeliverRows: (rowIds: string[]) => void
  clearCount: number
  clearDisabled: boolean
  onClear: () => void
}) {
  const run = {
    ai: onRunAiRows,
    render: onRunRenderRows,
    deliver: onRunDeliverRows,
  }
  const independentTargets: Partial<Record<PreparationVerb, ListingRow[]>> = {
    ai: aiTargets,
    render: renderTargets,
    deliver: deliverTargets,
  }
  const steps = preparationSequenceViews(rows, activity, progress)

  return (
    <>
      {steps.map((step) => {
        const independent = independentTargets[step.verb]
        const targetIds = independent
          ? independent.map((row) => row.id)
          : step.retry
            ? rows.filter((row) => failedStageRetries(row)[0]?.verb === step.verb).map((row) => row.id)
            : []
        const label = `${step.title}：${STAGE_STATE_LABEL[step.state]}`
        const actionLabel = independent ? step.title : step.retry?.label
        const tone = PREPARE_STEP_TONE[step.state]
        return (
          <Fragment key={step.verb}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className={TONE_INK[tone]}
                    disabled={disabled || !targetIds.length}
                    focusableWhenDisabled={Boolean(targetIds.length)}
                    aria-label={actionLabel && targetIds.length ? `${actionLabel}（${targetIds.length}）` : label}
                    data-preparation-step={step.verb}
                    data-state={step.state}
                    onClick={() => run[step.verb](targetIds)}
                  >
                    <PreparationStepGlyph verb={step.verb} state={step.state} />
                  </Button>
                }
              />
              <TooltipContent>
                {independent
                  ? `可单独${step.title}；一键准备会跳过已完成的${step.title}`
                  : step.retry
                    ? step.retry.label
                    : label}
              </TooltipContent>
            </Tooltip>
          </Fragment>
        )
      })}
      <ClearGeneratedContentButton
        count={clearCount}
        disabled={clearDisabled}
        onClick={onClear}
      />
    </>
  )
}

function ClearGeneratedContentButton({
  count,
  disabled,
  onClick,
}: {
  count: number
  disabled: boolean
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={RIBBON_BUTTON}
            disabled={disabled || count === 0}
            onClick={onClick}
            focusableWhenDisabled
            aria-label={`清空生成内容（${count}）`}
          >
            <Eraser aria-hidden />
            <span className="tabular-nums">清空 {count}</span>
          </Button>
        }
      />
      <TooltipContent>
        {count
          ? "清空货号/型号以外的全部字段内容、切片和上传结果；保留原图、店铺和视频，可重新生成"
          : "暂无可清空的行：生成内容尚未产出，或仍在识别、切片、上传中"}
      </TooltipContent>
    </Tooltip>
  )
}
