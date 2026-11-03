import { api } from "@/api/client"
import { route } from "@/api/routes"

export type SourceFulfiller = {
  fulfillerId: string
  sourceId: string
  userId: number
  email: string
  name: string
  status: string
  createdAtMs: number
  revokedAtMs?: number
}

const path = (sourceId: string) => route("adminSupplierDbsBySourceIdFulfillers", { source_id: sourceId })

export const sourceFulfillersHttp = {
  list: (sourceId: string) => api.get<{ fulfillers: SourceFulfiller[] }>(path(sourceId)),
  grant: (sourceId: string, accountUuid: string) => api.post<{ fulfiller: SourceFulfiller }>(path(sourceId), { account_uuid: accountUuid }),
  revoke: (sourceId: string, fulfillerId: string) => api.del<{ revoked: boolean }>(route("adminSupplierDbsBySourceIdFulfillersByFulfillerId", { source_id: sourceId, fulfiller_id: fulfillerId })),
}
