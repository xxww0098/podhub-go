/** Ozon `/v4/product/info/limit` bucket. `limit === -1` means uncapped. */
export type ProductQuotaBucket = {
  limit: number
  usage: number
}

/** Additional upload quota for one in-demand category (`total.quota_by_category`). */
export type ProductQuotaCategory = {
  category_id: number
  limit: number
  usage: number
}

export type ProductQuotaTotal = ProductQuotaBucket & {
  categories?: ProductQuotaCategory[] | null
  /** Archived products at snapshot time; each refunds +1 to `limit`. */
  archived?: number | null
}

/**
 * Cabinet accounting: every archived product refunds +1 to the assortment
 * limit, so the effective limit is `limit + archived` (`usage` already counts
 * archived products). `archived` absent → the API's raw `limit` stands.
 */
export function effectiveTotalBucket(total: ProductQuotaTotal): ProductQuotaBucket {
  if (total.limit < 0) return { limit: -1, usage: total.usage }
  return { limit: total.limit + (total.archived ?? 0), usage: total.usage }
}

export type ProductQuota = {
  daily_create?: ProductQuotaBucket | null
  daily_update?: ProductQuotaBucket | null
  total?: ProductQuotaTotal | null
}

export type QuotaTier = "good" | "warning" | "danger"

export type ProductQuotaItem = {
  label: string
  limit: number
  usage: number
  remaining: number | null
  ratio: number
  percentage: number
  barWidth: number
  tier: QuotaTier
  color: string
  formatted: string
  remainingFormatted: string
  tooltip: string
}

export function formatProductQuotaBucket(bucket: ProductQuotaBucket): string {
  if (bucket.limit < 0) return "不限"
  return `${Math.max(0, bucket.limit - bucket.usage)} / ${bucket.limit}`
}

/**
 * Generates an OKLCH color-mix transitioning between --st-good (high quota / green),
 * --st-attest (medium quota / amber), and --st-bad (low quota / red).
 */
export function getProductQuotaColor(ratio: number): string {
  const r = Math.max(0, Math.min(1, ratio))
  if (r >= 0.5) {
    const t = Math.round(((r - 0.5) / 0.5) * 100)
    return `color-mix(in oklch, var(--st-good) ${t}%, var(--st-attest))`
  }
  const t = Math.round((r / 0.5) * 100)
  return `color-mix(in oklch, var(--st-attest) ${t}%, var(--st-bad))`
}

export function resolveProductQuotaItem(
  label: string,
  bucket: ProductQuotaBucket,
): ProductQuotaItem {
  if (bucket.limit < 0) {
    return {
      label,
      limit: -1,
      usage: bucket.usage,
      remaining: null,
      ratio: 1,
      percentage: 100,
      barWidth: 100,
      tier: "good",
      color: "var(--st-good)",
      formatted: "不限",
      remainingFormatted: "不限",
      tooltip: `${label}：不限（已用 ${bucket.usage}）`,
    }
  }

  const remaining = Math.max(0, bucket.limit - bucket.usage)
  const ratio = bucket.limit === 0 ? 0 : Math.max(0, Math.min(1, remaining / bucket.limit))
  const percentage = Math.round(ratio * 100)
  // Ensure a tiny pip is visible if quota remains (>0), but 0% if truly depleted
  const barWidth = remaining > 0 ? Math.max(3, percentage) : 0
  const tier: QuotaTier = ratio <= 0.2 ? "danger" : ratio <= 0.5 ? "warning" : "good"
  const color = getProductQuotaColor(ratio)

  return {
    label,
    limit: bucket.limit,
    usage: bucket.usage,
    remaining,
    ratio,
    percentage,
    barWidth,
    tier,
    color,
    formatted: `${remaining} / ${bucket.limit}`,
    remainingFormatted: String(remaining),
    tooltip: `${label}：剩余 ${remaining} / 上限 ${bucket.limit} (${percentage}%)，已用 ${bucket.usage}`,
  }
}

/** Sum the per-category additional quotas into one bucket for the cell. */
export function aggregateCategoryQuota(categories: ProductQuotaCategory[]): ProductQuotaBucket {
  let limit = 0
  let usage = 0
  let uncapped = false
  for (const category of categories) {
    if (category.limit < 0) {
      // An uncapped category still counts its usage — early-returning here
      // would drop it and every later category from「不限（已用 X）」.
      uncapped = true
    } else {
      limit += category.limit
    }
    usage += category.usage
  }
  return { limit: uncapped ? -1 : limit, usage }
}

export function productQuotaItems(
  quota?: ProductQuota | null,
  categoryName?: (categoryId: number) => string | undefined,
): ProductQuotaItem[] {
  if (!quota) return []
  const items: ProductQuotaItem[] = []
  if (quota.daily_create) items.push(resolveProductQuotaItem("新建", quota.daily_create))
  if (quota.daily_update) items.push(resolveProductQuotaItem("更新", quota.daily_update))
  if (quota.total) {
    const item = resolveProductQuotaItem("基础", effectiveTotalBucket(quota.total))
    const archived = quota.total.archived ?? 0
    if (quota.total.limit >= 0 && archived > 0) {
      item.tooltip += `，上限含归档回补 +${archived}`
    }
    items.push(item)
  }
  const categories = quota.total?.categories ?? []
  if (categories.length > 0) {
    const item = resolveProductQuotaItem("附加", aggregateCategoryQuota(categories))
    const detail = categories
      .map((category) => {
        const name = categoryName?.(category.category_id)
        const label = name ? `${name}（${category.category_id}）` : `类目 ${category.category_id}`
        return `${label}：${formatProductQuotaBucket(category)}`
      })
      .join("\n")
    items.push({ ...item, tooltip: `${item.tooltip}\n可用类目（先扣附加、再扣基础）：\n${detail}` })
  }
  return items
}

export function productQuotaLines(quota?: ProductQuota | null): { label: string, value: string }[] {
  if (!quota) return []
  const lines: { label: string, value: string }[] = []
  if (quota.daily_create) lines.push({ label: "新建", value: formatProductQuotaBucket(quota.daily_create) })
  if (quota.daily_update) lines.push({ label: "更新", value: formatProductQuotaBucket(quota.daily_update) })
  if (quota.total) lines.push({ label: "基础", value: formatProductQuotaBucket(effectiveTotalBucket(quota.total)) })
  const categories = quota.total?.categories ?? []
  if (categories.length > 0) {
    lines.push({ label: "附加", value: formatProductQuotaBucket(aggregateCategoryQuota(categories)) })
  }
  return lines
}
