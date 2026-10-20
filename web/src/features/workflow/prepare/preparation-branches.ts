import type { WorkflowPreparationProgress } from "@/bindings/commands"
import type { TrackStatus } from "./pipeline-machine"
import type {
  PreparationActivity,
  PreparationProgress,
  PreparationVerb,
} from "./preparation-tracks"

export const LIVE_STEPS = "live:steps"

export const STAGE_RETRY_LABEL: Record<PreparationVerb, string> = {
  ai: "重试识别",
  render: "重试切片",
  deliver: "重试上传",
}

export const STAGE_LABEL: Record<PreparationVerb, string> = {
  ai: "识别",
  render: "切片",
  deliver: "上传",
}

export const STAGE_STATE_LABEL: Record<TrackStatus, string> = {
  idle: "未开始",
  running: "进行中",
  done: "已完成",
  failed: "失败",
}

/** The two states whose glyph is also a retry entry. Idle owes nothing yet; running is owned by a batch. */
export function preparationStepRetryable(state: TrackStatus): boolean {
  return state === "done" || state === "failed"
}

/**
 * The one line a step's glyph carries. The strip prints no state text of its
 * own, so this tooltip is where the operator reads the state, the failing leg's
 * own words, and what a click does — including the guard that makes Cloud
 * refuse a completed step until 清空生成内容.
 */
export function preparationStepHint(
  step: Pick<PreparationStepView, "verb" | "title" | "state">,
  reason?: string,
): string {
  const state = `${step.title}：${STAGE_STATE_LABEL[step.state]}`
  if (!preparationStepRetryable(step.state)) return state
  const words = reason?.trim() ? ` · ${reason.trim()}` : ""
  const guard = step.state === "done" ? "（Cloud 已确认完成时需先清空生成内容）" : ""
  return `${state}${words}；点击${STAGE_RETRY_LABEL[step.verb]}${guard}`
}

export type RowStageTracks = {
  id: string
  ai?: TrackStatus
  render?: TrackStatus
  upload?: TrackStatus
  preparationPlan?: WorkflowPreparationProgress
  preparationAi?: WorkflowPreparationProgress
  preparationRender?: WorkflowPreparationProgress
  preparationUpload?: WorkflowPreparationProgress
}

/** A newer completed server track wins over an old browser progress message. */
export function visiblePreparationProgress(row: RowStageTracks): WorkflowPreparationProgress[] {
  return [
    row.ai === "done" && row.render === "done" && row.upload === "done" ? undefined : row.preparationPlan,
    row.ai === "done" ? undefined : row.preparationAi,
    row.render === "done" ? undefined : row.preparationRender,
    row.upload === "done" ? undefined : row.preparationUpload,
  ].filter((entry): entry is WorkflowPreparationProgress => Boolean(entry))
}

export type BranchRetry = {
  verb: PreparationVerb
  label: string
}

export type PreparationStepView = {
  verb: PreparationVerb
  title: string
  state: TrackStatus
  retry?: BranchRetry
}

/**
 * Present the durable tracks as one pipeline. Render and delivery are
 * independent of recognition once the row has rendered media; Cloud remains
 * the final fence for a delivery that lacks its durable evidence.
 */
export function preparationStepViews(row: RowStageTracks): PreparationStepView[] {
  const failedStages = new Set(visiblePreparationProgress(row)
    .filter((entry) => entry.state === "failed").map((entry) => entry.stage))
  const ai = failedStages.has("ai") ? "failed" : row.ai ?? "idle"
  const render = failedStages.has("render") ? "failed" : row.render ?? "idle"
  const upload = render === "done" ? failedStages.has("upload") ? "failed" : row.upload ?? "idle" : "idle"
  const states: Array<[PreparationVerb, TrackStatus]> = [
    ["ai", ai],
    ["render", render],
    ["deliver", upload],
  ]
  const failed = states.find(([, state]) => state === "failed")?.[0]
  return states.map(([verb, state]) => ({
    verb,
    title: STAGE_LABEL[verb],
    state,
    retry:
      verb === failed
        ? { verb, label: STAGE_RETRY_LABEL[verb] }
        : undefined,
  }))
}

