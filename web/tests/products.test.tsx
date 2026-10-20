import assert from "node:assert/strict"
import test from "node:test"

import type {
  ProductMonitorSnapshot,
  ProductPromotionOfferView,
} from "../src/bindings/commands"
import {
  applyProductRefresh,
  applyProductSnapshot,
  applyProductMetrics,
  applyStaleWindow,
  buildDiscountMutation,
  buildPromotionJoinMutation,
  buildPromotionLeaveMutation,
  buildStockMutation,
  canDeletePermanently,
  createProductListState,
  currentStockPresent,
  elasticPriceRange,
  filterProducts,
  promotionDiscountPercent,
  promotionWritePrice,
  formatProductImageCount,
  productTabs,
  productIssueCopy,
  summarize,
  syncFailureLabel,
  warehouseStatusLabel,
} from "../src/features/products/product-list-model"

const snapshot: ProductMonitorSnapshot = {
  store_id: "store_02",
  products: [
    {
      product_id: 41,
      offer_id: "ART-41",
      sku: 90041,
      name: "Live product",
      category_name: "类目 170",
      primary_image_url: "https://img/41.jpg",
      image_count: 3,
      official_state: "active",
      status_name: "Продается",
      is_archived: false,
      issue_count: 1,
      issue_level: "error",
      issue_code: "image_too_small",
      issue_message: "主图过小",
      price: 100,
      old_price: 0,
      currency_code: "CNY",
      stock_present: 7,
      stock_reserved: 2,
      promotion_discount_percent: 10,
      promotion_action_title: "Sale",
      promotion_action_price: "90.00",
      hits_view: 12,
      session_view: 6,
      ordered_units: 2,
      revenue: 180,
      session_view_series: [],
    },
  ],
  sync_states: [
    {
      domain: "products",
      last_sync_at_ms: 1000,
      last_error: "",
      rate_limited_until_ms: 0,
    },
    {
      domain: "metrics",
      last_sync_at_ms: 0,
      last_error: "analytics unavailable",
      rate_limited_until_ms: 60_000,
    },
  ],
  performance: {
    period_days: 3,
    hits_view: 12,
    session_view: 6,
    ordered_units: 2,
    revenue: 180,
    through_day: "2026-08-03",
  },
}

test("product state starts empty and accepts only the host snapshot", () => {
  const initial = createProductListState()
  assert.deepEqual(initial.products, [])
  assert.deepEqual(initial.stores, [])

  const state = applyProductSnapshot(initial, snapshot)
  assert.equal(state.storeUid, "store_02")
  assert.equal(state.products[0]?.offerId, "ART-41")
  assert.equal(state.products[0]?.stockPresent, 7)
  assert.equal(state.performance.periodDays, 3)
  assert.equal(state.performance.revenue, 180)
  assert.equal(state.syncStates[1]?.lastError, "analytics unavailable")
})

test("partial sync status names the failed domains", () => {
  const state = applyProductSnapshot(createProductListState(), snapshot)
  assert.equal(syncFailureLabel(state.syncStates), "部分同步：经营指标不可用")
  assert.equal(syncFailureLabel([]), "")
})

test("progressive metrics merge after core products without replacing identity", () => {
  const state = applyProductSnapshot(createProductListState(), snapshot)
  const merged = applyProductMetrics(state, {
    store_id: "store_02",
    items: [{
      sku: 90041,
      hits_view: 80,
      session_view: 20,
      ordered_units: 4,
      revenue: 360,
    }],
    sync_state: {
      domain: "metrics",
      last_sync_at_ms: 2000,
      last_error: "",
      rate_limited_until_ms: 0,
    },
    performance: {
      period_days: 3,
      hits_view: 80,
      session_view: 20,
      ordered_units: 4,
      revenue: 360,
      through_day: "2026-08-06",
    },
    day_series: [],
  })
  assert.equal(merged.products[0]?.offerId, "ART-41")
  assert.equal(merged.products[0]?.sessionView, 20)
  assert.equal(merged.performance.revenue, 360)
})

test("live product projection feeds tabs and offer/SKU search", () => {
  const state = applyProductSnapshot(createProductListState(), snapshot)
  const summary = summarize(state.products)
  assert.equal(summary.all, 1)
  assert.equal(summary.selling, 1)
  assert.equal(summary.errors, 1)
  assert.equal(filterProducts(state.products, "all", "ART-41").length, 1)
  assert.equal(filterProducts(state.products, "all", "90041").length, 1)
  assert.equal(filterProducts(state.products, "ready", "").length, 0)
})

