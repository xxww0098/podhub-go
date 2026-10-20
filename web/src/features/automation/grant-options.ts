import { isPlatformStaffRole } from "@/lib/platform-role"
import type { AccountOverview } from "@/bindings/commands"
import type { GrantScopeKind } from "@/bindings/http-automation-grants"

const ACTION_LABELS: Record<string, string> = {
  "catalog:read": "浏览公开货盘",
  read: "读取工作空间",
  "cards:write": "从货盘创建方案草稿",
  "supplier:read": "读取供应商资料",
  "supplier:write": "新增与修改资料",
  "supplier:delete": "删除资料",
  "supplier:publish": "发布与下架",
  "supplier:price": "设置平台价",
}
export function grantActionLabel(action: string): string { return ACTION_LABELS[action] ?? action }
export function availableGrantScopes(overview?: AccountOverview | null): GrantScopeKind[] {
  if (!overview?.session.authenticated) return []
  return ["catalog", ...(overview.active_workspace ? ["workspace" as const] : []), ...(isPlatformStaffRole(overview.session.role) ? ["supplier_catalog" as const] : [])]
}

/** One token stores one scope. The form does not ask which: platform staff
 * receive supplier authority, a workspace member receives that seat's
 * authority, and any other signed-in account can only read the public catalog. */
export function roleGrantScope(overview?: AccountOverview | null): GrantScopeKind | null {
  if (!overview?.session.authenticated) return null
  if (isPlatformStaffRole(overview.session.role)) return "supplier_catalog"
  if (overview.active_workspace) return "workspace"
  return "catalog"
}
export function availableGrantActions(scope: GrantScopeKind, overview?: AccountOverview | null): string[] {
  if (scope === "catalog") return ["catalog:read"]
  if (scope === "supplier_catalog") return isPlatformStaffRole(overview?.session.role) ? ["supplier:read", "supplier:write", "supplier:delete", "supplier:publish", "supplier:price"] : []
  if (!overview?.active_workspace) return []
  const role = overview.active_workspace.role
  const canPrepare = ["owner", "manager", "admin", "member", "reviewer"].includes(role)
  return ["read", "catalog:read", ...(canPrepare ? ["cards:write"] : [])]
}
export function defaultGrantActions(scope: GrantScopeKind): string[] {
  return scope === "workspace" ? ["read", "catalog:read"] : [scope === "catalog" ? "catalog:read" : "supplier:read"]
}
