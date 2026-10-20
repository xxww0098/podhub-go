import type { ObservationProduct, ObservationScope } from "./observation-types"

/** Explicit unknown scopes stay explicit: only the server may refuse them. */
export function observationScopeFromSearch(search: string): ObservationScope {
  const params = new URLSearchParams(search)
  return {
    workspaceId: params.get("workspaceId")?.trim() || undefined,
    storeId: params.get("storeId")?.trim() || undefined,
  }
}

export function observationScopeKey(scope: ObservationScope): string {
  return JSON.stringify([scope.workspaceId ?? null, scope.storeId ?? null])
}

/** Both observation screens own these URL keys; ActiveWorkspace is untouched. */
export function withObservationScope(search: string, scope: ObservationScope): string {
  const params = new URLSearchParams(search)
  for (const key of ["workspaceId", "storeId"] as const) {
    if (scope[key]) params.set(key, scope[key]!)
    else params.delete(key)
  }
  const query = params.toString()
  return query ? "?" + query : ""
}

/** Composite identity must never depend on a display name, SKU or offer alone. */
export function observationProductKey(item: ObservationProduct): string {
  return JSON.stringify([item.workspace_id, item.product.store_id, item.product.product_id])
}

export function mergeObservationProducts(current: ObservationProduct[], incoming: ObservationProduct[]): ObservationProduct[] {
  const rows = new Map(current.map((item) => [observationProductKey(item), item]))
  for (const item of incoming) rows.set(observationProductKey(item), item)
  return [...rows.values()]
}