test("product image count shows the Ozon total without a fixed denominator", () => {
  assert.equal(formatProductImageCount(3), "3 张")
  assert.equal(formatProductImageCount(5), "5 张")
  assert.equal(formatProductImageCount(12), "12 张")
})

test("a 30-day zero-order window marks in-stock live products without replacing 3-day metrics", () => {
  const state = applyProductSnapshot(createProductListState(), snapshot)
  const marked = applyStaleWindow(state, [{ sku: 90041, ordered_units: 0 }])
  assert.equal(marked.products[0]?.staleUnsold, true)
  assert.equal(marked.performance.periodDays, 3)
  const merged = applyProductMetrics(marked, {
    store_id: "store_02",
    items: [{
      sku: 90041,
      hits_view: 80,
      session_view: 20,
      ordered_units: 4,
      revenue: 360,
    }],
    sync_state: {
      domain: "metrics",
      last_sync_at_ms: 2000,
      last_error: "",
      rate_limited_until_ms: 0,
    },
    performance: {
      period_days: 3,
      hits_view: 80,
      session_view: 20,
      ordered_units: 4,
      revenue: 360,
      through_day: "2026-08-06",
    },
    day_series: [],
  })
  assert.equal(merged.performance.periodDays, 3)
  assert.equal(merged.products[0]?.orderedUnits, 4)
  assert.equal(merged.products[0]?.staleUnsold, true)
  assert.equal(filterProducts(merged.products, "stale", "").length, 1)
  assert.equal(summarize(merged.products).stale, 1)
  assert.ok(productTabs(summarize(merged.products)).some((tab) => tab.view === "stale"))
})

test("stale window ignores archived, zero-stock, sold, and missing 30-day rows", () => {
  const archived = {
    ...snapshot.products[0]!,
    product_id: 42,
    offer_id: "ART-42",
    sku: 90042,
    is_archived: true,
    stock_present: 4,
  }
  const empty = {
    ...snapshot.products[0]!,
    product_id: 43,
    offer_id: "ART-43",
    sku: 90043,
    stock_present: 0,
  }
  const sold = {
    ...snapshot.products[0]!,
    product_id: 44,
    offer_id: "ART-44",
    sku: 90044,
  }
  const unknown = {
    ...snapshot.products[0]!,
    product_id: 45,
    offer_id: "ART-45",
    sku: 90045,
  }
  const state = applyProductSnapshot(createProductListState(), {
    ...snapshot,
    products: [archived, empty, sold, unknown],
  })
  const marked = applyStaleWindow(state, [
    { sku: 90042, ordered_units: 0 },
    { sku: 90043, ordered_units: 0 },
    { sku: 90044, ordered_units: 2 },
  ])
  assert.deepEqual(
    marked.products.map((product) => [product.sku, product.staleUnsold]),
    [
      [90042, false],
      [90043, false],
      [90044, false],
      [90045, false],
    ],
  )
})

test("stock prefill addresses the known sku not a reused offer", () => {
  const stocks = [
    { offer_id: "ART-1", sku: 11, warehouse_id: 7, present: 9, reserved: 0 },
    { offer_id: "ART-1", sku: 22, warehouse_id: 7, present: 3, reserved: 0 },
  ]
  assert.equal(currentStockPresent(stocks, 22, "7"), 3)
  assert.equal(currentStockPresent(stocks, 0, "7"), undefined)
})

test("single SKU refresh replaces only that product and preserves store aggregates", () => {
  const secondProduct = {
    ...snapshot.products[0]!,
    product_id: 42,
    offer_id: "ART-42",
    sku: 90042,
    name: "Untouched product",
  }
  const state = applyProductSnapshot(createProductListState(), {
    ...snapshot,
    products: [...snapshot.products, secondProduct],
  })
  const refreshed = applyProductRefresh(
    state,
    {
      ...snapshot,
      products: [{ ...snapshot.products[0]!, name: "Fresh product", stock_present: 19 }],
      performance: { ...snapshot.performance, revenue: 999 },
    },
    90041,
  )

  assert.equal(refreshed.products[0]?.name, "Fresh product")
  assert.equal(refreshed.products[0]?.stockPresent, 19)
  assert.equal(refreshed.products[1]?.name, "Untouched product")
  assert.equal(refreshed.performance.revenue, 180)
})

