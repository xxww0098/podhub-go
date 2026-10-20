/**
 * 店铺商品表的批量写入选取与分组逻辑。
 *
 * 写本身走 `opsHttp.productsMutate` 的写账本（幂等 operation_id + Ozon
 * 逐项回执），这里只回答三件事：哪些行写得进去、跨店勾选归到哪家店、
 * 超过单次上限时怎么分块。
 */
import type { ProductMutationRequest } from "@/bindings/commands"

import type {
  StoreProductRow,
  StoreProductStatusFilter,
  StoreProductsOverviewData,
} from "./products-api"

/** `/v2/products/stocks` 单次 100 个商品-仓库组合（后端 `validate_request` 同上限）。 */
export const STOCK_MUTATION_LIMIT = 100
/** `/v1/product/import/prices` 单次 1000 件。 */
export const PRICE_MUTATION_LIMIT = 1000
/** 归档 / 恢复单次 100 件，删除单次 500 个货号，促销加入 / 退出单次 100 件（`/v1/actions/products/update` 所迫，后端 `validate_request` 同上限）。 */
export const LIFECYCLE_MUTATION_LIMIT = 100
export const DELETE_MUTATION_LIMIT = 500
export const PROMOTION_MUTATION_LIMIT = 100
/** 核实接口单次最多 50 个货号（服务端去重）。 */
export const VERIFY_LIMIT = 50

/**
 * 表格能发起的每一种 Seller 写入；`verify` 是只读核实，同样按店分组。
 * `variant-*` 三个是「同款规格」的合并 / 拆出 / 移入：走 ops 分组端点而不是
 * `products/mutate`，目标型号与生效由服务端核实（见 products-variant-model.ts）。
 */
export type ProductAction =
  | "price"
  | "stock"
  | "promotion"
  | "archive"
  | "unarchive"
  | "delete"
  | "variant-merge"
  | "variant-split"
  | "variant-move"
  | "verify"

export function rowKey(row: Pick<StoreProductRow, "store_id" | "product_id">): string {
  return `${row.store_id}:${row.product_id}`
}

/**
 * Why this row cannot be archived — or null when 归档 may be offered.
 * An archived row returns null: the action is 恢复, and stock does not block it.
 * Unknown stock fails closed; Ozon refuses an archive that still holds units.
 */
export function archiveBlockReason(row: {
  gone: boolean
  state?: string | null
  product_id: number
  stock_present?: number | null
  stock_reserved?: number | null
}): string | null {
  if (row.gone)
    return row.state === "archived" ? "已下架的商品不能恢复" : "已下架的商品不能归档"
  if (row.state === "archived") return null
  if (!Number.isInteger(row.product_id) || row.product_id <= 0) return "缺少商品编号，不能归档"
  if (row.stock_present == null) return "库存未知，不能归档"
  if (row.stock_present > 0 || (row.stock_reserved ?? 0) > 0) {
    return "归档前请先将库存和预留库存清零"
  }
  return null
}

/** Ozon 只允许删除已归档、且从未生成 SKU 的商品。 */
export function deleteBlockReason(row: StoreProductRow): string | null {
  if (row.gone) return "已下架的商品不能删除"
  if (row.state !== "archived") return "只能删除已归档的商品"
  if ((row.sku ?? 0) > 0) return "已生成 SKU 的商品 Ozon 不允许删除，只能归档"
  if (!row.offer_id.trim()) return "缺少货号，不能删除"
  return null
}

/** 每种操作对单行的拒绝原因；null 表示这行写得进去。 */
export function actionBlockReason(action: ProductAction, row: StoreProductRow): string | null {
  switch (action) {
    case "stock":
      if (row.gone) return "已下架的商品不能改库存"
      return (row.sku ?? 0) > 0 && row.product_id > 0 ? null : "缺少 SKU，不能改库存"
    case "price": {
      if (row.gone) return "已下架的商品不能改价"
      const price = Number(row.price)
      return row.product_id > 0 && Number.isFinite(price) && price > 0 ? null : "缺少售价，不能改价"
    }
    case "promotion":
      if (row.gone) return "已下架的商品不能参加促销"
      if (row.state === "archived") return "已归档的商品不能参加促销"
      return row.product_id > 0 ? null : "缺少商品编号，不能参加促销"
    case "archive":
      if (row.state === "archived") return "商品已归档"
      return archiveBlockReason(row)
    case "unarchive":
      if (row.gone) return "已下架的商品不能恢复"
      return row.state === "archived" ? null : "商品未归档"
    case "delete":
      return deleteBlockReason(row)
    case "variant-merge":
    case "variant-split":
    case "variant-move":
      return variantBlockReason(action, row)
    case "verify":
      return row.gone ? "已下架的商品无法核实" : null
  }
}

