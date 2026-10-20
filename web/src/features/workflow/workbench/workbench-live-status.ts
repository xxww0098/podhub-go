import { useEffect, useRef, useState } from "react"
import { useScreenActive } from "@/components/screen-pane"
import type { LiveNoticeType } from "@/lib/notify"
import {
  leftoverStageRetries,
  LIVE_STEPS,
  preparationSequenceViews,
  STAGE_STATE_LABEL,
  STAGE_RETRY_LABEL,
  type RowStageTracks,
} from "../prepare/preparation-branches"
import {
  preparationRunning,
  type GuidedPreparation,
  type PreparationActivity,
  type PreparationProgress,
  type PreparationVerb,
} from "../prepare/preparation-tracks"
import type { QueueHaltReason } from "@/bindings/commands"
import type { CardStoreAvailability } from "../store-availability"

export const LIVE_PREPARE = "live:prepare"
export const LIVE_QUEUE = "live:queue"
export const LIVE_STORE = "live:store"
export { LIVE_STEPS }
export const LIVE_BATCH: Record<PreparationVerb, string> = {
  ai: "live:batch-ai",
  render: "live:batch-render",
  deliver: "live:batch-deliver",
}

const LANE_LABEL = {
  ai: "AI 识别",
  render: "切片",
  deliver: "上传校验",
} as const

export type LiveClockKey = "queue" | PreparationVerb

export type LiveStatusClocks = {
  startedAt: Partial<Record<LiveClockKey, number>>
}

export type LiveStatusActionKey =
  | "stop-prepare"
  | "cancel-queue"
  | "resume-queue"
  | "retry-ai"
  | "retry-render"
  | "retry-deliver"
  | "open-stores"
  | "edit-card"

export type LiveStatusCard = {
  id: string
  type: LiveNoticeType
  title: string
  description?: string
  action?: {
    key: LiveStatusActionKey
    label: string
    disabled?: boolean
    rowIds?: string[]
  }
}

/**
 * Typed queue-halt categories projected to operator copy. Each names the next
 * action; the detailed cause stays on the row log — the queue banner never
 * parses it.
 */
export const QUEUE_HALT_REASON_COPY: Record<QueueHaltReason, string> = {
  operator_pause: "操作员已暂停",
  operator_stop: "操作员已停止",
  auth_expired: "登录已失效，请重新登录后继续",
  grant_blocked: "店铺执行授权受阻，请刷新店铺授权",
  store_busy: "店铺正由另一台设备处理，稍后对账并继续",
  reconcile_required: "存在未确认的发布结果，请先对账",
  operator_attested: "存在人工封存的商品，尚未证实上架",
  lease_conflict: "队列状态发生冲突，已安全暂停",
  service_error: "发送服务异常，已安全暂停",
}

export type WorkbenchLiveStatusInput = {
  queueRunning: boolean
  queuePaused: boolean
  queueStopRequested?: boolean
  queueHaltReason?: QueueHaltReason | null
  storeConfigured: boolean
  storeIssue?: CardStoreAvailability["issue"]
  unknownImageName?: string
  progress: PreparationProgress
  guided: GuidedPreparation
  activity: PreparationActivity
  rows: readonly RowStageTracks[]
  retryDisabled: boolean
  prepareStopRequested?: boolean
  nowMs?: number
  clocks?: LiveStatusClocks
}

