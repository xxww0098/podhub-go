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

/** 活动冻结后不能退出，也不能把活动价改高。 */
export function promotionFrozen(freezeDate: string): boolean {
  if (!freezeDate) return false
  const at = Date.parse(freezeDate)
  return Number.isFinite(at) && at <= Date.now()
}

/**
 * 活动起止日的短口径（`09/22`）；空值写「—」。详情抽屉与批量对话框共用。
 * 不能委托 `formatShortDay`：Ozon `/v1/actions` 的 date_start/date_end 由后端
 * 原样透传为 `YYYY-MM-DD HH:mm:ss`，这里必须截掉日以后的部分。
 */
export function shortDate(value: string): string {
  return value ? `${value.slice(5, 10).replace("-", "/")}` : "—"
}

/** 由折扣率或指定活动价得到将写入的活动价；高于 Ozon 上限时取上限。 */
export function promotionWritePrice(
  offer: Pick<ProductPromotionOfferView, "price" | "max_action_price">,
  input: { kind: "percent"; percent: number } | { kind: "price"; price: number },
): number | null {
  const raw = input.kind === "percent" ? offer.price * (1 - input.percent / 100) : input.price
  if (!Number.isFinite(raw) || raw <= 0) return null
  const capped = offer.max_action_price > 0 ? Math.min(raw, offer.max_action_price) : raw
  const price = Number(capped.toFixed(2))
  return Number.isFinite(price) && price > 0 ? price : null
}

/** 活动价相对当前售价的折扣幅度，两位小数，与卖家后台活动页一致；活动价不低于售价时没有折扣。 */
export function promotionDiscountPercent(price: number, actionPrice: number): number | null {
  if (!(price > 0) || !(actionPrice > 0) || actionPrice >= price) return null
  return Number((((price - actionPrice) / price) * 100).toFixed(2))
}

// A platform promotion prices each product on its own terms: Ozon caps every
// product at its own `max_action_price`, so one shared percentage is applied
// per product against that product's own price and then clamped.
export function buildPromotionJoinMutation(
  actionId: number,
  offers: ProductPromotionOfferView[],
  products: readonly Pick<StoreProductRow, "product_id" | "offer_id">[],
  actionPriceFor: (offer: ProductPromotionOfferView) => number,
): ProductMutationRequest {
  if (!Number.isInteger(actionId) || actionId <= 0) {
    throw new Error("请选择有效活动")
  }
  const offerIdByProduct = new Map(products.map((product) => [product.product_id, product.offer_id]))
  const items = offers.map((offer) => {
    const price = Number(actionPriceFor(offer).toFixed(2))
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error("活动价必须大于 0")
    }
    if (offer.max_action_price > 0 && price > offer.max_action_price) {
      throw new Error(
        `活动价 ${price} 超过商品 ${offerIdByProduct.get(offer.product_id) ?? offer.product_id} 的上限 ${offer.max_action_price}`,
      )
    }
    return {
      product_id: offer.product_id,
      offer_id: offerIdByProduct.get(offer.product_id) ?? "",
      action_price: price,
      // 0 lets Ozon commit all available stock; Ozon rejects anything below
      // the promotion's own minimum.
      stock: offer.min_stock > 0 ? offer.min_stock : 0,
    }
  })
  if (items.length === 0) {
    throw new Error("没有可加入该活动的已选商品")
  }
  // Ozon answers an unchanged re-join with neither an acceptance nor a
  // rejection, which would surface as an unexplained failure. Refuse the
  // pointless write instead of sending it.
  const unchanged = offers.every((offer, index) =>
    offer.participating && offer.action_price === items[index]!.action_price,
  )
  if (unchanged) {
    throw new Error("已选商品都已经以该活动价参加活动；请改动折扣率或改为退出活动")
  }
  return { kind: "promotion_join", action_id: actionId, items }
}

// Leaving an Ozon promotion is routed by its type: PROMOCODE exits through a
// dedicated method, ELASTIC_BOOSTING and STOCK_DISCOUNT exit by re-pricing
// above the product's own limit. The exit price must be strictly above that
// limit, so it is the higher of the product's prices plus one kopeck.
export const PROMOTION_EXITABLE_TYPES: readonly string[] = ["PROMOCODE", "ELASTIC_BOOSTING", "STOCK_DISCOUNT"]

export function buildPromotionLeaveMutation(
  actionId: number,
  actionType: string,
  offers: ProductPromotionOfferView[],
): ProductMutationRequest {
  if (!Number.isInteger(actionId) || actionId <= 0) {
    throw new Error("请选择有效活动")
  }
  const leaving = offers.filter((offer) => offer.participating)
  if (leaving.length === 0) {
    throw new Error("已选商品都不在该活动中")
  }
  const productIds = leaving.map((offer) => offer.product_id)
  const exitPrices = leaving.map((offer) => {
    // Without a limit there is no price that is provably "above" it, and a
    // blind price could re-price the product inside the promotion.
    if (offer.max_action_price <= 0) {
      throw new Error(
        `商品 ${offer.product_id} 缺少活动价上限，无法构造退出价；请到 Ozon 卖家后台操作`,
      )
    }
    const exit = Math.max(offer.price, offer.max_action_price) + 0.01
    return { product_id: offer.product_id, exit_price: Number(exit.toFixed(2)) }
  })
  return {
    kind: "promotion_leave",
    action_id: actionId,
    product_ids: productIds,
    action_type: actionType,
    exit_prices: exitPrices,
  }
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
  const low = Math.min(offer.price_max_elastic, offer.price_min_elastic)
  const high = Math.max(offer.price_max_elastic, offer.price_min_elastic)
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
