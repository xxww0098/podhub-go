import assert from "node:assert/strict"
import test from "node:test"
import type { AccountOverview } from "@/bindings/commands"
import { availableGrantActions, availableGrantScopes, defaultGrantActions, roleGrantScope } from "./grant-options"

function overview(role: string, workspaceRole?: string): AccountOverview {
  return { session: { authenticated: true, role }, ...(workspaceRole ? { active_workspace: { id: 1, role: workspaceRole } } : {}) } as AccountOverview
}

test("catalog authorization is available without a workspace; supplier delegation needs an exact staff role", () => {
  assert.deepEqual(availableGrantScopes(overview("user")), ["catalog"])
  for (const role of ["admin", "super_admin"]) {
    assert.deepEqual(availableGrantScopes(overview(role)), ["catalog", "supplier_catalog"])
    assert.ok(availableGrantActions("supplier_catalog", overview(role)).includes("supplier:delete"))
  }
  for (const role of ["owner", "manager", " admin ", "user"]) {
    assert.deepEqual(availableGrantActions("supplier_catalog", overview(role)), [])
  }
  assert.deepEqual(availableGrantScopes(undefined), [])
})

test("workspace draft permissions mirror the server's stored-role vocabulary and default to reads", () => {
  assert.deepEqual(availableGrantActions("workspace", overview("super_admin")), [])
  for (const role of ["viewer", "operator", "unknown"]) {
    assert.deepEqual(availableGrantActions("workspace", overview("admin", role)), ["read", "catalog:read"])
  }
  for (const role of ["owner", "manager", "admin", "member", "reviewer"]) {
    assert.ok(availableGrantActions("workspace", overview("user", role)).includes("cards:write"))
  }
  assert.deepEqual(defaultGrantActions("workspace"), ["read", "catalog:read"])
  assert.deepEqual(defaultGrantActions("supplier_catalog"), ["supplier:read"])
})

test("the grant form follows role instead of asking for a scope", () => {
  assert.equal(roleGrantScope(undefined), null)
  assert.equal(roleGrantScope(overview("user")), "catalog")
  assert.equal(roleGrantScope(overview("user", "owner")), "workspace")
  assert.deepEqual(availableGrantActions("workspace", overview("user", "owner")), ["read", "catalog:read", "cards:write"])
  for (const role of ["admin", "super_admin"]) {
    assert.equal(roleGrantScope(overview(role, "owner")), "supplier_catalog")
    assert.deepEqual(availableGrantActions("supplier_catalog", overview(role, "owner")), ["supplier:read", "supplier:write", "supplier:delete", "supplier:publish", "supplier:price"])
  }
})
