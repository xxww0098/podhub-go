/**
 * Workspace products mirror — the Cloud read surface this screen speaks.
 *
 * Every call reads PostgreSQL only; `verifyStoreProducts` is the single
 * request that may reach Ozon (≤ 50 offer ids, deduplicated server-side).
 */
import { api } from "@/api/client"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"

export type StoreProductsOverviewData =
  components["schemas"]["StoreProductsOverviewData"]
export type StoreProductOverviewRow =
  components["schemas"]["StoreProductOverviewRow"]
export type StoreProductRow = components["schemas"]["StoreProductRow"]
export type StoreProductMetrics = components["schemas"]["StoreProductMetrics"]
export type StoreProductsListData =
  components["schemas"]["StoreProductsListData"]
export type StoreProductStatusFilter =
  components["schemas"]["StoreProductStatusFilter"]

export type ProductsListQuery = {
  storeId?: string
  status?: StoreProductStatusFilter
  q?: string
  includeGone?: boolean
  cursor?: string
  limit?: number
}

export async function loadProductsOverview(): Promise<StoreProductsOverviewData> {
  return api.get<StoreProductsOverviewData>(route("workspacesProductsOverview"))
}

export async function loadProducts(
  query: ProductsListQuery,
): Promise<StoreProductsListData> {
  const params = new URLSearchParams()
  if (query.storeId) params.set("storeId", query.storeId)
  if (query.status) params.set("status", query.status)
  if (query.q?.trim()) params.set("q", query.q.trim())
  if (query.includeGone) params.set("includeGone", "true")
  if (query.cursor) params.set("cursor", query.cursor)
  if (query.limit !== undefined) params.set("limit", String(query.limit))
  const suffix = params.size ? `?${params.toString()}` : ""
  return api.get<StoreProductsListData>(`${route("workspacesProducts")}${suffix}`)
}

export async function verifyStoreProducts(
  storeId: string,
  offerIds: string[],
): Promise<StoreProductRow[]> {
  const data = await api.post<components["schemas"]["StoreProductsVerifyData"]>(
    route("workspacesStoresByUuidProductsVerify", { uuid: storeId }),
    { offerIds },
  )
  return data.rows
}

export type StoreProductsSyncNowData =
  components["schemas"]["StoreProductsSyncNowData"]

/** 202 queues a sync or attaches to one in flight. 429 carries the unlock moment; 409 the hold. */
export async function syncNow(storeId: string): Promise<StoreProductsSyncNowData> {
  const response = await api.post<StoreProductsSyncNowData>(
    route("workspacesStoresByUuidProductsSync", { uuid: storeId }),
    {},
  )
  return response
}
