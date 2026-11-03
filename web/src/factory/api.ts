import { api, request } from "@/api/client"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"
import { startPresignedDownload } from "@/bindings/object-download"

export type FactoryOrderView = "pending" | "producing" | "urgent" | "shipped"

export type FactoryMe = components["schemas"]["SupplierMeData"]
export type FactoryDispatchDetail = components["schemas"]["SupplierDispatchDetail"]
export type FactoryDispatchList = components["schemas"]["SupplierDispatchListData"]
export type FactoryDashboardData = components["schemas"]["SupplierDashboardData"]

export function getFactoryMe(): Promise<FactoryMe> {
  return api.get(route("supplierMe"))
}

export function getFactoryDashboard(source_id: string): Promise<FactoryDashboardData> {
  return api.get(route("supplierWorkspacesBySourceIdDashboard", { source_id: source_id }))
}

export function listFactoryDispatches(
  source_id: string,
  options: { view: FactoryOrderView; search?: string; cursor?: string; status?: string; reason?: string },
): Promise<FactoryDispatchList> {
  const params = new URLSearchParams({ view: options.view })
  if (options.search?.trim()) params.set("search", options.search.trim())
  if (options.cursor) params.set("cursor", options.cursor)
  if (options.status && options.status !== "all") params.set("status", options.status)
  if (options.reason && options.reason !== "all") params.set("reason", options.reason)
  return api.get(route("supplierWorkspacesBySourceIdDispatches", { source_id: source_id }) + "?" + params)
}

export async function getFactoryDispatch(dispatch_id: string): Promise<FactoryDispatchDetail> {
  const data = await api.get<{ dispatch: FactoryDispatchDetail }>(
    route("supplierDispatchesByDispatchId", { dispatch_id: dispatch_id }),
  )
  return data.dispatch
}

export function acceptFactoryDispatch(dispatch_id: string): Promise<components["schemas"]["SupplierActionData"]> {
  return api.post(route("supplierDispatchesByDispatchIdAccept", { dispatch_id: dispatch_id }))
}

export function rejectFactoryDispatch(dispatch_id: string, reason: string): Promise<components["schemas"]["SupplierActionData"]> {
  return api.post(route("supplierDispatchesByDispatchIdReject", { dispatch_id: dispatch_id }), { reason })
}

export function factoryAssetUrl(dispatch_id: string, asset_id: string): string {
  return route("supplierDispatchesByDispatchIdAssetsByAssetId", {
    dispatch_id,
    asset_id,
  })
}

export async function downloadFactoryAsset(dispatch_id: string, asset_id: string): Promise<void> {
  const grant = await request<components["schemas"]["SupplierDownloadGrant"]>(
    "GET", factoryAssetUrl(dispatch_id, asset_id), undefined, { Accept: "application/json" }, 30_000,
  )
  startPresignedDownload(grant)
}
