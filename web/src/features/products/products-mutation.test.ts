import assert from "node:assert/strict"
import test from "node:test"

import {
  PROMOTION_EXITABLE_TYPES,
  buildDiscountMutation,
  buildStockMutation,
  shortDate,
} from "./product-list-model"
import {
  actionBlockReason,
  archiveBlockReason,
  archiveCountDelta,
  buildFixedPriceMutation,
  buildLifecycleMutations,
  chunkRows,
  listAfterArchive,
  parseDiscountPercent,
  parseMoneyInput,
  parseStockInput,
  primaryStoreGroup,
  rowKey,
  shiftOverviewForArchive,
  writableFor,
  LIFECYCLE_MUTATION_LIMIT,
  PRICE_MUTATION_LIMIT,
  PROMOTION_MUTATION_LIMIT,
  STOCK_MUTATION_LIMIT,
} from "./products-mutation"
import type { StoreProductOverviewRow, StoreProductRow, StoreProductsOverviewData } from "./products-api"

const STORE_A = "11111111-2222-3333-4444-555555555555"
const STORE_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

function row(over: Partial<StoreProductRow> = {}): StoreProductRow {
  return {
    store_id: STORE_A,
    store_name: "测试店",
    product_id: 101,
    offer_id: "OF-1",
    sku: 777,
    name: "测试商品",
    price: "199.00",
    old_price: "299.00",
    stock_present: 3,
    stock_reserved: 0,
    gone: false,
    ...over,
  }
}

test("stock writes drop gone rows and rows without a numeric sku/productId", () => {
  const { ok, dropped } = writableFor("stock", [
    row(),
    row({ offer_id: "gone", gone: true }),
    row({ offer_id: "no-sku", sku: 0 }),
    row({ offer_id: "no-id", product_id: 0 }),
  ])
  assert.deepEqual(
    ok.map((item) => item.offer_id),
    ["OF-1"],
  )
  assert.equal(dropped.length, 3)
})

test("price writes drop rows whose price cannot be priced", () => {
  const { ok, dropped } = writableFor("price", [
    row(),
    row({ offer_id: "gone", gone: true }),
    row({ offer_id: "no-price", price: null }),
    row({ offer_id: "bad-price", price: "abc" }),
    row({ offer_id: "zero-price", price: "0" }),
  ])
  assert.deepEqual(
    ok.map((item) => item.offer_id),
    ["OF-1"],
  )
  assert.equal(dropped.length, 4)
})

test("primaryStoreGroup keeps the largest same-store selection", () => {
  const rows = [
    row({ offer_id: "A-1" }),
    row({ offer_id: "A-2" }),
    row({ offer_id: "B-1", store_id: STORE_B, store_name: "别家" }),
  ]
  const group = primaryStoreGroup(rows)
  assert.equal(group?.storeId, STORE_A)
  assert.equal(group?.rows.length, 2)
  assert.equal(group?.droppedStores, 1)
  assert.equal(primaryStoreGroup([]), null)
})

test("chunkRows splits at the Seller call bound", () => {
  const rows = Array.from({ length: STOCK_MUTATION_LIMIT + 1 }, (_, index) => index)
  const chunks = chunkRows(rows, STOCK_MUTATION_LIMIT)
  assert.equal(chunks.length, 2)
  assert.equal(chunks[0]!.length, STOCK_MUTATION_LIMIT)
  assert.equal(chunks[1]!.length, 1)
  assert.equal(chunkRows(rows.slice(0, 10), PRICE_MUTATION_LIMIT).length, 1)
})

test("stock input must be a non-negative integer", () => {
  assert.equal(parseStockInput("42"), 42)
  assert.equal(parseStockInput("0"), 0)
  assert.equal(parseStockInput(""), null)
  assert.equal(parseStockInput("-1"), null)
  assert.equal(parseStockInput("1.5"), null)
  assert.equal(parseStockInput("abc"), null)
})

