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

/** Only workspace reads have a working MCP execution path. Other scopes remain
 * visible in the list so their existing grants can be revoked. */
export function roleGrantScope(overview?: AccountOverview | null): GrantScopeKind | null {
  return overview?.session.authenticated && overview.active_workspace ? "workspace" : null
}
export function availableGrantActions(scope: GrantScopeKind, overview?: AccountOverview | null): string[] {
  return scope === "workspace" && overview?.active_workspace ? ["read"] : []
}
