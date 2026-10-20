/**
 * Public website catalog HTTP: anonymous read of the published 平台货盘.
 *
 * No session is required or consulted. The public DTO carries no price,
 * prompt, or supply-side fields — prices stay behind the signed-in workbench.
 */
import { api } from "@/api/client"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"

export type PublicPlatformProduct = components["schemas"]["PublicPlatformProductData"]

export async function listPublicPlatformCatalog(): Promise<PublicPlatformProduct[]> {
  const data = await api.get<components["schemas"]["PublicPlatformCatalogData"]>(
    route("publicPlatformCatalog"),
  )
  return data.products
}
