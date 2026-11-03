import assert from "node:assert/strict"
import test from "node:test"
import type { StoreProductRow } from "./products-api"
import { productsCsv } from "./products-export"

test("CSV exports selected facts, quotes text and protects spreadsheet formulas and long identifiers", () => {
  const row: StoreProductRow = {
    store_id: "store-1",
    store_name: "主店, \"A\"",
    product_id: 1,
    offer_id: "+123",
    name: "=HYPERLINK(\"https://example.test\")",
    sku: "1234567890123456789",
    price: "12.50",
    stock_present: 0,
    state: "on_sale",
    refreshed_at_ms: 1_700_000_000_000,
    gone: false,
  }
  const csv = productsCsv([row], () => "USD", () => null)
  assert.ok(csv.startsWith("\uFEFF"))
  assert.match(csv, /"'=HYPERLINK\(""https:\/\/example\.test""\)"/)
  assert.match(csv, /"'\+123"/)
  assert.match(csv, /"'1234567890123456789"/)
  assert.match(csv, /"主店, ""A"""/)
  assert.match(csv, /"12\.50","USD","0","在售","2023-11-14T22:13:20\.000Z"/)
})

test("CSV keeps unknown product facts empty rather than fabricating values", () => {
  const csv = productsCsv([{ store_id: "s", store_name: "店", product_id: 1, offer_id: "a", gone: false }], () => null, () => null)
  assert.match(csv, /"店","","","","未知",""/)
})

test("CSV preserves an ordinary SKU and falls back to the full sync time", () => {
  const csv = productsCsv([{ store_id: "s", store_name: "店", product_id: 1, offer_id: "a", gone: false, sku: "902", refreshed_at_ms: 0 }], () => null, () => 1_700_000_000_000)
  assert.match(csv, /"a","902","店"/)
  assert.match(csv, /"2023-11-14T22:13:20.000Z"/)
})
