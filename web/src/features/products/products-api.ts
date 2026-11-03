/**
 * Workspace products mirror — the Cloud read surface this screen speaks.
 *
 * Every call reads PostgreSQL only; `verifyStoreProducts` is the single
 * request that may reach Ozon (≤ 50 offer ids, deduplicated server-side).
 */
import { getBytes, request } from "@/api/client"
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

export async function exportFilteredProducts(query: Omit<ProductsListQuery, "cursor" | "limit">): Promise<Uint8Array<ArrayBuffer>> {
  const params = new URLSearchParams()
  if (query.storeId) params.set("storeId", query.storeId)
  if (query.status) params.set("status", query.status)
  if (query.q?.trim()) params.set("q", query.q.trim())
  if (query.includeGone) params.set("includeGone", "true")
  const suffix = params.size ? `?${params.toString()}` : ""
  return (await getBytes(`${route("workspacesProductsExport")}${suffix}`, 60_000)).bytes
}

export async function loadProductsOverview(): Promise<StoreProductsOverviewData> {
  return request<StoreProductsOverviewData>("GET", route("workspacesProductsOverview"), undefined, {}, undefined, undefined, { responseBody: "json" })
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
  return request<StoreProductsListData>("GET", `${route("workspacesProducts")}${suffix}`, undefined, {}, undefined, undefined, { responseBody: "json" })
}

export async function verifyStoreProducts(
  storeId: string,
  offerIds: string[],
): Promise<StoreProductRow[]> {
  const data = await request<components["schemas"]["StoreProductsVerifyData"]>(
    "POST",
    route("workspacesStoresByUuidProductsVerify", { uuid: storeId }),
    { offer_ids: offerIds }, {}, undefined, undefined, { responseBody: "json" },
  )
  return data.rows
}

export type StoreProductsSyncNowData =
  components["schemas"]["StoreProductsSyncNowData"]

/** 202 queues a sync or attaches to one in flight. 429 carries the unlock moment; 409 the hold. */
export async function syncNow(storeId: string): Promise<StoreProductsSyncNowData> {
  const response = await request<StoreProductsSyncNowData>(
    "POST",
    route("workspacesStoresByUuidProductsSync", { uuid: storeId }),
    {}, {}, undefined, undefined, { responseBody: "json" },
  )
  return response
}
