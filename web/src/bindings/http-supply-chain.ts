/**
 * Seller supply-chain HTTP: published 平台货盘 and 店铺注入.
 *
 * Screens import `supplyChainHttp`. Admin shipping-preset routes stay out.
 */
import { api } from "@/api/client"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"

export type SellerPlatformProduct = components["schemas"]["SellerPlatformProductData"]
export type SellerShippingReadiness = components["schemas"]["SellerShippingReadinessData"]

export async function listPlatformCatalog(): Promise<SellerPlatformProduct[]> {
  const data = await api.get<components["schemas"]["SellerPlatformCatalogData"]>(
    route("platformCatalog"),
  )
  return data.products
}

export async function getShippingReadiness(
  storeUuid: string,
  skuId: string,
): Promise<SellerShippingReadiness> {
  const query = new URLSearchParams({ skuId })
  const data = await api.get<components["schemas"]["SellerShippingReadinessViewData"]>(
    `${route("workspacesStoresByUuidShippingReadiness", { uuid: storeUuid })}?${query}`,
  )
  return data.readiness
}

export async function ensureShipping(
  storeUuid: string,
  skuId: string,
): Promise<SellerShippingReadiness> {
  const data = await api.post<components["schemas"]["SellerShippingEnsureViewData"]>(
    route("workspacesStoresByUuidShippingEnsure", { uuid: storeUuid }),
    { skuId },
  )
  return data.inject
}

export const supplyChainHttp = {
  listPlatformCatalog,
  getShippingReadiness,
  ensureShipping,
}
