/** Synthetic visual handoff for the real readonly controllers, never real API data. */
import { createRoot } from "react-dom/client"
import { ObservationScopeProvider } from "../src/features/platform-observation/observation-scope-provider"
import { AdminConsoleScreen } from "../src/features/platform-observation/admin-console-screen"
import { AdminProductsScreen } from "../src/features/platform-observation/admin-products-screen"
import { observedConsole, observedOverview, observedProduct, observedScopes, WORKSPACE_B, STORE_B } from "../src/features/platform-observation/observation-fixtures"
import { route } from "../src/api/routes"

export function previewObservation(kind: string, fixture: HTMLElement) {
  const products = [observedProduct(), observedProduct(WORKSPACE_B, STORE_B)]
    .map((row) => ({ ...row, product: { ...row.product, image_url: null } }))
  const original = window.fetch
  window.fetch = async (input, init) => {
    const url = new URL(String(input), window.location.origin)
    if (!url.pathname.startsWith("/api/")) return original(input, init)
    if ((init?.method ?? "GET") !== "GET") throw new Error("Visual preview refuses every write")
    let response: unknown
    if (url.pathname === route("adminOpsScopes")) response = observedScopes()
    else if (url.pathname === route("adminOpsConsoleSnapshot")) response = observedConsole()
    else if (url.pathname === route("adminStoresProductsOverview")) response = observedOverview()
    else if (url.pathname === route("adminStoresProducts")) response = { items: products }
    else throw new Error("Visual preview refuses unknown API routes")
    return new Response(JSON.stringify({ data: response }), { headers: { "Content-Type": "application/json" } })
  }
  const root = createRoot(fixture, { onUncaughtError: (reason) => {
    document.querySelector("#results")!.textContent = "FAIL preview: " + String(reason)
  } })
  root.render(<ObservationScopeProvider enabled>
    {kind === "console" ? <AdminConsoleScreen onOpenProducts={() => undefined} /> : <AdminProductsScreen />}
  </ObservationScopeProvider>)
}