/** One four-state summary for each step in a batch or toolbar scope. */
export function preparationSequenceViews(
  rows: readonly RowStageTracks[],
  activity?: PreparationActivity,
  progress?: PreparationProgress,
  forceCurrentRunning = false,
): PreparationStepView[] {
  const byRow = rows.map(preparationStepViews)
  const steps = (["ai", "render", "deliver"] as const).map((verb, index) => {
    const active = Boolean(progress?.[verb]?.active || activity?.[verb].size)
    const states = byRow.map((steps) => steps[index]!.state)
    const prerequisitesReady = verb !== "deliver" || (rows.length > 0 && byRow.every((row) =>
      row[1]!.state === "done",
    ))
    const state: TrackStatus = !prerequisitesReady
      ? "idle"
      : active || states.includes("running")
      ? "running"
      : states.includes("failed")
        ? "failed"
        : states.length > 0 && states.every((value) => value === "done")
          ? "done"
          : "idle"
    const failedIds = state === "failed"
      ? rows.filter((_, rowIndex) => byRow[rowIndex]![index]!.state === "failed").map((row) => row.id)
      : []
    return {
      verb,
      title: STAGE_LABEL[verb],
      state,
      retry: failedIds.length
        ? { verb, label: STAGE_RETRY_LABEL[verb] }
        : undefined,
    }
  })
  if (forceCurrentRunning) {
    const current = steps.findIndex((step, index) =>
      step.state === "idle" && steps.slice(0, index).every((previous) => previous.state === "done"),
    )
    if (current >= 0) steps[current] = { ...steps[current]!, state: "running" }
  }
  return steps
}

/** Strict order means one row can expose at most one failed-step retry. */
export function failedStageRetries(row: RowStageTracks): BranchRetry[] {
  const retry = preparationStepViews(row).find((step) => step.retry)?.retry
  return retry ? [retry] : []
}

/** Media-cell remediation keeps the exact failed media step. */
export function mediaRetry(
  render: TrackStatus | undefined,
  upload: TrackStatus | undefined,
): BranchRetry | undefined {
  if (render === "failed") return { verb: "render", label: STAGE_RETRY_LABEL.render }
  if (render === "done" && upload === "failed") {
    return { verb: "deliver", label: STAGE_RETRY_LABEL.deliver }
  }
  return undefined
}

export function remapFailedStages(
  rows: readonly RowStageTracks[],
  failedRowIds: readonly string[],
): Record<PreparationVerb, string[]> {
  const out: Record<PreparationVerb, string[]> = { ai: [], render: [], deliver: [] }
  const wanted = new Set(failedRowIds)
  for (const row of rows) {
    if (!wanted.has(row.id)) continue
    for (const retry of failedStageRetries(row)) out[retry.verb].push(row.id)
  }
  return out
}

/** Merge settled batch failures into one current-step retry list. */
export function leftoverStageRetries(
  rows: readonly RowStageTracks[],
  batches: Partial<Record<PreparationVerb, { active?: boolean; failedRowIds?: readonly string[] } | undefined>>,
): Record<PreparationVerb, string[]> {
  const out: Record<PreparationVerb, string[]> = { ai: [], render: [], deliver: [] }
  const seen: Record<PreparationVerb, Set<string>> = {
    ai: new Set(),
    render: new Set(),
    deliver: new Set(),
  }
  for (const verb of ["ai", "render", "deliver"] as const) {
    const batch = batches[verb]
    if (!batch || batch.active || !batch.failedRowIds?.length) continue
    const remapped = remapFailedStages(rows, batch.failedRowIds)
    for (const stage of ["ai", "render", "deliver"] as const) {
      for (const id of remapped[stage]) {
        if (seen[stage].has(id)) continue
        seen[stage].add(id)
        out[stage].push(id)
      }
    }
  }
  return out
}
