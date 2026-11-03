import type {
  ProductMonitorItem,
  ProductMonitorSnapshot,
  ProductMetricsSnapshot,
  ProductMutationRequest,
  ProductOfficialState,
  ProductPromotionOfferView,
  ProductSyncDomain,
} from "@/bindings/commands"
import type { StoreProductRow } from "./products-api"

type OfficialState = ProductOfficialState

export type ProductView =
  | "all"
  | "selling"
  | "ready"
  | "errors"
  | "needs_fix"
  | "stale"
  | "delisted"
  | "archived"

export type MonitorStore = {
  storeUid: string
  name: string
  clientId: string
}

export type MonitorProduct = {
  productId: number
  offerId: string
  sku: number
  name: string
  categoryName: string
  primaryImageUrl: string
  imageCount: number
  officialState: OfficialState
  statusName: string
  isArchived: boolean
  issueCount: number
  issueLevel: "error" | "warning" | ""
  issueCode: string
  issueMessage: string
  price: number
  oldPrice: number
  currencyCode: string
  stockPresent: number
  stockReserved: number
  promotionDiscountPercent: number
  promotionActionTitle: string
  promotionActionPrice: string
  hitsView: number
  sessionView: number
  orderedUnits: number
  revenue: number
  sessionViewSeries: number[]
  staleUnsold: boolean
}

export type StockMutationTarget = {
  productId: number
  offerId: string
  sku: number
}

export function buildStockMutation(
  products: readonly StockMutationTarget[],
  warehouseId: number,
  stock: number,
): ProductMutationRequest {
  if (!Number.isInteger(warehouseId) || warehouseId <= 0) {
    throw new Error("请选择有效仓库")
  }
  if (!Number.isInteger(stock) || stock < 0) {
    throw new Error("库存必须是大于或等于 0 的整数")
  }
  return {
    kind: "stock",
    items: products.map((product) => ({
      product_id: product.productId,
      offer_id: product.offerId,
      // Ozon can only settle an interrupted stock write by SKU.
      sku: product.sku,
      warehouse_id: warehouseId,
      stock,
    })),
  }
}

// Ozon warehouse `status` values, glossed for the operator. Only `created`
// warehouses are active; the rest still accept stock writes, so they stay
// selectable and are simply labelled.
export function warehouseStatusLabel(status: string): string {
  return {
    created: "使用中",
    new: "开通中",
    disabled: "已归档",
    blocked: "已封禁",
    disabled_due_to_limit: "已暂停",
    error: "异常",
  }[status] ?? (status.trim() || "状态未知")
}

/** `buildDiscountMutation` 只读这五个字段。镜像行并不直接满足它——price 是
 * 字符串、币种在店铺级——调用方（批量对话框）要自行换算 Number(...) 并带
 * 上店铺 `currency`；MonitorProduct 侧可直接传入。 */
export type DiscountMutationProduct = {
  productId: number
  offerId: string
  price: number
  oldPrice: number
  currencyCode: string
}

export function buildDiscountMutation(
  products: readonly DiscountMutationProduct[],
  discountPercent: number,
): ProductMutationRequest {
  if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent >= 100) {
    throw new Error("优惠率必须大于或等于 0% 且小于 100%")
  }
  return {
    kind: "price",
    items: products.map((product) => {
      const basePrice = product.oldPrice > product.price ? product.oldPrice : product.price
      return {
        product_id: product.productId,
        offer_id: product.offerId,
        price: discountPercent === 0
          ? basePrice.toFixed(2)
          : Math.max(0.01, basePrice * (1 - discountPercent / 100)).toFixed(2),
        old_price: discountPercent === 0 ? "0" : basePrice.toFixed(2),
        currency_code: product.currencyCode,
      }
    }),
  }
}

/**
 * 活动起止日的短口径（`09/22`）；空值写「—」。详情抽屉与批量对话框共用。
 * 不能委托 `formatShortDay`：Ozon `/v1/actions` 的 date_start/date_end 由后端
 * 原样透传为 `YYYY-MM-DD HH:mm:ss`，这里必须截掉日以后的部分。
 */
export function shortDate(value: string): string {
  return value ? `${value.slice(5, 10).replace("-", "/")}` : "—"
}

function promotionCents(amount: string): number | null {
  if (!/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/.test(amount)) return null
  const [whole, fraction = ""] = amount.split(".")
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"))
}

