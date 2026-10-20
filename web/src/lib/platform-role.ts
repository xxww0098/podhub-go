/**
 * One spelling of a platform role for the operator.
 *
 * Cloud sends `role_label` on admin rows but only the raw `role` on the
 * session, so the account screen printed `super_admin` beside the user screen's
 * 超级管理员. Both read this instead of each keeping a copy.
 */
const PLATFORM_ROLE_LABEL: Record<string, string> = {
  super_admin: "超级管理员",
  // 工作空间角色 manager 叫「主管」；平台这一档必须带前缀，且要和 Cloud
  // `role_label`（src/platform/admin/capability.rs）逐字一致。
  admin: "平台管理员",
  user: "用户",
}

/** Exact PlatformRole check for staff-only renderer surfaces. */
export function isPlatformStaffRole(
  role: string | null | undefined,
): role is "admin" | "super_admin" {
  return role === "admin" || role === "super_admin"
}

/** Exact gate for platform capabilities that must never be available to admin (SuperAdmin-only surfaces such as 兑换码). Rank is strict: only `super_admin`. */
export function isPlatformSuperAdminRole(
  role: string | null | undefined,
): role is "super_admin" {
  return role === "super_admin"
}

/** User-facing label for exact platform staff roles; unknown roles stay unlabeled. */
export function platformStaffRoleLabel(
  role: string | null | undefined,
): string | undefined {
  if (isPlatformStaffRole(role)) {
    return PLATFORM_ROLE_LABEL[role]
  }
  return undefined
}

export function platformRoleLabel(role: string | null | undefined): string {
  const value = role?.trim() ?? ""
  return PLATFORM_ROLE_LABEL[value] ?? value
}

/** Hairline chip matching UsersScreen PersonRow's platform-role cell. */
export const STAFF_RANK_CHIP_CLASS =
  "w-fit whitespace-nowrap rounded-md border border-border px-1.5 py-0.5 text-meta font-medium text-foreground"
