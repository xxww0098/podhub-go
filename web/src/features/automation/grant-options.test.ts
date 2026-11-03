import assert from "node:assert/strict"
import test from "node:test"
import type { AccountOverview } from "@/bindings/commands"
import { availableGrantActions, availableGrantScopes, roleGrantScope } from "./grant-options"

function overview(role: string, workspaceRole?: string): AccountOverview {
  return { session: { authenticated: true, role }, ...(workspaceRole ? { active_workspace: { id: 1, role: workspaceRole } } : {}) } as AccountOverview
}

test("existing grants remain visible by role, but unavailable MCP methods cannot be granted", () => {
  assert.deepEqual(availableGrantScopes(overview("user")), ["catalog"])
  for (const role of ["admin", "super_admin"]) {
    assert.deepEqual(availableGrantScopes(overview(role)), ["catalog", "supplier_catalog"])
    assert.deepEqual(availableGrantActions("supplier_catalog", overview(role)), [])
  }
  for (const role of ["owner", "manager", " admin ", "user"]) {
    assert.deepEqual(availableGrantActions("supplier_catalog", overview(role)), [])
  }
  assert.deepEqual(availableGrantScopes(undefined), [])
  assert.deepEqual(availableGrantActions("catalog", overview("user")), [])
})

test("workspace exposes only the currently working MCP read permission", () => {
  assert.deepEqual(availableGrantActions("workspace", overview("super_admin")), [])
  for (const role of ["viewer", "operator", "unknown", "owner", "manager", "admin", "member", "reviewer"]) {
    assert.deepEqual(availableGrantActions("workspace", overview("user", role)), ["read"])
  }
})

test("the grant form uses a workspace even for platform staff", () => {
  assert.equal(roleGrantScope(undefined), null)
  assert.equal(roleGrantScope(overview("user")), null)
  assert.equal(roleGrantScope(overview("user", "owner")), "workspace")
  assert.deepEqual(availableGrantActions("workspace", overview("user", "owner")), ["read"])
  for (const role of ["admin", "super_admin"]) {
    assert.equal(roleGrantScope(overview(role, "owner")), "workspace")
  }
})
