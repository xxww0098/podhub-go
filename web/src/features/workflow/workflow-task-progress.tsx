import { CirclePause, LoaderCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { PipelineRowStatus } from "./prepare/pipeline-machine"

export type WorkflowTaskProgressView = {
  cardName: string
  completed: number
  total: number
  issues: number
  state: "running" | "paused"
}

export function sameWorkflowTaskProgress(
  left: WorkflowTaskProgressView | null,
  right: WorkflowTaskProgressView | null,
): boolean {
  if (left === right) return true
  if (!left || !right) return false
  return (
    left.cardName === right.cardName &&
    left.completed === right.completed &&
    left.total === right.total &&
    left.issues === right.issues &&
    left.state === right.state
  )
}

type WorkflowTaskProgressInput = {
  cardName: string
  frozenDraftIds: readonly string[]
  paused: boolean
  rows: readonly {
    draftId: string
    status: PipelineRowStatus
  }[]
  running: boolean
}

/**
 * Projects the live queue into the one compact fact needed outside 上架.
 * The durable queue and Product Instance lifecycle remain Cloud authority; this
 * view only counts settled rows from the frozen generation already on screen.
 */
export function workflowTaskProgressView({
  cardName,
  frozenDraftIds,
  paused,
  rows,
  running,
}: WorkflowTaskProgressInput): WorkflowTaskProgressView | null {
  if ((!running && !paused) || frozenDraftIds.length === 0) return null

  const frozen = new Set(frozenDraftIds)
  const settledRows = rows.filter(
    (row) =>
      frozen.has(row.draftId) &&
      (row.status === "sent" || row.status === "failed"),
  )

  return {
    cardName: cardName.trim() || "上架任务",
    completed: settledRows.length,
    total: frozenDraftIds.length,
    issues: settledRows.filter((row) => row.status === "failed").length,
    state: paused ? "paused" : "running",
  }
}

export function WorkflowTaskProgress({
  progress,
  onOpen,
}: {
  progress: WorkflowTaskProgressView
  onOpen: () => void
}) {
  const paused = progress.state === "paused"
  const label = paused ? "上架已暂停" : "正在上架"
  const percentage = Math.min(
    100,
    Math.round((progress.completed / Math.max(progress.total, 1)) * 100),
  )
  const issueLabel = progress.issues > 0 ? `，${progress.issues} 件需处理` : ""

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={onOpen}
      aria-label={`返回上架：${label}，已完成 ${progress.completed}/${progress.total}${issueLabel}`}
      className="relative min-w-0 max-w-72 gap-2 overflow-hidden pr-3"
    >
      {paused ? (
        <CirclePause className="size-3.5 text-st-unknown-ink" aria-hidden />
      ) : (
        <LoaderCircle
          className="size-3.5 animate-spin text-st-flight-ink"
          aria-hidden
        />
      )}
      <span className="hidden max-w-32 truncate text-muted-foreground md:inline">
        {progress.cardName}
      </span>
      <span className="font-medium">{label}</span>
      <span className="font-mono text-xs tabular-nums text-muted-foreground" aria-live="polite">
        {progress.completed}/{progress.total}
      </span>
      <span className="absolute inset-x-0 bottom-0 h-0.5 bg-muted" aria-hidden>
        <span
          className={paused ? "block h-full bg-st-unknown" : "block h-full bg-st-flight"}
          style={{ width: `${percentage}%` }}
        />
      </span>
    </Button>
  )
}