test("discount percent must sit in [0, 100)", () => {
  assert.equal(parseDiscountPercent("0"), 0)
  assert.equal(parseDiscountPercent("12.5"), 12.5)
  assert.equal(parseDiscountPercent("99"), 99)
  assert.equal(parseDiscountPercent(""), null)
  assert.equal(parseDiscountPercent("100"), null)
  assert.equal(parseDiscountPercent("-5"), null)
})

test("buildStockMutation addresses every item by product_id at one warehouse", () => {
  const request = buildStockMutation(
    [
      { productId: 101, offerId: "OF-1", sku: 777 },
      { productId: 102, offerId: "OF-2", sku: 778 },
    ],
    55,
    9,
  )
  assert.equal(request.kind, "stock")
  if (request.kind !== "stock") return
  assert.equal(request.items.length, 2)
  assert.equal(request.items[0]!.warehouse_id, 55)
  assert.equal(request.items[0]!.stock, 9)
  // sku travels for the settlement probe, not for the write itself.
  assert.equal(request.items[1]!.sku, 778)
})

test("buildDiscountMutation reprices off the higher tag and 0% clears the markdown", () => {
  const product = { productId: 101, offerId: "OF-1", price: 199, oldPrice: 299, currencyCode: "CNY" }
  const discounted = buildDiscountMutation([product], 10)
  assert.equal(discounted.kind, "price")
  if (discounted.kind !== "price") return
  assert.equal(discounted.items[0]!.old_price, "299.00")
  assert.equal(discounted.items[0]!.price, "269.10")
  assert.equal(discounted.items[0]!.currency_code, "CNY")

  const cleared = buildDiscountMutation([product], 0)
  if (cleared.kind !== "price") return
  assert.equal(cleared.items[0]!.price, "299.00")
  assert.equal(cleared.items[0]!.old_price, "0")
})

test("archive blocks on unknown or remaining stock; unarchive only takes archived rows", () => {
  assert.equal(archiveBlockReason(row({ stock_present: 0 })), null)
  assert.match(archiveBlockReason(row({ stock_present: null })) ?? "", /库存未知/)
  assert.match(archiveBlockReason(row({ stock_present: 0, stock_reserved: 2 })) ?? "", /清零/)
  assert.equal(archiveBlockReason(row({ state: "archived", stock_present: 5 })), null)
  assert.match(actionBlockReason("archive", row({ state: "archived" })) ?? "", /已归档/)
  assert.equal(actionBlockReason("unarchive", row({ state: "archived" })), null)
  assert.match(actionBlockReason("unarchive", row({ state: "on_sale" })) ?? "", /未归档/)
})

test("delete only takes archived rows that never got a SKU", () => {
  assert.equal(actionBlockReason("delete", row({ state: "archived", sku: null })), null)
  assert.match(actionBlockReason("delete", row({ state: "archived", sku: 9 })) ?? "", /SKU/)
  assert.match(actionBlockReason("delete", row({ state: "on_sale", sku: null })) ?? "", /已归档/)
})

test("promotions refuse archived and gone rows", () => {
  assert.equal(actionBlockReason("promotion", row()), null)
  assert.notEqual(actionBlockReason("promotion", row({ state: "archived" })), null)
  assert.notEqual(actionBlockReason("promotion", row({ gone: true })), null)
})

test("活动起止日只显示月/日：Ozon 透传的带时分秒串也要截断", () => {
  // Ozon `/v1/actions` 的 date_start/date_end 是 `YYYY-MM-DD HH:mm:ss`，后端
  // fieldString 原样透传（internal/ops/domain/promotions.go）。回归：委托
  // formatShortDay 的 day.slice(5) 曾让「07/01–07/31」变成带 00:00:00 的长串。
  assert.equal(shortDate("2026-07-01 00:00:00"), "07/01")
  assert.equal(shortDate("2026-07-31 23:59:59"), "07/31")
  assert.equal(shortDate("2026-07-01"), "07/01")
  assert.equal(shortDate(""), "—")
})

