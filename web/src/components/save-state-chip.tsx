import { RotateCcw } from "lucide-react"

import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { TONE_CHIP, TONE_SOLID, type StateTone } from "@/lib/receipt-state"
import { cn } from "@/lib/utils"

export type SaveState = "idle" | "dirty" | "saving" | "saved" | "error"

const SAVE_STATE_PRESENTATION: Record<
  Exclude<SaveState, "idle">,
  { label: string; tone: StateTone; title: string }
> = {
  dirty: {
    label: "有未保存更改",
    tone: "flight",
    title: "更改仍在当前窗口中，尚未保存",
  },
  saving: {
    label: "正在保存…",
    tone: "flight",
    title: "正在保存当前更改",
  },
  saved: {
    label: "已保存到云端",
    tone: "good",
    title: "当前更改已完成保存",
  },
  error: {
    label: "保存失败",
    tone: "bad",
    title: "当前更改尚未保存，可重试",
  },
}

/**
 * One live signal: what the Draft editor is doing with the operator's input.
 *
 * The dot becomes a spinner while the write is in flight and settles into its
 * durable tone with one tight pulse when the Draft lands — the rail's arrival
 * ring at chip scale. The chip stays mounted across dirty → saving → saved so
 * the pulse is an event, never a remount replay. `save-state-enter` fires once
 * on mount only; the className is stable thereafter.
 */
export function SaveStateChip({
  state,
  onRetry,
}: {
  state: Exclude<SaveState, "idle">
  onRetry?: () => void
}) {
  const { label, tone, title } = SAVE_STATE_PRESENTATION[state]
  return (
    <span
      role="status"
      aria-live="polite"
      title={title}
      data-tone={tone}
      className={cn(
        "inline-flex h-5.5 w-fit shrink-0 items-center gap-1.5 rounded-full border px-2 text-meta leading-none font-medium whitespace-nowrap transition-colors duration-200 ease-settle save-state-enter",
        TONE_CHIP[tone]
      )}
    >
      {state === "saving" ? (
        <Spinner className="size-3 text-st-flight-ink" />
      ) : (
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full transition-colors duration-200 ease-settle",
            TONE_SOLID[tone],
            state === "saved" && "save-dot-confirm",
            state === "error" && "save-dot-error"
          )}
        />
      )}
      {label}
      {state === "error" && onRetry ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="重试"
                className="-my-1 ml-0.5 grid size-5 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={onRetry}
              />
            }
          >
            <RotateCcw className="size-3" aria-hidden />
          </TooltipTrigger>
          <TooltipContent>重试</TooltipContent>
        </Tooltip>
      ) : null}
    </span>
  )
}
