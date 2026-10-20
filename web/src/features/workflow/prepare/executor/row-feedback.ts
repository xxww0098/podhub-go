/** Transient row feedback: monotonic state timestamps and detached snapshots, never stored facts. */
import type { WorkflowPreparationProgress } from "@/bindings/commands"
import { type DiagFields } from "@/lib/diag-log"
import { JOB_AI, JOB_RENDER, logStage, type PreparationVerb } from "../execution-context"

/** The progress stage a job kind reports under. */
export function feedbackStageOf(kind: string): WorkflowPreparationProgress["stage"] {
  return kind === JOB_AI ? "ai" : kind === JOB_RENDER ? "render" : "upload"
}

/**
 * How long the rail tells the user it is waiting.
 *
 * A cooldown can reach an hour: the AI relay's unbilled ceiling answers 429
 * with the seconds until it lifts, and the preparation rail waits it out
 * (PREPARATION_BUSY_RETRY). Past a couple of minutes the seconds stop being
 * readable — "60 分钟" says what "3600 秒" does not.
 */
export function waitLabel(delayMs: number): string {
  const seconds = Math.max(1, Math.ceil(delayMs / 1000))
  return seconds < 120 ? `${seconds} 秒` : `${Math.ceil(seconds / 60)} 分钟`
}

export function createRowFeedback(rowId: string, verb: PreparationVerb, onChange: (progress: WorkflowPreparationProgress[]) => void) {
  const progress = new Map<WorkflowPreparationProgress["stage"], WorkflowPreparationProgress>()
  const progressStages: WorkflowPreparationProgress["stage"][] = [
    "plan",
    ...(verb === "prepare" || verb === "recognize" ? ["ai" as const] : []),
    ...(verb === "prepare" || verb === "slice" ? ["render" as const] : []),
    ...(verb === "prepare" || verb === "upload" ? ["upload" as const] : []),
  ]
  const runSince = Date.now()
  for (const stage of progressStages) progress.set(stage, {
    stage,
    state: "waiting",
    message: stage === "plan" ? "等待准备计划" : "等待阶段执行",
    since_ms: runSince,
  })
  const snapshot = () => [...progress.values()].map(item => ({ ...item }))
  const setProgress = (stage: WorkflowPreparationProgress["stage"], state: WorkflowPreparationProgress["state"], message: string, fields: DiagFields = {}): boolean => {
    const previous = progress.get(stage)
    if (previous?.state === state && previous.message === message) return false
    const next = { stage, state, message, since_ms: previous?.state === state ? previous.since_ms : Date.now() } satisfies WorkflowPreparationProgress
    progress.set(stage, next)
    logStage("progress", rowId, { stage, state, message, since_ms: next.since_ms, ...fields })
    onChange(snapshot())
    return true
  }
  const clearProgress = (stage: WorkflowPreparationProgress["stage"]) => {
    if (!progress.delete(stage)) return
    onChange(snapshot())
  }
  return { snapshot, set: setProgress, clear: clearProgress }
}
