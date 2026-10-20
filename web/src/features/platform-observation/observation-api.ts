/** The observation adapter has only GETs, never Workspace or Seller adapters. */
import { api } from "@/api/client"
import { route } from "@/api/routes"
import type { StoreProductsOverviewData } from "@/features/products/products-api"
import type {
  ObservationConsole, ObservationProducts, ObservationProductsQuery,
  ObservationScope, ObservationScopes,
} from "./observation-types"

export function observationQuery(scope: ObservationScope): URLSearchParams {
  const params = new URLSearchParams()
  if (scope.workspaceId) params.set("workspaceId", scope.workspaceId)
  if (scope.storeId) params.set("storeId", scope.storeId)
  return params
}

function suffix(params: URLSearchParams): string {
  return params.size ? "?" + params.toString() : ""
}

export const observationApi = {
  scopes: () => api.get<ObservationScopes>(route("adminOpsScopes")),
  console: (scope: ObservationScope) =>
    api.get<ObservationConsole>(route("adminOpsConsoleSnapshot") + suffix(observationQuery(scope))),
  overview: (scope: ObservationScope) =>
    api.get<StoreProductsOverviewData>(route("adminStoresProductsOverview") + suffix(observationQuery(scope))),
  products: (query: ObservationProductsQuery) => {
    const params = observationQuery(query)
    if (query.status) params.set("status", query.status)
    if (query.q?.trim()) params.set("q", query.q.trim())
    if (query.includeGone) params.set("includeGone", "true")
    if (query.cursor) params.set("cursor", query.cursor)
    params.set("limit", String(Math.min(200, Math.max(1, query.limit ?? 100))))
    return api.get<ObservationProducts>(route("adminStoresProducts") + suffix(params))
  },
}
