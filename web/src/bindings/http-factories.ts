import { api } from "@/api/client"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"

export type Factory = components["schemas"]["Factory"]

export type FactoryDraft = Pick<Factory, "name" | "country" | "contact" | "internal_note" | "icon"> & { account_email?: string }

export const factoriesHttp = {
  list: () => api.get<{ factories: Factory[] }>(route("adminFactories")),
  create: (body: FactoryDraft) => api.post<{ factory: Factory; initial_password?: string }>(route("adminFactories"), body),
  update: (id: string, body: FactoryDraft) => api.put<{ factory: Factory }>(route("adminFactoriesByFactoryId", { factory_id: id }), body),
  delete: (id: string) => api.del(route("adminFactoriesByFactoryId", { factory_id: id })),
}
