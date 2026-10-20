/**
 * 商品镜像投影（store_product_sync / store_products）——大屏读取的每店
 * count_* 汇总与生命周期分布都从这里派生。
 */
import type { OzonStoreView } from "@/bindings/commands"

const DAY_MS = 24 * 60 * 60 * 1000

export type StoreProductMirrorRow = {
  store_id: string
  count_total?: number | null
  count_on_sale?: number | null
  count_hidden?: number | null
  count_moderation_failed?: number | null
  count_zero_stock?: number | null
  count_archived?: number | null
  probed_at_ms?: number | null
  last_full_sync_at_ms?: number | null
  priced_at_ms_max?: number | null
  pass?: string | null
  hold?: string | null
  hold_until_ms?: number | null
  hold_reason?: string | null
  price_stock_enabled?: boolean
}

export type StoreProductStatus = "fresh" | "stale" | "expired" | "never"

export type StoreProductsSummary = {
  totals: {
    total: number
    onSale: number
    /** 待处理 = 隐藏 + 审核失败 — the bucket an operator acts on. */
    pending: number
    /** null when no counted store runs the six-hour price/stock layer. */
    zeroStock: number | null
    archived: number
  }
  coverage: { read: number; total: number }
  newestSyncMs: number | null
  quotaUsage: { used: number; limit: number } | null
  perStore: {
    storeId: string
    name: string
    onSale: number | null
    hidden: number | null
    moderationFailed: number | null
    archived: number | null
    status: StoreProductStatus
  }[]
}

const SEVEN_DAYS_MS = 7 * DAY_MS
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000

/** The mirror's freshness answer for one store: newest read vs its budget. */
function productMirrorStatus(row: StoreProductMirrorRow, nowMs: number): StoreProductStatus {
  const newest = Math.max(row.probed_at_ms ?? 0, row.last_full_sync_at_ms ?? 0)
  if (newest <= 0) return "never"
  const age = Math.max(0, nowMs - newest)
  if (age >= SEVEN_DAYS_MS) return "expired"
  // A full sync freshens for two weekly windows; a bare probe for two rounds.
  const freshWindow = row.last_full_sync_at_ms ? 2 * SEVEN_DAYS_MS : TWELVE_HOURS_MS
  return age < Math.min(freshWindow, SEVEN_DAYS_MS) ? "fresh" : "stale"
}

/**
 * Console product cards — the same coverage rule the products page uses:
 * `totals` sums only `fresh`/`stale` stores; `expired`/`never` keep their row
 * in `perStore` but stay out of the numbers and out of `coverage.read`.
 */
export function summarizeStoreProducts(
  rows: StoreProductMirrorRow[],
  stores: Pick<OzonStoreView, "id" | "cloud_store_uuid" | "label" | "product_quota">[],
  nowMs: number,
): StoreProductsSummary {
  const names = new Map(
    stores.map((store) => [store.cloud_store_uuid?.trim() || store.id, store]),
  )
  const perStore = rows.map((row) => ({
    storeId: row.store_id,
    name: names.get(row.store_id)?.label ?? row.store_id.slice(0, 8),
    onSale: row.count_on_sale ?? null,
    hidden: row.count_hidden ?? null,
    moderationFailed: row.count_moderation_failed ?? null,
    archived: row.count_archived ?? null,
    status: productMirrorStatus(row, nowMs),
  }))

  const counted = rows.filter((row) => {
    const status = productMirrorStatus(row, nowMs)
    return status === "fresh" || status === "stale"
  })
  const zeroStockEnabled = counted.some((row) => row.price_stock_enabled)
  const totals = {
    total: counted.reduce((sum, row) => sum + (row.count_total ?? 0), 0),
    onSale: counted.reduce((sum, row) => sum + (row.count_on_sale ?? 0), 0),
    pending: counted.reduce(
      (sum, row) => sum + (row.count_hidden ?? 0) + (row.count_moderation_failed ?? 0),
      0,
    ),
    zeroStock: zeroStockEnabled
      ? counted.reduce((sum, row) => sum + (row.count_zero_stock ?? 0), 0)
      : null,
    archived: counted.reduce((sum, row) => sum + (row.count_archived ?? 0), 0),
  }

  const quota = stores
    .filter((store) => store.cloud_store_uuid && rows.some((r) => r.store_id === store.cloud_store_uuid))
    .map((store) => store.product_quota?.total)
    .filter((total): total is NonNullable<typeof total> => total != null)
  const quotaUsage =
    quota.length === 0
      ? null
      : {
          used: quota.reduce((sum, total) => sum + (total.usage ?? 0), 0),
          limit: quota.reduce((sum, total) => sum + (total.limit ?? 0), 0),
        }

  const newestSyncMs =
    rows.reduce((max, row) => Math.max(max, row.probed_at_ms ?? 0, row.last_full_sync_at_ms ?? 0), 0) ||
    null

  return {
    totals,
    coverage: { read: counted.length, total: rows.length },
    newestSyncMs,
    quotaUsage,
    perStore,
  }
}


export type LifecycleKey = "on_sale" | "hidden" | "moderation_failed" | "archived"

export type LifecycleSlice = {
  key: LifecycleKey
  label: string
  value: number
  tone: "good" | "attest" | "bad" | "idle"
}

export type LifecycleScope =
  | { status: "ready"; total: number; slices: LifecycleSlice[] }
  /** 这个店还没同步过商品镜像，或已过期 — 无数据不是零。 */
  | { status: "unsynced" }
  /** 有镜像但四个桶都是零。 */
  | { status: "empty" }

function lifecycleSlices(
  onSale: number,
  hidden: number,
  failed: number,
  archived: number,
): LifecycleSlice[] {
  return [
    { key: "on_sale", label: "在售", value: onSale, tone: "good" },
    { key: "hidden", label: "已隐藏", value: hidden, tone: "attest" },
    { key: "moderation_failed", label: "审核失败", value: failed, tone: "bad" },
    { key: "archived", label: "已归档", value: archived, tone: "idle" },
  ]
}

/**
 * 生命周期分布的可选范围：全部店铺合计只数 fresh/stale 的镜像（与
 * `summarizeStoreProducts` 的 coverage 口径一致）；单店则如实呈现该店镜像
 * 状态——没同步过的店不画成零。
 */
export function lifecycleScope(
  summary: StoreProductsSummary,
  storeId: string | null,
): LifecycleScope {
  const row = storeId ? summary.perStore.find((store) => store.storeId === storeId) : undefined
  const counted = row
    ? row.status === "fresh" || row.status === "stale"
      ? [row]
      : []
    : summary.perStore.filter((store) => store.status === "fresh" || store.status === "stale")
  if (storeId && counted.length === 0) return { status: "unsynced" }
  if (!storeId && summary.coverage.read === 0) return { status: "unsynced" }
  const slices = lifecycleSlices(
    counted.reduce((sum, store) => sum + (store.onSale ?? 0), 0),
    counted.reduce((sum, store) => sum + (store.hidden ?? 0), 0),
    counted.reduce((sum, store) => sum + (store.moderationFailed ?? 0), 0),
    counted.reduce((sum, store) => sum + (store.archived ?? 0), 0),
  )
  const total = slices.reduce((sum, slice) => sum + slice.value, 0)
  return total === 0 ? { status: "empty" } : { status: "ready", total, slices }
}