test("money input takes positive amounts with at most two decimals", () => {
  assert.equal(parseMoneyInput("199"), 199)
  assert.equal(parseMoneyInput("199.9"), 199.9)
  assert.equal(parseMoneyInput("0"), null)
  assert.equal(parseMoneyInput("1.234"), null)
  assert.equal(parseMoneyInput("-3"), null)
  assert.equal(parseMoneyInput(""), null)
})

test("fixed price writes one price and drops a strike price that is not higher", () => {
  const request = buildFixedPriceMutation([{ product_id: 101, offer_id: "OF-1" }], 150, 200, "RUB")
  if (request.kind !== "price") return assert.fail("expected price")
  assert.equal(request.items[0]!.price, "150.00")
  assert.equal(request.items[0]!.old_price, "200.00")
  const noStrike = buildFixedPriceMutation([{ product_id: 101, offer_id: "OF-1" }], 150, 120, "RUB")
  if (noStrike.kind !== "price") return assert.fail("expected price")
  assert.equal(noStrike.items[0]!.old_price, "0")
})

test("lifecycle writes chunk at their Seller bounds and delete addresses offers", () => {
  const rows = Array.from({ length: LIFECYCLE_MUTATION_LIMIT + 1 }, (_, index) =>
    row({ product_id: index + 1, offer_id: `OF-${index}` }),
  )
  const archives = buildLifecycleMutations("archive", rows)
  assert.equal(archives.length, 2)
  assert.equal(archives[0]!.kind, "archive")
  const deletes = buildLifecycleMutations("delete", rows)
  assert.equal(deletes.length, 1)
  if (deletes[0]!.kind !== "delete") return assert.fail("expected delete")
  assert.equal(deletes[0]!.offer_ids[0], "OF-0")
})

test("promotion writes chunk at one update request's worth of products", () => {
  // `/v1/actions/products/update` is the promotion write of the 2026-10 v2
  // generation; the wire and the backend both cap a request at 100 products.
  assert.equal(PROMOTION_MUTATION_LIMIT, 100)
  const rows = Array.from({ length: PROMOTION_MUTATION_LIMIT + 1 }, (_, index) =>
    row({ product_id: index + 1, offer_id: `OF-${index}` }),
  )
  const chunks = chunkRows(rows, PROMOTION_MUTATION_LIMIT)
  assert.equal(chunks.length, 2)
  assert.equal(chunks[1]!.length, 1)
})

test("only the promotion types the API can exit are offered the leave tab", () => {
  // The dialog disables Leave for everything else; the server stays the
  // judge and answers with guidance for unknown spellings.
  for (const type of ["PROMOCODE", "ELASTIC_BOOSTING", "STOCK_DISCOUNT"]) {
    assert.equal(PROMOTION_EXITABLE_TYPES.includes(type), true, type)
  }
  for (const type of ["MAXIMUM_BOOSTING", "DISCOUNT", ""]) {
    assert.equal(PROMOTION_EXITABLE_TYPES.includes(type), false, type)
  }
})

function overviewStore(
  over: Partial<StoreProductOverviewRow> = {},
): StoreProductOverviewRow {
  return {
    store_id: STORE_A,
    name: "测试店",
    status: "active",
    freshness: "fresh",
    count_total: 383,
    count_on_sale: 0,
    count_processing: 339,
    count_hidden: 44,
    count_moderation_failed: 0,
    count_zero_stock: 0,
    count_archived: 25,
    count_delisted: 0,
    ...over,
  }
}

function overview(store: StoreProductOverviewRow = overviewStore()): StoreProductsOverviewData {
  return {
    totals: {
      total: store.count_total ?? 0,
      on_sale: store.count_on_sale ?? 0,
      processing: store.count_processing ?? 0,
      hidden: store.count_hidden ?? 0,
      moderation_failed: store.count_moderation_failed ?? 0,
      zero_stock: store.count_zero_stock ?? 0,
      archived: store.count_archived ?? 0,
      delisted: store.count_delisted ?? 0,
    },
    coverage: { read: 1, total: 1 },
    sync_disabled: false,
    stores: [store],
  }
}

