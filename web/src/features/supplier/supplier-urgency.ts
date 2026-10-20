/**
 * 排单加急：逾期、12 小时内截止，或卖家催过，都排到本组最前。
 * 已发货不再加急。倒计时只改文字，不做循环动画。
 */

import { useEffect, useState } from "react"

const HOUR_MS = 60 * 60 * 1000
export const URGENT_WINDOW_MS = 12 * HOUR_MS
export const NUDGE_COOLDOWN_MS = 30 * 60 * 1000

export type DeadlineRow = {
  state: string
  deadline?: string | null
  nudgeCount?: number
}

/** 只有日期的截止算到当天 23:59:59Z；带时间的按原值。 */
export function deadlineInstant(deadline: string | null | undefined): number | null {
  if (!deadline) return null
  const parsed = deadline.includes("T")
    ? Date.parse(deadline)
    : Date.parse(deadline + "T23:59:59Z")
  return Number.isNaN(parsed) ? null : parsed
}

export function isUrgent(row: DeadlineRow, now: number): boolean {
  if (row.state === "shipped" || row.state === "rejected" || row.state === "cancelled") {
    return false
  }
  if ((row.nudgeCount ?? 0) > 0) return true
  const due = deadlineInstant(row.deadline)
  if (due == null) return false
  return due - now <= URGENT_WINDOW_MS
}

export function countdownLabel(
  deadline: string | null | undefined,
  now: number,
): string | null {
  const due = deadlineInstant(deadline)
  if (due == null) return null
  const delta = due - now
  if (delta <= 0) return "超时"
  const hours = Math.floor(delta / HOUR_MS)
  const minutes = Math.floor((delta % HOUR_MS) / 60_000)
  if (hours >= 48) return Math.floor(hours / 24) + " 天"
  if (hours > 0) return hours + " 小时 " + minutes + " 分"
  const seconds = Math.floor((delta % 60_000) / 1000)
  return minutes + " 分 " + seconds + " 秒"
}

/** 加急在前，其余保持原来的截止顺序。不复制行。 */
export function sortUrgentFirst<T extends DeadlineRow>(rows: T[], now: number): T[] {
  return rows
    .map((row, index) => ({ row, index, urgent: isUrgent(row, now) }))
    .sort((left, right) => Number(right.urgent) - Number(left.urgent) || left.index - right.index)
    .map((item) => item.row)
}

export function nudgeCooling(nudgedAtMs: number | null | undefined, now: number): boolean {
  if (nudgedAtMs == null) return false
  return now - nudgedAtMs < NUDGE_COOLDOWN_MS
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)")
    const apply = () => setReduced(media.matches)
    apply()
    media.addEventListener("change", apply)
    return () => media.removeEventListener("change", apply)
  }, [])
  return reduced
}

/** 减少动态效果时一分钟跳一次，避免每秒改字。 */
export function useNow(reducedMotion: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), reducedMotion ? 60_000 : 1_000)
    return () => window.clearInterval(timer)
  }, [reducedMotion])
  return now
}
