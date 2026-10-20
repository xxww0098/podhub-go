import assert from "node:assert/strict"
import test from "node:test"

import {
  isPlatformStaffRole,
  isPlatformSuperAdminRole,
  platformRoleLabel,
  platformStaffRoleLabel,
} from "./platform-role"

test("isPlatformStaffRole matches exact admin and super_admin without trim elevation", () => {
  assert.equal(isPlatformStaffRole("admin"), true)
  assert.equal(isPlatformStaffRole("super_admin"), true)

  // Whitespace must never elevate permissions (no trim)
  assert.equal(isPlatformStaffRole(" admin "), false)
  assert.equal(isPlatformStaffRole(" super_admin "), false)
  assert.equal(isPlatformStaffRole("admin "), false)
  assert.equal(isPlatformStaffRole(" super_admin"), false)

  // Case sensitivity & non-staff roles
  assert.equal(isPlatformStaffRole("ADMIN"), false)
  assert.equal(isPlatformStaffRole("Admin"), false)
  assert.equal(isPlatformStaffRole("Super_Admin"), false)
  assert.equal(isPlatformStaffRole("SUPER_ADMIN"), false)
  assert.equal(isPlatformStaffRole("user"), false)
  assert.equal(isPlatformStaffRole("owner"), false)
  assert.equal(isPlatformStaffRole("manager"), false)
  assert.equal(isPlatformStaffRole(""), false)
  assert.equal(isPlatformStaffRole("   "), false)
  assert.equal(isPlatformStaffRole(null), false)
  assert.equal(isPlatformStaffRole(undefined), false)
})

test("isPlatformSuperAdminRole matches only exact super_admin", () => {
  assert.equal(isPlatformSuperAdminRole("super_admin"), true)

  assert.equal(isPlatformSuperAdminRole("admin"), false)
  assert.equal(isPlatformSuperAdminRole(" super_admin "), false)
  assert.equal(isPlatformSuperAdminRole("super_admin "), false)
  assert.equal(isPlatformSuperAdminRole("SUPER_ADMIN"), false)
  assert.equal(isPlatformSuperAdminRole("user"), false)
  assert.equal(isPlatformSuperAdminRole(""), false)
  assert.equal(isPlatformSuperAdminRole(null), false)
  assert.equal(isPlatformSuperAdminRole(undefined), false)
})

test("platformStaffRoleLabel derives labels from canonical map and returns undefined for unknown", () => {
  assert.equal(platformStaffRoleLabel("super_admin"), "超级管理员")
  assert.equal(platformStaffRoleLabel("admin"), "平台管理员")

  // Non-staff and untrimmed inputs stay unlabeled (undefined)
  assert.equal(platformStaffRoleLabel(" admin "), undefined)
  assert.equal(platformStaffRoleLabel(" super_admin "), undefined)
  assert.equal(platformStaffRoleLabel("ADMIN"), undefined)
  assert.equal(platformStaffRoleLabel("user"), undefined)
  assert.equal(platformStaffRoleLabel("owner"), undefined)
  assert.equal(platformStaffRoleLabel("unknown_role"), undefined)
  assert.equal(platformStaffRoleLabel(""), undefined)
  assert.equal(platformStaffRoleLabel("   "), undefined)
  assert.equal(platformStaffRoleLabel(null), undefined)
  assert.equal(platformStaffRoleLabel(undefined), undefined)
})

test("platformRoleLabel maps known roles, trims unknown strings, and maps null/undefined to empty string", () => {
  assert.equal(platformRoleLabel("super_admin"), "超级管理员")
  assert.equal(platformRoleLabel("admin"), "平台管理员")
  assert.equal(platformRoleLabel("user"), "用户")

  // Trimmed known roles
  assert.equal(platformRoleLabel(" super_admin "), "超级管理员")
  assert.equal(platformRoleLabel(" admin "), "平台管理员")
  assert.equal(platformRoleLabel(" user "), "用户")

  // Unknown role returns trimmed original string
  assert.equal(platformRoleLabel(" custom_role "), "custom_role")
  assert.equal(platformRoleLabel("operator"), "operator")

  // null and undefined map to empty string
  assert.equal(platformRoleLabel(null), "")
  assert.equal(platformRoleLabel(undefined), "")
  assert.equal(platformRoleLabel(""), "")
  assert.equal(platformRoleLabel("   "), "")
})
