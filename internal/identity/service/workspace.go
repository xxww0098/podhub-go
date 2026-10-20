package service

import "strings"

// WorkspaceID is the numeric workspace identity. The column remains org_id.
type WorkspaceID int64

func (id WorkspaceID) Active() bool { return id > 0 }

// WorkspaceRole is the authorization vocabulary. member is stored as operator.
type WorkspaceRole int

const (
	WorkspaceOwner WorkspaceRole = iota
	WorkspaceManager
	WorkspaceOperator
	WorkspaceReviewer
	WorkspaceViewer
)

// ParseWorkspaceRole is strict. Unknown roles are not viewers.
func ParseWorkspaceRole(raw string) (WorkspaceRole, bool) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "owner":
		return WorkspaceOwner, true
	case "manager", "admin":
		return WorkspaceManager, true
	case "member":
		return WorkspaceOperator, true
	case "reviewer":
		return WorkspaceReviewer, true
	case "viewer":
		return WorkspaceViewer, true
	default:
		return 0, false
	}
}

// WorkspaceRoleFromStored is the display fallback. Authorization uses ParseWorkspaceRole.
func WorkspaceRoleFromStored(raw string) WorkspaceRole {
	role, ok := ParseWorkspaceRole(raw)
	if !ok {
		return WorkspaceViewer
	}
	return role
}

func (r WorkspaceRole) Stored() string {
	switch r {
	case WorkspaceOwner:
		return "owner"
	case WorkspaceManager:
		return "manager"
	case WorkspaceOperator:
		return "member"
	case WorkspaceReviewer:
		return "reviewer"
	default:
		return "viewer"
	}
}

func (r WorkspaceRole) CanManage() bool {
	return r == WorkspaceOwner || r == WorkspaceManager
}

// Capability is one fixed workspace permission.
type Capability int

const (
	CapWorkspaceRead Capability = iota
	CapWorkspaceManage
	CapWorkspaceProfileManage
	CapWorkspaceDissolve
	CapWorkspaceLeave
	CapMemberInvite
	CapMemberManage
	CapBillingRead
	CapBillingManage
	CapUsageRead
	CapBudgetManage
	CapStoreRead
	CapStoreManage
	CapStoreCredentialRotate
	CapPresetRead
	CapPresetManage
	CapListingPrepare
	CapListingReview
	CapListingPublish
	CapListingSubmit
	CapListingReconcile
	CapGalleryRead
	CapGalleryWrite
	CapGalleryDelete
	CapAiUse
	CapOcrUse
	CapAuditRead
	CapAuditExport
	CapWarehouseWrite
)

// AllCapabilities is the matrix the tests walk.
var AllCapabilities = []Capability{
	CapWorkspaceRead, CapWorkspaceManage, CapWorkspaceProfileManage, CapWorkspaceDissolve,
	CapWorkspaceLeave, CapMemberInvite, CapMemberManage, CapBillingRead, CapBillingManage,
	CapUsageRead, CapBudgetManage, CapStoreRead, CapStoreManage, CapStoreCredentialRotate,
	CapPresetRead, CapPresetManage, CapListingPrepare, CapListingReview, CapListingPublish,
	CapListingSubmit, CapListingReconcile, CapGalleryRead, CapGalleryWrite, CapGalleryDelete,
	CapAiUse, CapOcrUse, CapAuditRead, CapAuditExport, CapWarehouseWrite,
}

func (r WorkspaceRole) Allows(capability Capability) bool {
	switch capability {
	case CapWorkspaceRead, CapStoreRead, CapPresetRead, CapUsageRead, CapAiUse, CapOcrUse, CapGalleryRead:
		return true
	case CapListingPrepare, CapListingReconcile, CapGalleryWrite, CapListingReview:
		return r != WorkspaceViewer
	case CapListingPublish, CapListingSubmit:
		return r == WorkspaceOwner || r == WorkspaceManager || r == WorkspaceOperator
	case CapWorkspaceManage, CapMemberInvite, CapMemberManage, CapStoreManage, CapPresetManage, CapAuditRead, CapGalleryDelete, CapWarehouseWrite:
		return r.CanManage()
	case CapStoreCredentialRotate, CapBillingRead, CapBillingManage, CapBudgetManage, CapAuditExport, CapWorkspaceProfileManage, CapWorkspaceDissolve:
		return r == WorkspaceOwner
	case CapWorkspaceLeave:
		return r != WorkspaceOwner
	default:
		return false
	}
}

func (r WorkspaceRole) MayInvite(target WorkspaceRole) bool {
	if !r.Allows(CapMemberInvite) {
		return false
	}
	switch target {
	case WorkspaceOperator:
		return true
	case WorkspaceManager:
		return r == WorkspaceOwner
	default:
		return false
	}
}

func (r WorkspaceRole) MayRemoveMember(target WorkspaceRole, isSelf bool) bool {
	if isSelf || target == WorkspaceOwner || !r.Allows(CapMemberManage) {
		return false
	}
	if r == WorkspaceManager {
		return target == WorkspaceOperator
	}
	return true
}

func (r WorkspaceRole) MayChangeRole(target WorkspaceRole, isSelf bool) bool {
	return r == WorkspaceOwner && !isSelf && (target == WorkspaceManager || target == WorkspaceOperator)
}

func (r WorkspaceRole) AssignableRoles(target WorkspaceRole, isSelf bool) []string {
	if !r.MayChangeRole(target, isSelf) {
		return nil
	}
	switch target {
	case WorkspaceManager:
		return []string{WorkspaceOperator.Stored()}
	case WorkspaceOperator:
		return []string{WorkspaceManager.Stored()}
	default:
		return nil
	}
}

// CanManageStored matches owner, manager, and the legacy admin alias.
func CanManageStored(role string) bool {
	return WorkspaceRoleFromStored(role).CanManage()
}

// StoreVisible reports whether the actor sees a store.
// Unknown stored roles see nothing. An unassigned store is invisible to an operator.
func StoreVisible(role string, assigneeMembershipID *int64, actorMembershipID int64) bool {
	parsed, ok := ParseWorkspaceRole(role)
	if !ok {
		return false
	}
	if parsed.CanManage() {
		return true
	}
	return assigneeMembershipID != nil && *assigneeMembershipID == actorMembershipID
}

// AssigneeKeyGrant is the per-store switch for the current assignee.
type AssigneeKeyGrant struct{ Manage bool }

func (g AssigneeKeyGrant) MayManageKey(isOwner, isAssignee bool) bool {
	return isOwner || (isAssignee && g.Manage)
}

// MembershipDirectoryStatus projects a roster row.
// manual_disabled wins over quota_suspended.
func MembershipDirectoryStatus(status string, manualDisabled, quotaSuspended bool) string {
	if status != "active" || manualDisabled {
		return "manual_disabled"
	}
	if quotaSuspended {
		return "quota_suspended"
	}
	return "active"
}

// PendingInviteLimit is max(10, max(1, seats)*2).
func PendingInviteLimit(seats int64) int64 {
	if seats < 1 {
		seats = 1
	}
	n := seats * 2
	if n < 10 {
		return 10
	}
	return n
}
