import { route } from "@/api/routes"
import type { ObservationConsole, ObservationLedger, ObservationProduct, ObservationScopes } from "./observation-types"
import type { StoreProductOverviewRow, StoreProductsOverviewData } from "@/features/products/products-api"

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
      store_id: storeId, store_name: "同名店", product_id: 101, offer_id: "SAME-OFFER", sku: "7",
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

export function observedScopes(): ObservationScopes {
  const products = [observedProduct(), observedProduct(WORKSPACE_B, STORE_B)]
  return {
    workspaces: products.map((row) => ({ id: row.workspace_id, name: row.workspace_name, owner_uuid: row.owner_uuid, owner_name: row.owner_name })),
    stores: products.map((row) => ({
      store_id: row.product.store_id, store_name: row.product.store_name,
      workspace_id: row.workspace_id, workspace_name: row.workspace_name,
      owner_uuid: row.owner_uuid, owner_name: row.owner_name,
    })),
  }
}

export function observedConsole(): ObservationConsole {
  const stores = observedScopes().stores
  const intake = [0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 1, 2, 0, 4]
  const settled = [0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 2]
  return {
    generated_at_ms: STAMP,
    roster: { stores: stores.map((store) => ({ id: store.store_id, cloud_store_uuid: store.store_id,
      label: store.store_name, cloud_status: "active", configured: false, client_id: "", ref_id: "",
      secret_status: "unavailable", active: false, can_manage: false, can_edit_credential: false,
      advertising_client_id: "", advertising_configured: false,
      needs_reentry: false, updated_at_ms: 0, watermark_name: "",
      permissions: { delete_store: false, edit_name: false, manage_key: false, manage_store: false, manage_tags: false, test_key: false } })), tags: [], groups: [] },
    metrics: stores.map((store, i) => ({ store_id: store.store_id, ordered_units_30d: 42 + i * 31,
      previous_ordered_units_30d: 32 + i * 21, day_series_14d: [1, 2, 1, 3, 2, 1, 4, 2, 3, 5, 2, 4, 3, 6],
      through_day: "2026-10-12", last_sync_at_ms: STAMP, last_error: "", retry_at_ms: 0 })),
    products: [], ledger: { ...observedLedger(), series: intake.map((value, index) => ({
      day: new Date(STAMP - (13 - index) * 86_400_000).toISOString().slice(0, 10),
      intake: value, settled: settled[index]!, exceptions: index === 13 ? 1 : 0,
    })) },
  }
}

export function observedOverview(): StoreProductsOverviewData {
  return {
    stores: [
      { ...observedStore(), count_total: 126, count_on_sale: 110, count_hidden: 6, count_moderation_failed: 2, count_archived: 8, count_zero_stock: 5 },
      { ...observedStore(STORE_B), count_total: 74, count_on_sale: 60, count_hidden: 5, count_moderation_failed: 1, count_archived: 8, count_zero_stock: 2 },
    ],
    totals: { total: 200, on_sale: 170, hidden: 11, moderation_failed: 3, archived: 16, zero_stock: 7, processing: 0, delisted: 0 },
    coverage: { total: 2, read: 2 }, sync_disabled: true, newest_sync_at_ms: STAMP,
  }
}