/**
 * 分组动作只要求这一行有可核实的商品号、且没有下架。
 * 型号所有权、镜像覆盖与「目标组是否可证明」一律由服务端判定——前端不猜
 * 规则，也不因为本地读不到分组事实就把按钮关掉（缺席即未知，不等于不可执行）。
 */
function variantBlockReason(
  action: "variant-merge" | "variant-split" | "variant-move",
  row: StoreProductRow,
): string | null {
  const verb =
    action === "variant-split" ? "拆出规格" : action === "variant-move" ? "移入同款" : "合并为同款"
  if (row.gone) return `已下架的商品不能${verb}`
  return row.product_id > 0 ? null : `缺少商品编号，不能${verb}`
}

/** 按操作把勾选拆成可写与跳过两组。 */
export function writableFor(
  action: ProductAction,
  rows: readonly StoreProductRow[],
): { ok: StoreProductRow[]; dropped: StoreProductRow[] } {
  const ok: StoreProductRow[] = []
  const dropped: StoreProductRow[] = []
  for (const row of rows) {
    if (actionBlockReason(action, row) === null) ok.push(row)
    else dropped.push(row)
  }
  return { ok, dropped }
}

/**
 * 一次变更只写一家店铺。跨店勾选取人数最多的一组——和工作流「改库存」
 * 的口径一致（`listedStockSingleStoreTargets`）。
 */
export function primaryStoreGroup(rows: readonly StoreProductRow[]): {
  storeId: string
  rows: StoreProductRow[]
  droppedStores: number
} | null {
  const byStore = new Map<string, StoreProductRow[]>()
  for (const row of rows) {
    const group = byStore.get(row.store_id)
    if (group) group.push(row)
    else byStore.set(row.store_id, [row])
  }
  let best: { storeId: string; rows: StoreProductRow[] } | null = null
  for (const [storeId, group] of byStore) {
    if (!best || group.length > best.rows.length) best = { storeId, rows: group }
  }
  return best ? { ...best, droppedStores: byStore.size - 1 } : null
}

export function chunkRows<T>(rows: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size))
  }
  return chunks
}

export function parseStockInput(raw: string): number | null {
  const value = Number(raw.trim())
  return raw.trim() !== "" && Number.isSafeInteger(value) && value >= 0 ? value : null
}

export function parseDiscountPercent(raw: string): number | null {
  const value = Number(raw.trim())
  return raw.trim() !== "" && Number.isFinite(value) && value >= 0 && value < 100 ? value : null
}

/** 金额输入：正数，最多两位小数。空串返回 null。 */
export function parseMoneyInput(raw: string): number | null {
  const text = raw.trim()
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null
  const value = Number(text)
  return value > 0 ? value : null
}

/**
 * 指定价写入：每件商品设为同一售价；划线价为空或不高于售价时写 "0"
 * （Ozon 以 0 表示无划线价）。
 */
export function buildFixedPriceMutation(
  rows: readonly Pick<StoreProductRow, "product_id" | "offer_id">[],
  price: number,
  oldPrice: number | null,
  currencyCode: string,
): ProductMutationRequest {
  if (!Number.isFinite(price) || price <= 0) throw new Error("售价必须大于 0")
  const strike = oldPrice != null && oldPrice > price ? oldPrice.toFixed(2) : "0"
  return {
    kind: "price",
    items: rows.map((row) => ({
      product_id: row.product_id,
      offer_id: row.offer_id,
      price: price.toFixed(2),
      old_price: strike,
      currency_code: currencyCode,
    })),
  }
}

