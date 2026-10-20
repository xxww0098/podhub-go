/** Session-authenticated credential management. Tokens return only on create. */
import { request } from "@/api/client"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"

export type GrantScopeKind = "catalog" | "workspace" | "supplier_catalog"
export type AutomationGrant = Omit<
  components["schemas"]["AutomationGrantView"] | components["schemas"]["ScopedAutomationGrantView"],
  "scope_kind" | "source_ids" | "expires_at_ms" | "last_used_at_ms" | "revoked_at_ms"
> & {
  expiresAtMs?: number | null
  lastUsedAtMs?: number | null
  revokedAtMs?: number | null
  scopeKind: GrantScopeKind
  sourceIds: string[] | null
}
export type GrantInput = {
  name: string
  actions: string[]
  expiresInDays: number
  sourceIds?: string[] | null
}

function collection(scope: GrantScopeKind): string {
  if (scope === "workspace") return route("automationGrants")
  if (scope === "catalog") return route("meCatalogAutomationGrants")
  return route("adminSupplierAutomationGrants")
}
function project(row: components["schemas"]["AutomationGrantView"] | components["schemas"]["ScopedAutomationGrantView"], scope: GrantScopeKind): AutomationGrant {
  return { ...row, scopeKind: scope, sourceIds: "source_ids" in row ? row.source_ids ?? null : null }
}

export async function listAutomationGrants(scope: GrantScopeKind, signal?: AbortSignal): Promise<AutomationGrant[]> {
  const data = await request<components["schemas"]["AutomationGrantsData"] | components["schemas"]["ScopedAutomationGrantsData"]>("GET", collection(scope), undefined, {}, 10_000, undefined, { callerSignal: signal, reportOwner: "caller" })
  return data.grants.map((row) => project(row, scope))
}
export async function createAutomationGrant(scope: GrantScopeKind, input: GrantInput): Promise<{ grant: AutomationGrant; token: string }> {
  const body = { name: input.name, actions: input.actions, expiresInDays: input.expiresInDays, ...(scope === "supplier_catalog" ? { sourceIds: input.sourceIds === undefined ? [] : input.sourceIds } : {}) }
  const data = await request<components["schemas"]["CreateAutomationGrantData"] | components["schemas"]["CreateScopedAutomationGrantData"]>("POST", collection(scope), body, {}, 15_000, undefined, { reportOwner: "caller" })
  return { grant: project(data.grant, scope), token: data.token }
}
export async function revokeAutomationGrant(scope: GrantScopeKind, id: string): Promise<void> {
  const path = scope === "workspace" ? route("automationGrantsByIdRevoke", { id }) : scope === "catalog" ? route("meCatalogAutomationGrantsByIdRevoke", { id }) : route("adminSupplierAutomationGrantsByIdRevoke", { id })
  await request<components["schemas"]["AutomationGrantRevokeData"]>("POST", path, undefined, {}, 15_000, undefined, { reportOwner: "caller" })
}
