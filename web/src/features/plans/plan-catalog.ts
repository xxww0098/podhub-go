/** Display labels only. Prices and capacities come from the subscription API. */
const PLAN_NAMES: Record<string, string> = {
  free: "免费版",
  lite: "入门版",
  pro: "专业版",
  max: "旗舰版",
}

export function planDisplayName(plan?: string | null): string {
  return PLAN_NAMES[plan?.trim().toLowerCase() ?? ""] ?? PLAN_NAMES.free
}

export function yuanLabel(cents: number): string {
  if (cents % 100 === 0) return `¥${cents / 100}`
  return `¥${(cents / 100).toFixed(2)}`
}