/** 一次归档成功后，各状态桶应移动的件数。已归档、已下架的行不再计入。 */
export type ArchiveCountDelta = {
  total: number
  onSale: number
  processing: number
  hidden: number
  moderationFailed: number
  zeroStock: number
  archived: number
  delisted: number
}

export function archiveCountDelta(rows: readonly StoreProductRow[]): ArchiveCountDelta {
  const delta: ArchiveCountDelta = {
    total: 0,
    onSale: 0,
    processing: 0,
    hidden: 0,
    moderationFailed: 0,
    zeroStock: 0,
    archived: 0,
    delisted: 0,
  }
  for (const row of rows) {
    if (row.gone || row.state === "archived") continue
    delta.archived += 1
    delta.total -= 1
    switch (row.state) {
      case "on_sale":
        delta.onSale -= 1
        if (row.stock_present === 0) delta.zeroStock -= 1
        break
      case "processing":
        delta.processing -= 1
        break
      case "hidden":
        delta.hidden -= 1
        break
      case "moderation_failed":
        delta.moderationFailed -= 1
        break
      default:
        break
    }
  }
  return delta
}

function shiftCount(value: number | null | undefined, delta: number): number | null | undefined {
  if (value == null || delta === 0) return value
  return value + delta
}

/**
 * 归档回执落地后先挪本地页签，再等汇总接口回读。
 * 八列还是空（从未同步）时不动：空不是 0。
 * 失效店铺的数字不在工作空间合计里，只改这一家。
 */
export function shiftOverviewForArchive(
  overview: StoreProductsOverviewData,
  storeId: string,
  delta: ArchiveCountDelta,
): StoreProductsOverviewData {
  let feedsTotals = false
  const stores = overview.stores.map((store) => {
    if (store.store_id !== storeId || store.count_total == null) return store
    if (store.freshness === "fresh" || store.freshness === "stale") feedsTotals = true
    return {
      ...store,
      count_total: shiftCount(store.count_total, delta.total),
      count_on_sale: shiftCount(store.count_on_sale, delta.onSale),
      count_processing: shiftCount(store.count_processing, delta.processing),
      count_hidden: shiftCount(store.count_hidden, delta.hidden),
      count_moderation_failed: shiftCount(store.count_moderation_failed, delta.moderationFailed),
      count_zero_stock: shiftCount(store.count_zero_stock, delta.zeroStock),
      count_archived: shiftCount(store.count_archived, delta.archived),
      count_delisted: shiftCount(store.count_delisted, delta.delisted),
    }
  })
  if (!feedsTotals) return { ...overview, stores }
  const totals = overview.totals
  return {
    ...overview,
    stores,
    totals: {
      total: totals.total + delta.total,
      on_sale: totals.on_sale + delta.onSale,
      processing: totals.processing + delta.processing,
      hidden: totals.hidden + delta.hidden,
      moderation_failed: totals.moderation_failed + delta.moderationFailed,
      zero_stock: totals.zero_stock + delta.zeroStock,
      archived: totals.archived + delta.archived,
      delisted: totals.delisted + delta.delisted,
    },
  }
}

/**
 * 当前页签不再包含这些行时，把它们从这一页拿掉。
 * 「档案」页签要留下（回读会补上新归档的行）。键是店铺加商品号，避免跨店撞号。
 */
export function listAfterArchive(
  rows: readonly StoreProductRow[],
  doneKeys: ReadonlySet<string>,
  status: StoreProductStatusFilter | undefined,
): StoreProductRow[] {
  if (status === "archived") return [...rows]
  return rows.filter((row) => !doneKeys.has(rowKey(row)))
}

/** 归档 / 恢复 / 删除三种生命周期写入，按各自上限分块。 */
export function buildLifecycleMutations(
  action: "archive" | "unarchive" | "delete",
  rows: readonly StoreProductRow[],
): ProductMutationRequest[] {
  if (action === "delete") {
    return chunkRows(rows, DELETE_MUTATION_LIMIT).map((chunk) => ({
      kind: "delete",
      offer_ids: chunk.map((row) => row.offer_id),
    }))
  }
  return chunkRows(rows, LIFECYCLE_MUTATION_LIMIT).map((chunk) => ({
    kind: action,
    product_ids: chunk.map((row) => row.product_id),
  }))
}
