import type { ReactNode } from "react"
import {
  Check,
  CircleAlert,
  LoaderCircle,
  RefreshCw,
  ScanText,
  Scissors,
  Upload,
} from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { StateTone } from "@/lib/receipt-state"
import { cn } from "@/lib/utils"
import type { STAGE_STATE_LABEL } from "../prepare/preparation-branches"
import type { PreparationVerb } from "../prepare/preparation-tracks"

const PREPARE_STEP_ICON = {
  ai: ScanText,
  render: Scissors,
  deliver: Upload,
} as const
/** Browser progress names delivery `upload`; its toolbar verb is `deliver`. */
export const PREPARE_STEP_STAGE: Record<PreparationVerb, "ai" | "render" | "upload"> = {
  ai: "ai",
  render: "render",
  deliver: "upload",
}
export const PREPARE_STEP_TONE: Record<keyof typeof STAGE_STATE_LABEL, StateTone> = {
  idle: "idle",
  running: "flight",
  done: "good",
  failed: "bad",
}

export function PreparationStepGlyph({
  verb,
  state,
}: {
  verb: PreparationVerb
  state: keyof typeof STAGE_STATE_LABEL
}) {
  if (state === "running") return <LoaderCircle aria-hidden className="animate-spin" />
  if (state === "done") return <Check aria-hidden />
  if (state === "failed") return <CircleAlert aria-hidden />
  const Icon = PREPARE_STEP_ICON[verb]
  return <Icon aria-hidden />
}

/**
 * One state glyph that is also its step's retry entry: the pointer swaps the
 * check or the exclamation for a spinning refresh, so a row never grows a text
 * 「重试切片」 button and every step keeps its own remediation. Keyboard focus
 * duplicates the swap — a hover-only affordance stays named but unexplained for
 * anyone tabbing through the strip.
 */
export function RetryGlyphButton({
  label,
  tooltip,
  className,
  onRetry,
  children,
}: {
  label: string
  tooltip: string
  className?: string
  onRetry: () => void
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            className={cn(
              "group/step-retry inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [&_svg:not([class*='size-'])]:size-3.5",
              className,
            )}
            onClick={(event) => {
              event.stopPropagation()
              onRetry()
            }}
          />
        }
      >
        <span className="inline-flex group-hover/step-retry:hidden group-focus-visible/step-retry:hidden">
          {children}
        </span>
        <RefreshCw
          aria-hidden
          className="hidden size-3.5 animate-spin group-hover/step-retry:block group-focus-visible/step-retry:block"
        />
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}
