import { route } from "@/api/routes"
import type { ObservationLedger, ObservationProduct } from "./observation-types"
import type { StoreProductOverviewRow } from "@/features/products/products-api"

export const WORKSPACE_A = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"
export const WORKSPACE_B = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb"
export const STORE_A = "11111111-1111-4111-a111-111111111111"
export const STORE_B = "22222222-2222-4222-a222-222222222222"
export const STAMP = Date.parse("2026-10-12T23:30:00Z")

export function observedProduct(workspaceId = WORKSPACE_A, storeId = STORE_A): ObservationProduct {
  return {
    workspace_id: workspaceId, workspace_name: workspaceId === WORKSPACE_A ? "甲空间" : "乙空间",
    owner_uuid: workspaceId, owner_name: workspaceId === WORKSPACE_A ? "甲所有者" : "乙所有者",
    product: {
      store_id: storeId, store_name: "同名店", product_id: 101, offer_id: "SAME-OFFER", sku: 7,
      name: "同名商品", state: "on_sale", gone: false, price: "90.0000", old_price: "100.0000",
      stock_present: 3, stock_reserved: 1, image_url: route("adminStoresByStoreIdProductsByStoreProductIdThumbnail", { store_id: storeId, store_product_id: "101" }) + "?v=0123456789abcdef",
      metrics: {
        hits_view: 10, session_view: 4, hits_tocart: 1, conv_tocart: 10,
        ordered_units: 1, revenue: 500, revenue_currency: "RUB", fx_quote: "CNY",
        fx_rate: 10, fx_as_of: "2026-10-12", period_days: 14, through_day: "2026-10-12", fetched_at_ms: STAMP,
      },
    },
  }
}

export function observedStore(storeId = STORE_A): StoreProductOverviewRow {
  return {
    store_id: storeId, name: "同名店", currency: "CNY", status: "active", freshness: "fresh",
    last_full_sync_at_ms: STAMP, count_total: 1, count_on_sale: 1,
  }
}

export function observedLedger(): ObservationLedger {
  return {
    total: 17, created_in7_days: 11, settled_in7_days: 7, in_flight: 3,
    proven_success_rate: 73.123456789, median_settlement_minutes: 19.875,
    needs_action: 5, oldest_action_hours: 12.25,
    series: [{ day: "2026-10-12", intake: 4, settled: 3, exceptions: 1 }],
    outcomes: { settled: 7, active: 3, unknown: 2, failed: 3, attested: 2 },
  }
}
