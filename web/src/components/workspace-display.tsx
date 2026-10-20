import type { CSSProperties } from "react"

import { planDisplayName } from "@/features/plans/plan-catalog"

const PLAN_TONE: Record<string, { tone: string; soft: string; ink: string }> = {
  lite: {
    tone: "var(--plan-lite)",
    soft: "var(--plan-lite-soft)",
    ink: "var(--plan-lite-ink)",
  },
  pro: {
    tone: "var(--plan-pro)",
    soft: "var(--plan-pro-soft)",
    ink: "var(--plan-pro-ink)",
  },
  max: {
    tone: "var(--plan-max)",
    soft: "var(--plan-max-soft)",
    ink: "var(--plan-max-ink)",
  },
  ultra: {
    tone: "var(--plan-ultra)",
    soft: "var(--plan-ultra-soft)",
    ink: "var(--plan-ultra-ink)",
  },
}

export function planTone(plan?: string) {
  if (!plan) return undefined
  return PLAN_TONE[plan.toLowerCase()] ?? PLAN_TONE.lite
}

export function PlanMark({ plan }: { plan?: string }) {
  const label = formatPlan(plan)
  const tone = planTone(plan)
  if (!label || !tone) return null
  return (
    <span
      data-plan={plan?.toLowerCase()}
      className="plan-mark"
      style={
        {
          "--plan-tone": tone.tone,
          "--plan-tone-soft": tone.soft,
          "--plan-tone-ink": tone.ink,
        } as CSSProperties
      }
    >
      {label}
    </span>
  )
}

export function formatPlan(plan?: string) {
  return planDisplayName(plan)
}

/** Membership role only（我 ↔ 这个 Workspace）, not the platform role. */
export function formatRole(role?: string) {
  if (!role) return undefined
  const labels: Record<string, string> = {
    owner: "所有者",
    manager: "主管",
    member: "运营",
  }
  return labels[role] ?? role
}
