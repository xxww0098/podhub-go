/** Display labels only. Prices and capacities come from the subscription API. */
export type PlanKey = "free" | "lite" | "pro" | "max"
type PlanDef = { key: PlanKey; name: string; tagline: string }

export const PLAN_CATALOG: PlanDef[] = [
  { key: "free", name: "免费版", tagline: "1 店 1 人，永久免费" },
  { key: "lite", name: "入门版", tagline: "5 店 1 人起" },
  { key: "pro", name: "专业版", tagline: "30 店 6 人起" },
  { key: "max", name: "旗舰版", tagline: "50 店 11 人起" },
]

export function normalizePlanKey(plan?: string | null): PlanKey | undefined {
  const key = plan?.trim().toLowerCase()
  return PLAN_CATALOG.some((plan) => plan.key === key) ? (key as PlanKey) : undefined
}

function planByKey(key?: PlanKey): PlanDef {
  return PLAN_CATALOG.find((plan) => plan.key === key) ?? PLAN_CATALOG[0]
}

export function planDisplayName(plan?: string | null): string {
  return planByKey(normalizePlanKey(plan)).name
}

export function yuanLabel(cents: number): string {
  if (cents % 100 === 0) return `¥${cents / 100}`
  return `¥${(cents / 100).toFixed(2)}`
}
