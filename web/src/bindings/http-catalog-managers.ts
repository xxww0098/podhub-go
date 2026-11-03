import { api } from "@/api/client"
import { route } from "@/api/routes"

export type CatalogManager = {
  managerId: string
  sourceId: string
  userId: number
  email: string
  name: string
  status: string
  createdAtMs: number
  revokedAtMs?: number
}

const managersPath = (sourceId: string) => route("adminSupplierDbsBySourceIdCatalogManagers", { source_id: sourceId })

export const catalogManagersHttp = {
  list: (sourceId: string) => api.get<{ catalogManagers: CatalogManager[] }>(managersPath(sourceId)),
  grant: (sourceId: string, accountUuid: string) => api.post<{ catalogManager: CatalogManager }>(managersPath(sourceId), { account_uuid: accountUuid }),
  revoke: (sourceId: string, managerId: string) => api.del<{ revoked: boolean }>(route("adminSupplierDbsBySourceIdCatalogManagersByManagerId", { source_id: sourceId, manager_id: managerId })),
}
