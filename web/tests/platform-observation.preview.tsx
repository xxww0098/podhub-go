/** Synthetic visual handoff for the real readonly controllers, never real API data. */
import { createRoot } from "react-dom/client"
import { ObservationScopeProvider } from "../src/features/platform-observation/observation-scope-provider"
import { AdminConsoleScreen } from "../src/features/platform-observation/admin-console-screen"
import { AdminProductsScreen } from "../src/features/platform-observation/admin-products-screen"
import { observedLedger, observedProduct, observedStore, WORKSPACE_A, WORKSPACE_B, STORE_A, STORE_B, STAMP } from "../src/features/platform-observation/observation-fixtures"
import { route } from "../src/api/routes"
import type { ObservationConsole } from "../src/features/platform-observation/observation-types"

export function previewObservation(kind: string, fixture: HTMLElement) {
  const products = [observedProduct(), observedProduct(WORKSPACE_B, STORE_B)]
    .map((row) => ({ ...row, product: { ...row.product, imageUrl: null } }))
  const scopes = {
    workspaces: products.map((row) => ({ id: row.workspace_id, name: row.workspace_name, ownerUuid: row.owner_uuid, ownerName: row.owner_name })),
    stores: products.map((row) => ({ ...row, storeId: row.product.store_id, storeName: row.product.store_name })),
  }
  const stores = [observedStore(), observedStore(STORE_B)]
  const data: ObservationConsole = {
    generated_at_ms: STAMP,
    roster: { stores: products.map((row) => ({ id: row.product.store_id, cloud_store_uuid: row.product.store_id,
      label: row.product.store_name, cloud_status: "active", configured: false, client_id: "", ref_id: "",
      secret_status: "unavailable", active: false, can_manage: false, can_edit_credential: false,
      advertising_client_id: "", advertising_configured: false, assignee_key_manage: false,
      needs_reentry: false, updated_at_ms: 0, watermark_name: "",
      permissions: { delete_store: false, edit_name: false, manage_key: false, manage_key_grants: false, manage_store: false, manage_tags: false, test_key: false } })), tags: [], groups: [] },
    metrics: products.map((row, i) => ({ store_id: row.product.store_id, ordered_units_30d: 42 + i * 31,
      previous_ordered_units_30d: 32 + i * 21, day_series_14d: [1, 2, 1, 3, 2, 1, 4, 2, 3, 5, 2, 4, 3, 6],
      through_day: "2026-10-12", last_sync_at_ms: STAMP, last_error: "", retry_at_ms: 0 })),
    products: [], ledger: observedLedger(),
  }
  const original = window.fetch
  window.fetch = async (input, init) => {
    const url = new URL(String(input), window.location.origin)
    if (!url.pathname.startsWith("/api/")) return original(input, init)
    if ((init?.method ?? "GET") !== "GET") throw new Error("Visual preview refuses every write")
    let response: unknown
    if (url.pathname === route("adminOpsScopes")) response = scopes
    else if (url.pathname === route("adminOpsConsoleSnapshot")) response = data
    else if (url.pathname === route("adminStoresProductsOverview")) response = { stores, totals: { total: 2, onSale: 2 }, coverage: { total: 2, read: 2, stale: 0, expired: 0, never: 0 }, syncDisabled: true, newestSyncAtMs: STAMP }
    else if (url.pathname === route("adminStoresProducts")) response = { items: products }
    else throw new Error("Visual preview refuses unknown API routes")
    return new Response(JSON.stringify({ data: response }), { headers: { "Content-Type": "application/json" } })
  }
  const root = createRoot(fixture)
  root.render(<ObservationScopeProvider enabled>
    {kind === "console" ? <AdminConsoleScreen onOpenProducts={() => undefined} /> : <AdminProductsScreen />}
  </ObservationScopeProvider>)
}
