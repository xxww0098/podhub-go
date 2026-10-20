/** Protocol aliases come only from the generated Cloud OpenAPI contract. */
import type { components } from "@/api/schema"
import type { StoreProductStatusFilter } from "@/features/products/products-api"

/** View/query state is distinct from the protocol and the real Active Workspace. */
export type ObservationScope = { workspaceId?: string; storeId?: string }
export type ObservationScopes = components["schemas"]["AdminObservationScopesData"]
export type ObservationLedger = components["schemas"]["AdminObservationLedgerSummary"]
export type ObservationConsole = components["schemas"]["AdminObservationConsoleData"]
export type ObservationProduct = components["schemas"]["AdminObservationProduct"]
export type ObservationProducts = components["schemas"]["AdminObservationProductsData"]
export type ObservationProductsQuery = ObservationScope & {
  status?: StoreProductStatusFilter
  q?: string
  includeGone?: boolean
  cursor?: string
  limit?: number
}