test("single and multi-select mutations build absolute Ozon requests", () => {
  const state = applyProductSnapshot(createProductListState(), snapshot)
  const product = state.products[0]!
  const productIdRef = { product_id: product.productId, offer_id: product.offerId }

  assert.deepEqual(buildStockMutation([product], 77, 4), {
    kind: "stock",
    items: [{
      product_id: 41,
      offer_id: "ART-41",
      // Ozon settles an interrupted stock write by SKU only.
      sku: 90041,
      warehouse_id: 77,
      stock: 4,
    }],
  })
  assert.deepEqual(buildDiscountMutation([product], 10), {
    kind: "price",
    items: [{
      product_id: 41,
      offer_id: "ART-41",
      price: "90.00",
      old_price: "100.00",
      currency_code: "CNY",
    }],
  })
  assert.deepEqual(buildDiscountMutation([{ ...product, price: 90, oldPrice: 100 }], 0), {
    kind: "price",
    items: [{
      product_id: 41,
      offer_id: "ART-41",
      price: "100.00",
      old_price: "0",
      currency_code: "CNY",
    }],
  })
  assert.equal(canDeletePermanently([product]), false)
  assert.equal(canDeletePermanently([{ ...product, isArchived: true, sku: 0 }]), true)
})

const promotionOffer = (
  overrides: Partial<ProductPromotionOfferView> = {},
): ProductPromotionOfferView => ({
  action_id: 1977747,
  product_id: 41,
  participating: false,
  price: 90,
  action_price: 0,
  max_action_price: 68,
  add_mode: "NOT_SET",
  stock: 0,
  min_stock: 0,
  current_boost: 15,
  min_boost: 15,
  max_boost: 75,
  price_min_elastic: 78,
  price_max_elastic: 51,
  ...overrides,
})

test("promotion write price clamps a percent or a direct price to the Ozon ceiling", () => {
  const offer = promotionOffer()
  // 90 * 15% off is 76.50, above the 68 ceiling, so the write takes the ceiling.
  assert.equal(promotionWritePrice(offer, { kind: "percent", percent: 15 }), 68)
  assert.equal(promotionWritePrice(offer, { kind: "price", price: 55 }), 55)
  assert.equal(promotionWritePrice(offer, { kind: "price", price: 80 }), 68)
  // Seller cabinet shows two decimals: 70 → 62 is 11.43%, not 11.4.
  assert.equal(promotionDiscountPercent(70, 62), 11.43)
})

test("promotion join prices each product against its own Ozon ceiling", () => {
  const state = applyProductSnapshot(createProductListState(), snapshot)
  const product = state.products[0]!
  const productIdRef = { product_id: product.productId, offer_id: product.offerId }
  const offer = promotionOffer()

  assert.deepEqual(
    buildPromotionJoinMutation(1977747, [offer], [productIdRef], (item) => item.price * 0.5),
    {
      kind: "promotion_join",
      action_id: 1977747,
      items: [{ product_id: 41, offer_id: "ART-41", action_price: 45, stock: 0 }],
    },
  )

  // 90 * 0.75 = 67.50 clears the 68 ceiling; 90 * 0.8 = 72 does not.
  assert.equal(
    buildPromotionJoinMutation(1977747, [offer], [productIdRef], (item) => item.price * 0.75)
      .kind,
    "promotion_join",
  )
  assert.throws(
    () => buildPromotionJoinMutation(1977747, [offer], [productIdRef], (item) => item.price * 0.8),
    /上限 68/,
  )
})

test("promotion join carries the promotion's minimum committed stock", () => {
  const state = applyProductSnapshot(createProductListState(), snapshot)
  const product = state.products[0]!
  const productIdRef = { product_id: product.productId, offer_id: product.offerId }
  const request = buildPromotionJoinMutation(
    1977747,
    [promotionOffer({ min_stock: 3 })],
    [productIdRef],
    () => 45,
  )
  assert.equal(request.kind === "promotion_join" && request.items[0]!.stock, 3)
})

