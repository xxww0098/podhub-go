import type {
  AdminDirectoryPersonView,
  AdminDirectoryWorkspaceView,
  AdminUsersOverview,
} from "@/bindings/commands"

export type AccountStatus = "active" | "disabled"
export type DirectoryFilter = "all" | AccountStatus | "unaffiliated" | "privileged"

export type DirectoryMemberRow = {
  person: AdminDirectoryPersonView
  workspace: AdminDirectoryWorkspaceView | null
}

export function asAccountStatus(
  person: Pick<AdminDirectoryPersonView, "disabled" | "status">,
): AccountStatus {
  return person.disabled || person.status === "disabled" ? "disabled" : "active"
}

/** One member row per seat. Unaffiliated people have `workspace: null`. */
export function flattenDirectoryMembers(
  overview: Pick<AdminUsersOverview, "workspaces" | "unaffiliated"> | undefined,
): DirectoryMemberRow[] {
  if (!overview) return []
  const rows: DirectoryMemberRow[] = []
  for (const workspace of overview.workspaces) {
    for (const member of workspace.members) {
      rows.push({ person: member, workspace })
    }
  }
  for (const person of overview.unaffiliated) {
    rows.push({ person, workspace: null })
  }
  return rows
}

export function directoryMemberMatches(
  row: DirectoryMemberRow,
  query: string,
  statusFilter: DirectoryFilter,
): boolean {
  const needle = query.trim().toLocaleLowerCase()
  const status = asAccountStatus(row.person)
  const haystack = [
    row.person.name,
    row.person.email,
    row.person.uuid,
    row.workspace?.name ?? "",
    row.workspace?.uuid ?? "",
    row.workspace?.plan ?? "",
  ]
    .join(" ")
    .toLocaleLowerCase()
  if (needle && !haystack.includes(needle)) return false
  if (statusFilter === "unaffiliated") return row.workspace == null
  if (statusFilter === "privileged") {
    return (
      row.person.is_admin ||
      row.person.role === "admin" ||
      row.person.role === "super_admin"
    )
  }
  if (statusFilter === "all") return true
  return status === statusFilter
}

export function filterDirectoryMembers(
  rows: readonly DirectoryMemberRow[],
  query: string,
  statusFilter: DirectoryFilter,
): DirectoryMemberRow[] {
  return rows.filter((row) => directoryMemberMatches(row, query, statusFilter))
}
