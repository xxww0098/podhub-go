/** Client-side account validation and changed-field writes; Cloud rechecks authorization. */
import type { components } from "@/api/schema"

import { refuse } from "./refusal"

/** PlatformRole rank. `super_admin` is created only by `admin init` and never assignable. */
export type PlatformRole = "user" | "admin" | "super_admin"

type DirectoryPerson = components["schemas"]["AdminDirectoryPersonView"]

/** One field write: the path segment under `/api/admin/users/{uuid}/` and its body. */
export type AdminUserWrite = {
  segment: "admin" | "status"
  body: Record<string, string | boolean>
}

/** Parse a requested role. Empty / unknown is a validation refusal (write path). */
export function parseRole(raw: string): PlatformRole {
  const value = raw.trim().toLowerCase()
  if (value === "user" || value === "admin" || value === "super_admin") return value
  throw refuse("admin_role_invalid", "角色无效")
}

/** Column → rank. Empty and unknown collapse to `user` so they never pass a staff gate. */
export function roleFromStored(raw: string | null | undefined): PlatformRole {
  const value = (raw ?? "").trim().toLowerCase()
  return value === "admin" || value === "super_admin" ? value : "user"
}

/** Nobody assigns `super_admin`; an admin may only ever mint plain users. */
export function canAssign(actor: PlatformRole, role: PlatformRole): boolean {
  if (role === "super_admin") return false
  if (actor === "super_admin") return true
  return actor === "admin" && role === "user"
}

/** A SuperAdmin mutates anyone; an admin only plain users. */
export function canMutate(actor: PlatformRole, target: PlatformRole): boolean {
  if (actor === "super_admin") return true
  return actor === "admin" && target === "user"
}

/** Find the edited account anywhere in the directory — nested under a Workspace or unaffiliated. */
export function findDirectoryPerson(
  directory: components["schemas"]["AdminAccountsData"],
  uuid: string,
): DirectoryPerson {
  const person = directory.workspaces
    .flatMap((workspace) => workspace.members)
    .concat(directory.unaffiliated)
    .find((row) => row.uuid === uuid)
  if (!person) throw refuse("admin_account_missing", "账户不存在")
  return person
}

/** The ordered field writes an account edit still has to make. */
export function planUserUpdate(
  actor: PlatformRole,
  current: DirectoryPerson,
  request: { role?: string, enabled?: boolean },
): AdminUserWrite[] {
  const writes: AdminUserWrite[] = []
  if (request.role !== undefined) {
    const next = parseRole(request.role)
    const currentRole = roleFromStored(current.role)
    if (next !== currentRole) {
      if (!canAssign(actor, next) || !canMutate(actor, currentRole)) {
        throw refuse("admin_role_forbidden", "无权分配该角色")
      }
      writes.push({ segment: "admin", body: { role: next } })
    }
  }
  if (request.enabled !== undefined && request.enabled === current.disabled) {
    writes.push({ segment: "status", body: { enabled: request.enabled } })
  }
  return writes
}

/** Validate a create request and answer with the body `POST /api/admin/users` takes. */
export function planUserCreate(
  actor: PlatformRole,
  request: { email: string, password: string, name?: string, role: string },
): components["schemas"]["AdminCreateAccountRequest"] {
  const email = request.email.trim().toLowerCase()
  const password = request.password.trim()
  if (email.length === 0) throw refuse("admin_email_invalid", "邮箱不能为空")
  if ([...password].length < 8) throw refuse("admin_password_invalid", "密码至少 8 位")
  const requested = parseRole(request.role)
  if (!canAssign(actor, requested)) throw refuse("admin_role_forbidden", "无权分配该角色")
  const name = request.name?.trim()
  return { email, password, role: requested, ...(name ? { name } : {}) }
}