test("promotion leave only names products that are actually participating", () => {
  const offers = [
    promotionOffer({ product_id: 41, participating: true }),
    promotionOffer({ product_id: 42, participating: false }),
  ]
  // ELASTIC_BOOSTING exits by re-pricing above the product's own limit: the
  // exit price is max(price, limit) + one kopeck, two decimals.
  assert.deepEqual(buildPromotionLeaveMutation(1977747, "ELASTIC_BOOSTING", offers), {
    kind: "promotion_leave",
    action_id: 1977747,
    product_ids: [41],
    action_type: "ELASTIC_BOOSTING",
    exit_prices: [{ product_id: 41, exit_price: 90.01 }],
  })
  // A PROMOCODE leave keeps the same wire shape with no exit prices to build.
  assert.deepEqual(buildPromotionLeaveMutation(1977747, "PROMOCODE", [
    promotionOffer({ product_id: 41, participating: true, max_action_price: 68 }),
  ]), {
    kind: "promotion_leave",
    action_id: 1977747,
    product_ids: [41],
    action_type: "PROMOCODE",
    exit_prices: [{ product_id: 41, exit_price: 90.01 }],
  })
  assert.throws(
    () =>
      buildPromotionLeaveMutation(1977747, "ELASTIC_BOOSTING", [
        promotionOffer({ participating: false }),
      ]),
    /都不在该活动中/,
  )
  // No limit means no price is provably above it — refuse rather than price
  // blind.
  assert.throws(
    () =>
      buildPromotionLeaveMutation(1977747, "ELASTIC_BOOSTING", [
        promotionOffer({ participating: true, max_action_price: 0 }),
      ]),
    /缺少活动价上限/,
  )
  // The exit price rides above whichever is higher: the limit beats the
  // current price here.
  const stockDiscount = buildPromotionLeaveMutation(1977747, "STOCK_DISCOUNT", [
    promotionOffer({ participating: true, price: 60, max_action_price: 68 }),
  ])
  if (stockDiscount.kind !== "promotion_leave") return assert.fail("expected leave")
  assert.deepEqual(stockDiscount.exit_prices, [{ product_id: 41, exit_price: 68.01 }])
})

test("elastic boosting prices are normalized low-to-high", () => {
  // Ozon names the deeper discount `price_max_elastic`, so the raw pair reads
  // backwards.
  assert.deepEqual(elasticPriceRange(promotionOffer()), { low: 51, high: 78 })
  assert.equal(
    elasticPriceRange(promotionOffer({ price_min_elastic: 0, price_max_elastic: 0 })),
    null,
  )
})

test("warehouse status is glossed, and an unknown status is shown verbatim", () => {
  assert.equal(warehouseStatusLabel("created"), "使用中")
  assert.equal(warehouseStatusLabel("disabled"), "已归档")
  assert.equal(warehouseStatusLabel("some_new_ozon_status"), "some_new_ozon_status")
  assert.equal(warehouseStatusLabel("  "), "状态未知")
})

test("product issue copy matches the stable Ozon code, not its English message", () => {
  assert.deepEqual(
    productIssueCopy("pics_http_error", "request process failed: unknown error host unreachable"),
    {
      action: "重新上传图片",
      detail: "Ozon 无法读取部分商品图片；请回到上架方案重新上传本商品图片后再次发送",
      label: "图片异常",
    },
  )
  assert.deepEqual(productIssueCopy("new_code", "Ozon detail"), {
    action: "去上架方案处理",
    detail: "Ozon detail",
    label: "商品问题",
  })
})

test("promotion join refuses a re-join that would change nothing", () => {
  const state = applyProductSnapshot(createProductListState(), snapshot)
  const product = state.products[0]!
  const productIdRef = { product_id: product.productId, offer_id: product.offerId }
  // Ozon answers an unchanged re-join with neither an acceptance nor a
  // rejection, which would reach the operator as an unexplained failure.
  assert.throws(
    () =>
      buildPromotionJoinMutation(
        1977747,
        [promotionOffer({ participating: true, action_price: 45 })],
        [productIdRef],
        () => 45,
      ),
    /已经以该活动价参加活动/,
  )
  // Moving the agreed price is a real change and still goes through.
  assert.equal(
    buildPromotionJoinMutation(
      1977747,
      [promotionOffer({ participating: true, action_price: 45 })],
      [productIdRef],
      () => 44,
    ).kind,
    "promotion_join",
  )
})
