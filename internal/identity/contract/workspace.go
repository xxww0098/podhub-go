package contract

import "strings"

// WorkspaceRole uses the same three values as organization_members.role.
// Its zero value grants no access.
type WorkspaceRole string

const (
	WorkspaceOwner   WorkspaceRole = "owner"
	WorkspaceManager WorkspaceRole = "manager"
	WorkspaceMember  WorkspaceRole = "member"
)

func ParseWorkspace(raw string) (WorkspaceRole, bool) {
	role := WorkspaceRole(strings.ToLower(strings.TrimSpace(raw)))
	switch role {
	case WorkspaceOwner, WorkspaceManager, WorkspaceMember:
		return role, true
	default:
		return "", false
	}
}

func (r WorkspaceRole) CanManage() bool {
	return r == WorkspaceOwner || r == WorkspaceManager
}

func (r WorkspaceRole) MayInvite(target WorkspaceRole) bool {
	return (r.CanManage() && target == WorkspaceMember) || (r == WorkspaceOwner && target == WorkspaceManager)
}

func (r WorkspaceRole) MayRemoveMember(target WorkspaceRole, isSelf bool) bool {
	return !isSelf && r.MayInvite(target)
}

func (r WorkspaceRole) MayChangeRole(target WorkspaceRole, isSelf bool) bool {
	return r == WorkspaceOwner && !isSelf && (target == WorkspaceManager || target == WorkspaceMember)
}

func (r WorkspaceRole) AssignableRoles(target WorkspaceRole, isSelf bool) []string {
	if !r.MayChangeRole(target, isSelf) {
		return nil
	}
	if target == WorkspaceManager {
		return []string{string(WorkspaceMember)}
	}
	return []string{string(WorkspaceManager)}
}