/** mm:ss wall clock for one active lane. */
export function formatLiveClock(elapsedMs: number): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${seconds.toString().padStart(2, "0")}`
}

/** Elapsed time for the sending queue. */
export function formatLiveElapsed(elapsedMs: number): string {
  return `已运行 ${formatLiveClock(elapsedMs)}`
}

/** Keep a start time only for lanes that are still active. */
export function advanceLiveClocks(
  prev: LiveStatusClocks,
  snapshot: {
    queueRunning: boolean
    progress: PreparationProgress
    nowMs: number
  },
): LiveStatusClocks {
  const startedAt = { ...prev.startedAt }
  if (snapshot.queueRunning) startedAt.queue ??= snapshot.nowMs
  else delete startedAt.queue

  for (const verb of ["ai", "render", "deliver"] as const) {
    const batch = snapshot.progress[verb]
    if (batch?.active) {
      startedAt[verb] = batch.startedAtMs ?? startedAt[verb] ?? snapshot.nowMs
    } else {
      delete startedAt[verb]
    }
  }
  return { startedAt }
}

function joinFacts(parts: Array<string | undefined>): string | undefined {
  const facts = parts.filter((part): part is string => Boolean(part))
  return facts.length ? facts.join(" · ") : undefined
}

/** Pure projection: workbench facts → the status control should show. */
export function workbenchLiveStatus({
  queueRunning,
  queuePaused,
  queueStopRequested = false,
  storeConfigured,
  storeIssue,
  unknownImageName,
  progress,
  guided,
  activity,
  rows,
  retryDisabled,
  prepareStopRequested = false,
  queueHaltReason = null,
  nowMs,
  clocks,
}: WorkbenchLiveStatusInput): LiveStatusCard[] {
  const cards: LiveStatusCard[] = []

  if (queueRunning || queuePaused) {
    const queueStarted = clocks?.startedAt.queue
    const stopping = queueRunning && queueStopRequested
    const pausing = queueRunning && queuePaused && !queueStopRequested
    cards.push({
      id: LIVE_QUEUE,
      type: queueRunning ? "loading" : "unknown",
      title: stopping
        ? "正在停止发送队列"
        : pausing
          ? "正在暂停发送队列"
          : queueRunning
            ? "发送队列进行中"
            : queueStopRequested
              ? "发送队列已停止"
              : "发送队列已暂停",
      description: queueRunning
        ? stopping
          ? "正在取消未执行的 Cloud Intent；已经派发的批次会先结算"
          : pausing
            ? "已经派发的批次结算后暂停，不再派发下一批"
            : joinFacts([
                "锁定导入与准备，未派发的行仍可改字段",
                queueStarted != null && nowMs != null
                  ? formatLiveElapsed(nowMs - queueStarted)
                  : undefined,
              ])
        : joinFacts([
            queueHaltReason ? QUEUE_HALT_REASON_COPY[queueHaltReason] : undefined,
            unknownImageName
              ? `${unknownImageName} 还没有确定回执`
              : // An operator's own pause/stop needs no reconciliation to resume.
                queueHaltReason === "operator_pause" || queueHaltReason === "operator_stop"
                ? undefined
                : "对账后才会解锁",
          ]),
      action: stopping
        ? undefined
        : queueRunning
        ? { key: "cancel-queue", label: "停止后续发送" }
        : { key: "resume-queue", label: "对账并继续" },
    })
  } else if (!storeConfigured) {
    cards.push({
      id: LIVE_STORE,
      type: "error",
      title: storeIssue?.title ?? "店铺不可用",
      description: storeIssue?.description ?? "请到「店铺」检查当前 Workspace 的店铺状态",
      action: storeIssue
        ? { key: storeIssue.action, label: storeIssue.actionLabel }
        : undefined,
    })
  }

  const activeLanes = (["ai", "render", "deliver"] as const).filter(
    (verb) => progress[verb]?.active,
  )
  const retainedActivity = preparationRunning(activity)
  const running = guided.active || activeLanes.length > 0 || retainedActivity
  const stopping = guided.stopRequested || prepareStopRequested

  if (running || guided.stopMessage) {
    const description = joinFacts([
      running && !guided.active && !activeLanes.length
        ? "准备任务仍在运行，可停止后续准备"
        : undefined,
      stopping && running ? "停止已生效" : undefined,
      guided.stopMessage,
    ])
    cards.push({
      id: LIVE_PREPARE,
      type: guided.stopFailed ? "error" : running ? "loading" : "info",
      title: guided.active
        ? "一键准备"
        : running
          ? "准备进行中"
          : guided.stopFailed
            ? "停止准备失败"
            : "准备已停止",
      ...(description ? { description } : {}),
      action:
        running || guided.stopFailed
          ? {
              key: "stop-prepare",
              label: stopping ? "重试停止" : "停止后续准备",
            }
          : undefined,
    })
  }

  if (running) {
    const stageRows = guided.active
      ? rows.filter((row) => guided.rowIds.includes(row.id))
      : rows
    const steps = preparationSequenceViews(stageRows, activity, progress, guided.active)
    cards.push({
      id: LIVE_STEPS,
      type: steps.some((step) => step.state === "failed")
        ? "error"
        : steps.some((step) => step.state === "running")
          ? "loading"
          : "info",
      title: "识别 → 切片 → 上传",
      description: steps
        .map((step) => `${step.title} ${STAGE_STATE_LABEL[step.state]}`)
        .join(" · "),
    })
  }

  const leftovers = leftoverStageRetries(rows, progress)
  for (const verb of ["ai", "render", "deliver"] as const) {
    const batch = progress[verb]
    const remapped = leftovers[verb]
    const fromThisBatch =
      batch && !batch.active && batch.total > 0
        ? Math.max(0, batch.total - batch.settled)
        : 0
    // Leftover retry is only the remapped failed track. Trackless ids must not
    // mint a verb-branded「重试上传」card off the guided deliver opener.
    if (!remapped.length) {
      if (!fromThisBatch) continue
      cards.push({
        id: LIVE_BATCH[verb],
        type: "unknown",
        title: `${verb === "deliver" ? "上传" : LANE_LABEL[verb]}：${fromThisBatch} 未结算`,
      })
      continue
    }
    cards.push({
      id: LIVE_BATCH[verb],
      type: "error",
      title: `${verb === "deliver" ? "上传" : LANE_LABEL[verb]}：${remapped.length} 失败`,
      action: {
        key: verb === "ai" ? "retry-ai" : verb === "render" ? "retry-render" : "retry-deliver",
        label: `${STAGE_RETRY_LABEL[verb]}（${remapped.length}）`,
        disabled: retryDisabled,
        rowIds: remapped,
      },
    })
  }

  return cards
}

type LiveStatusActions = {
  onStopPreparation: () => void
  onCancelQueue: () => void
  onResumeQueue: () => void
  onRetryAi: (rowIds: string[]) => void
  onRetryRender: (rowIds: string[]) => void
  onRetryDeliver: (rowIds: string[]) => void
  onOpenStores: () => void
  onEditCard: () => void
}

export type WorkbenchStatusCard = Omit<LiveStatusCard, "action"> & {
  action?: NonNullable<LiveStatusCard["action"]> & { onClick: () => void }
}

export function useWorkbenchLiveStatus(
  input: WorkbenchLiveStatusInput & LiveStatusActions,
): WorkbenchStatusCard[] {
  const screenActive = useScreenActive()
  const clockRunning = input.queueRunning ||
    (["ai", "render", "deliver"] as const).some((verb) => input.progress[verb]?.active)
  const [, setTick] = useState(0)
  const clocksRef = useRef<LiveStatusClocks>({ startedAt: {} })
  const nowMs = Date.now()
  clocksRef.current = advanceLiveClocks(clocksRef.current, {
    queueRunning: input.queueRunning,
    progress: input.progress,
    nowMs,
  })
  const cards = workbenchLiveStatus({
    ...input,
    nowMs,
    clocks: clocksRef.current,
  })
  const actionsRef = useRef<LiveStatusActions>(input)
  actionsRef.current = input

  useEffect(() => {
    if (!clockRunning || !screenActive) return
    const tick = window.setInterval(() => setTick((n) => n + 1), 1_000)
    return () => window.clearInterval(tick)
  }, [clockRunning, screenActive])

  if (!screenActive) return []
  return cards.map((card) => {
    const action = card.action
    return {
      ...card,
      action: action
        ? {
            ...action,
            onClick: () => runLiveAction(actionsRef.current, action),
          }
        : undefined,
    }
  })
}

function runLiveAction(
  actions: LiveStatusActions,
  action: NonNullable<LiveStatusCard["action"]>,
) {
  switch (action.key) {
    case "stop-prepare":
      actions.onStopPreparation()
      break
    case "cancel-queue":
      actions.onCancelQueue()
      break
    case "resume-queue":
      actions.onResumeQueue()
      break
    case "retry-ai":
      actions.onRetryAi(action.rowIds ?? [])
      break
    case "retry-render":
      actions.onRetryRender(action.rowIds ?? [])
      break
    case "retry-deliver":
      actions.onRetryDeliver(action.rowIds ?? [])
      break
    case "open-stores":
      actions.onOpenStores()
      break
    case "edit-card":
      actions.onEditCard()
      break
  }
}