test("归档 100 件准备销售的商品后，所有/准备销售减少，档案增加", () => {
  const archived = Array.from({ length: 100 }, (_, index) =>
    row({ product_id: index + 1, state: "processing", stock_present: 0 }),
  )
  const delta = archiveCountDelta(archived)
  assert.deepEqual(delta, {
    total: -100,
    onSale: 0,
    processing: -100,
    hidden: 0,
    moderationFailed: 0,
    zeroStock: 0,
    archived: 100,
    delisted: 0,
  })
  const next = shiftOverviewForArchive(overview(), STORE_A, delta)
  const store = next.stores[0]!
  assert.equal(store.count_total, 283)
  assert.equal(store.count_processing, 239)
  assert.equal(store.count_hidden, 44)
  assert.equal(store.count_archived, 125)
  assert.equal(next.totals.total, 283)
  assert.equal(next.totals.processing, 239)
  assert.equal(next.totals.archived, 125)
})

test("已归档、已下架不重复计入；在售且零库存同时离开零库存桶", () => {
  const delta = archiveCountDelta([
    row({ product_id: 1, state: "on_sale", stock_present: 0 }),
    row({ product_id: 2, state: "archived", stock_present: 0 }),
    row({ product_id: 3, state: "processing", stock_present: 0, gone: true }),
    row({ product_id: 4, state: "hidden", stock_present: 0 }),
    row({ product_id: 5, state: "moderation_failed", stock_present: 0 }),
  ])
  assert.equal(delta.archived, 3)
  assert.equal(delta.total, -3)
  assert.equal(delta.onSale, -1)
  assert.equal(delta.zeroStock, -1)
  assert.equal(delta.hidden, -1)
  assert.equal(delta.moderationFailed, -1)
  assert.equal(delta.processing, 0)
})

test("从未同步的店铺不把空计数改成数字；失效店不进工作空间合计", () => {
  const delta = archiveCountDelta([
    row({ state: "processing", stock_present: 0 }),
  ])
  const never = shiftOverviewForArchive(
    overview(overviewStore({
      freshness: "never",
      count_total: null,
      count_on_sale: null,
      count_processing: null,
      count_hidden: null,
      count_moderation_failed: null,
      count_zero_stock: null,
      count_archived: null,
      count_delisted: null,
    })),
    STORE_A,
    delta,
  )
  assert.equal(never.stores[0]!.count_total, null)
  assert.equal(never.totals.total, 0)

  const expired = shiftOverviewForArchive(
    overview(overviewStore({ freshness: "expired", count_total: 9, count_archived: 1 })),
    STORE_A,
    delta,
  )
  assert.equal(expired.stores[0]!.count_total, 8)
  assert.equal(expired.stores[0]!.count_archived, 2)
  // 失效店本来就不在合计里，合计保持调用方传入的原值。
  assert.equal(expired.totals.total, 9)
  assert.equal(expired.totals.archived, 1)
})

test("非档案页拿掉已归档行，档案页保留；跨店同号只动这一家", () => {
  const here = row({ product_id: 7, state: "processing", stock_present: 0 })
  const other = row({
    store_id: STORE_B,
    product_id: 7,
    state: "processing",
    stock_present: 0,
  })
  const done = new Set([rowKey(here)])
  const ready = listAfterArchive([here, other], done, "processing")
  assert.deepEqual(ready.map((item) => item.store_id), [STORE_B])
  const archiveTab = listAfterArchive([here], done, "archived")
  assert.equal(archiveTab.length, 1)
  const all = listAfterArchive([here, other], done, undefined)
  assert.deepEqual(all.map((item) => item.store_id), [STORE_B])
})