function promotionAmount(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`
}

/** The preview is the requested amount. Never silently deepen a discount. */
export function promotionWritePrice(
  offer: Pick<ProductPromotionOfferView, "price" | "price_currency_code" | "currency_code">,
  input: { kind: "percent"; percent: number } | { kind: "price"; price: string },
): string | null {
  if (input.kind === "price") {
    const cents = promotionCents(input.price.trim())
    return cents !== null && cents > 0 ? promotionAmount(cents) : null
  }
  if (offer.price_currency_code !== offer.currency_code || !Number.isFinite(input.percent) || input.percent < 0 || input.percent >= 100) return null
  const base = promotionCents(offer.price)
  const percentText = String(input.percent)
  if (base === null || !/^\d{1,2}(\.\d{1,2})?$/.test(percentText)) return null
  const [whole, fraction = ""] = percentText.split(".")
  const basisPoints = BigInt(Number(whole) * 100 + Number(fraction.padEnd(2, "0")))
  const cents = Number((BigInt(base) * (10_000n - basisPoints) + 5_000n) / 10_000n)
  return cents > 0 ? promotionAmount(cents) : null
}

export function promotionDiscountPercent(price: string, actionPrice: string): number | null {
  const base = Number(price)
  const target = Number(actionPrice)
  if (!(base > 0) || !(target > 0) || target >= base) return null
  return Number((((base - target) / base) * 100).toFixed(2))
}

export function promotionFrozen(freezeDate: string): boolean {
  return freezeDate.trim() !== ""
}

export const PROMOTION_EXITABLE_TYPES: readonly string[] = ["PROMOCODE", "ELASTIC_BOOSTING", "STOCK_DISCOUNT"]

export function buildPromotionJoinMutation(
  actionId: number,
  actionType: string,
  offers: ProductPromotionOfferView[],
  products: readonly Pick<StoreProductRow, "product_id" | "offer_id">[],
  actionPriceFor: (offer: ProductPromotionOfferView) => string,
): ProductMutationRequest {
  if (!Number.isSafeInteger(actionId) || actionId <= 0 || !PROMOTION_EXITABLE_TYPES.some((type) => type === actionType)) {
    throw new Error("请选择支持的活动")
  }
  const offerIdByProduct = new Map(products.map((product) => [product.product_id, product.offer_id]))
  const seen = new Set<number>()
  const items = offers.flatMap((offer) => {
    if (offer.action_id !== actionId || !Number.isSafeInteger(offer.product_id) || offer.product_id <= 0 || seen.has(offer.product_id)) throw new Error("活动商品身份无效，请重新读取")
    seen.add(offer.product_id)
    const cents = promotionCents(actionPriceFor(offer))
    const cap = promotionCents(offer.max_action_price)
    if (cents === null || cents <= 0) throw new Error("活动价必须大于 0，且最多两位小数")
    if (cap === null || cap <= 0) throw new Error(`商品 ${offer.product_id} 缺少活动价上限，请重新读取`)
    if (cents > cap) {
      throw new Error(`活动价 ${promotionAmount(cents)} 超过商品 ${offerIdByProduct.get(offer.product_id) ?? offer.product_id} 的上限 ${offer.max_action_price}`)
    }
    if (!/^[A-Z]{3}$/.test(offer.currency_code)) throw new Error("缺少活动币种，请重新读取")
    const current = promotionCents(offer.action_price)
    if (offer.participating && current === cents) return []
    let stock = 0
    if (actionType === "PROMOCODE") {
      if (offer.min_stock === null || (offer.participating && offer.stock === null)) throw new Error("活动承诺库存未知，请重新读取")
      stock = Math.max(offer.min_stock, offer.participating ? offer.stock! : 0)
      if (!Number.isSafeInteger(stock) || stock < 0) throw new Error("活动承诺库存无效")
    }
    return [{
      product_id: offer.product_id,
      offer_id: offerIdByProduct.get(offer.product_id) ?? offer.offer_id ?? "",
      action_price: promotionAmount(cents),
      currency_code: offer.currency_code,
      stock,
    }]
  })
  if (items.length === 0) throw new Error("没有需要加入或改价的商品；已参加商品的活动价未改变")
  return { kind: "promotion_join", action_id: actionId, action_type: actionType as "PROMOCODE" | "ELASTIC_BOOSTING" | "STOCK_DISCOUNT", items }
}

export function buildPromotionLeaveMutation(
  actionId: number,
  actionType: string,
  offers: ProductPromotionOfferView[],
): ProductMutationRequest {
  if (!Number.isSafeInteger(actionId) || actionId <= 0 || !PROMOTION_EXITABLE_TYPES.some((type) => type === actionType)) throw new Error("请选择支持的活动")
  const leaving = offers.filter((offer) => offer.participating)
  if (leaving.length === 0) throw new Error("已选商品都不在该活动中")
  if (new Set(leaving.map((offer) => offer.product_id)).size !== leaving.length || leaving.some((offer) => offer.action_id !== actionId || !Number.isSafeInteger(offer.product_id) || offer.product_id <= 0)) throw new Error("活动商品身份无效，请重新读取")
  const base = {
    kind: "promotion_leave" as const,
    action_id: actionId,
    product_ids: leaving.map((offer) => offer.product_id),
    action_type: actionType as "PROMOCODE" | "ELASTIC_BOOSTING" | "STOCK_DISCOUNT",
  }
  if (actionType === "PROMOCODE") return base
  const exitPrices = leaving.map((offer) => {
    const cap = promotionCents(offer.max_action_price)
    if (cap === null || cap <= 0) throw new Error(`商品 ${offer.product_id} 缺少活动价上限，无法构造退出价`)
    if (offer.price_currency_code !== offer.currency_code) throw new Error(`商品 ${offer.product_id} 的售价与活动价币种不同，不能计算退出价`)
    const current = promotionCents(offer.price)
    if (current === null || current <= 0 || !/^[A-Z]{3}$/.test(offer.currency_code)) throw new Error("售价或币种无效，请重新读取")
    const cents = Math.max(current, cap) + 1
    if (cents >= 1_000_000_000_000) throw new Error("退出价格超出允许范围")
    return { product_id: offer.product_id, exit_price: promotionAmount(cents), currency_code: offer.currency_code }
  })
  return { ...base, exit_prices: exitPrices }
}

export const STALE_UNSOLD_HINT = "近 30 天未出单，考虑归档并补充新款"

export function isStaleUnsold(
  product: Pick<MonitorProduct, "isArchived" | "stockPresent">,
  orderedUnits30: number | undefined,
): boolean {
  return !product.isArchived && product.stockPresent > 0 && orderedUnits30 === 0
}

export function applyStaleWindow(
  state: ProductListState,
  items: readonly { sku: number; ordered_units: number }[],
): ProductListState {
  const units = new Map(items.map((item) => [item.sku, item.ordered_units]))
  return {
    ...state,
    products: state.products.map((product) => ({
      ...product,
      staleUnsold: isStaleUnsold(product, units.get(product.sku)),
    })),
  }
}

export function currentStockPresent(
  stocks: readonly { sku: number; warehouse_id: number; present: number }[],
  sku: number,
  warehouseId: string,
): number | undefined {
  if (sku <= 0) return undefined
  return stocks.find(
    (item) => item.sku === sku && String(item.warehouse_id) === warehouseId,
  )?.present
}

// Ozon's elastic-boosting promotions name the deeper discount
// `price_max_elastic` and the shallower one `price_min_elastic`; presenting
// them in that order would read backwards, so the pair is normalized here.
export function elasticPriceRange(
  offer: ProductPromotionOfferView,
): { low: number; high: number } | null {
  const low = Math.min(Number(offer.price_max_elastic), Number(offer.price_min_elastic))
  const high = Math.max(Number(offer.price_max_elastic), Number(offer.price_min_elastic))
  return low > 0 && high > low ? { low, high } : null
}

export function canDeletePermanently(products: MonitorProduct[]): boolean {
  return (
    products.length > 0 &&
    products.every(
      (product) => product.isArchived && product.sku <= 0 && product.offerId.trim(),
    )
  )
}

export function formatProductImageCount(imageCount: number): string {
  const count = Number.isFinite(imageCount) ? Math.max(0, Math.trunc(imageCount)) : 0
  return `${count} 张`
}

type SyncDomain = ProductSyncDomain

export type SyncState = {
  domain: SyncDomain
  lastSyncAtMs: number
  lastError: string
  rateLimitedUntilMs: number
}

type ProductSummary = {
  all: number
  selling: number
  ready: number
  errors: number
  needsFix: number
  stale: number
  delisted: number
  archived: number
}

export type StorePerformance = {
  periodDays: number
  hitsView: number
  sessionView: number
  orderedUnits: number
  revenue: number
  throughDay: string
}

type ProductTab = {
  view: ProductView
  label: string
  value: number
  tone: "neutral" | "ok" | "wait" | "danger" | "warn"
  startsGroup: boolean
  hint: string
}

type ProductListState = {
  stores: MonitorStore[]
  storeUid: string
  products: MonitorProduct[]
  syncStates: SyncState[]
  performance: StorePerformance
  syncing: boolean
}

const EMPTY_PERFORMANCE: StorePerformance = {
  periodDays: 3,
  hitsView: 0,
  sessionView: 0,
  orderedUnits: 0,
  revenue: 0,
  throughDay: "",
}

export function createProductListState(): ProductListState {
  return {
    stores: [],
    storeUid: "",
    products: [],
    syncStates: [],
    performance: { ...EMPTY_PERFORMANCE },
    syncing: false,
  }
}

export function applyProductSnapshot(
  state: ProductListState,
  snapshot: ProductMonitorSnapshot,
): ProductListState {
  return {
    ...state,
    storeUid: snapshot.store_id,
    products: snapshot.products.map(toMonitorProduct),
    syncStates: snapshot.sync_states.map((item) => ({
      domain: item.domain,
      lastSyncAtMs: item.last_sync_at_ms,
      lastError: item.last_error,
      rateLimitedUntilMs: item.rate_limited_until_ms,
    })),
    performance: {
      periodDays: snapshot.performance.period_days,
      hitsView: snapshot.performance.hits_view,
      sessionView: snapshot.performance.session_view,
      orderedUnits: snapshot.performance.ordered_units,
      revenue: snapshot.performance.revenue,
      throughDay: snapshot.performance.through_day,
    },
    syncing: false,
  }
}

export function applyProductMetrics(
  state: ProductListState,
  snapshot: ProductMetricsSnapshot,
): ProductListState {
  if (state.storeUid !== snapshot.store_id) return state
  const metrics = new Map(snapshot.items.map((item) => [item.sku, item]))
  const syncStates = state.syncStates.filter((item) => item.domain !== "metrics")
  syncStates.push({
    domain: snapshot.sync_state.domain,
    lastSyncAtMs: snapshot.sync_state.last_sync_at_ms,
    lastError: snapshot.sync_state.last_error,
    rateLimitedUntilMs: snapshot.sync_state.rate_limited_until_ms,
  })
  return {
    ...state,
    products: state.products.map((product) => {
      const item = metrics.get(product.sku)
      return item
        ? {
            ...product,
            hitsView: item.hits_view,
            sessionView: item.session_view,
            orderedUnits: item.ordered_units,
            revenue: item.revenue,
          }
        : product
    }),
    syncStates,
    performance: {
      periodDays: snapshot.performance.period_days,
      hitsView: snapshot.performance.hits_view,
      sessionView: snapshot.performance.session_view,
      orderedUnits: snapshot.performance.ordered_units,
      revenue: snapshot.performance.revenue,
      throughDay: snapshot.performance.through_day,
    },
  }
}

export function applyProductRefresh(
  state: ProductListState,
  snapshot: ProductMonitorSnapshot,
  sku: number,
): ProductListState {
  if (state.storeUid !== snapshot.store_id) return state
  const refreshed = snapshot.products.find((product) => product.sku === sku)
  if (!refreshed) return state
  return {
    ...state,
    products: state.products.map((product) =>
      product.sku === sku
        ? { ...toMonitorProduct(refreshed), staleUnsold: product.staleUnsold }
        : product,
    ),
  }
}

function matchesView(product: MonitorProduct, view: ProductView): boolean {
  switch (view) {
    case "all":
      return !product.isArchived
    case "selling":
      return !product.isArchived && product.officialState === "active"
    case "ready":
      return !product.isArchived && product.officialState === "moderating"
    case "errors":
      return !product.isArchived && product.issueLevel === "error"
    case "needs_fix":
      return !product.isArchived && product.issueLevel === "warning"
    case "stale":
      return product.staleUnsold
    case "delisted":
      return !product.isArchived && product.officialState === "delisted"
    case "archived":
      return product.isArchived
  }
}

export function summarize(products: MonitorProduct[]): ProductSummary {
  const live = products.filter((product) => !product.isArchived)
  return {
    all: live.length,
    selling: live.filter((product) => product.officialState === "active").length,
    ready: live.filter((product) => product.officialState === "moderating").length,
    errors: live.filter((product) => product.issueLevel === "error").length,
    needsFix: live.filter((product) => product.issueLevel === "warning").length,
    stale: live.filter((product) => product.staleUnsold).length,
    delisted: live.filter((product) => product.officialState === "delisted").length,
    archived: products.filter((product) => product.isArchived).length,
  }
}

export function productTabs(summary: ProductSummary): ProductTab[] {
  return [
    { view: "all", label: "所有", value: summary.all, tone: "neutral", startsGroup: false, hint: "本店全部非归档商品" },
    { view: "selling", label: "销售中", value: summary.selling, tone: "ok", startsGroup: false, hint: "Ozon 官方状态为在售" },
    { view: "ready", label: "准备销售", value: summary.ready, tone: "wait", startsGroup: false, hint: "Ozon 官方状态为审核/准备中" },
    { view: "errors", label: "错误", value: summary.errors, tone: "danger", startsGroup: true, hint: "跨状态：带 Ozon 错误的商品" },
    { view: "needs_fix", label: "待修改", value: summary.needsFix, tone: "warn", startsGroup: false, hint: "跨状态：Ozon 要求补充或修正" },
    { view: "stale", label: "滞销", value: summary.stale, tone: "warn", startsGroup: false, hint: STALE_UNSOLD_HINT },
    { view: "delisted", label: "商品已下架", value: summary.delisted, tone: "neutral", startsGroup: true, hint: "Ozon 官方状态为下架" },
    { view: "archived", label: "档案", value: summary.archived, tone: "neutral", startsGroup: false, hint: "已归档，不计入「所有」" },
  ]
}

export function filterProducts(
  products: MonitorProduct[],
  view: ProductView,
  search: string,
): MonitorProduct[] {
  const query = search.trim().toLowerCase()
  return products.filter((product) => {
    if (!matchesView(product, view)) return false
    if (!query) return true
    return (
      product.name.toLowerCase().includes(query) ||
      product.offerId.toLowerCase().includes(query) ||
      String(product.sku).includes(query)
    )
  })
}

export function productIssueCopy(code: string, raw: string) {
  switch (code.trim().toLowerCase()) {
    case "pics_http_error":
      return {
        action: "重新上传图片",
        detail: "Ozon 无法读取部分商品图片；请回到上架方案重新上传本商品图片后再次发送",
        label: "图片异常",
      }
    default:
      return {
        action: "去上架方案处理",
        detail: raw.trim() || code.trim() || "Ozon 未提供问题说明",
        label: "商品问题",
      }
  }
}

export function syncDomainLabel(domain: SyncDomain): string {
  return {
    products: "商品",
    prices: "价格/活动",
    stocks: "库存",
    metrics: "经营指标",
  }[domain]
}

export function syncFailureLabel(states: SyncState[]): string {
  const failed = states.filter((state) => state.lastError.trim())
  if (failed.length === 0) return ""
  return `部分同步：${failed.map((state) => syncDomainLabel(state.domain)).join("、")}不可用`
}

function toMonitorProduct(item: ProductMonitorItem): MonitorProduct {
  const issueLevel =
    item.issue_level === "error" || item.issue_level === "warning"
      ? item.issue_level
      : ""
  return {
    productId: item.product_id,
    offerId: item.offer_id,
    sku: item.sku,
    name: item.name,
    categoryName: item.category_name,
    primaryImageUrl: item.primary_image_url,
    imageCount: item.image_count,
    officialState: item.official_state,
    statusName: item.status_name,
    isArchived: item.is_archived,
    issueCount: item.issue_count,
    issueLevel,
    issueCode: item.issue_code,
    issueMessage: item.issue_message,
    price: item.price,
    oldPrice: item.old_price,
    currencyCode: item.currency_code,
    stockPresent: item.stock_present,
    stockReserved: item.stock_reserved,
    promotionDiscountPercent: item.promotion_discount_percent,
    promotionActionTitle: item.promotion_action_title,
    promotionActionPrice: item.promotion_action_price,
    hitsView: item.hits_view,
    sessionView: item.session_view,
    orderedUnits: item.ordered_units,
    revenue: item.revenue,
    sessionViewSeries: item.session_view_series,
    staleUnsold: false,
  }
}
