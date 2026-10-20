package identity

import (
	iddomain "github.com/xxww0098/podhub-go/internal/identity/domain"
	idservice "github.com/xxww0098/podhub-go/internal/identity/service"
)

// Re-exports of the role, permission, and workspace names from identity/domain
// and identity/service. Call sites inside this package, and importers that are
// not allowed to name identity/service, use these names.

type (
	Role               = iddomain.Role
	Change             = iddomain.Change
	Deny               = iddomain.Deny
	PlatformPermission = iddomain.PlatformPermission

	WorkspaceID      = idservice.WorkspaceID
	WorkspaceRole    = idservice.WorkspaceRole
	Capability       = idservice.Capability
	AssigneeKeyGrant = idservice.AssigneeKeyGrant
)

const (
	RoleUser       = iddomain.RoleUser
	RoleAdmin      = iddomain.RoleAdmin
	RoleSuperAdmin = iddomain.RoleSuperAdmin

	DenyCannotAssign   = iddomain.DenyCannotAssign
	DenyCannotMutate   = iddomain.DenyCannotMutate
	DenyLastSuperAdmin = iddomain.DenyLastSuperAdmin

	PermManagePlatform            = iddomain.PermManagePlatform
	PermManageSupplierCatalog     = iddomain.PermManageSupplierCatalog
	PermManageDelegateOrders      = iddomain.PermManageDelegateOrders
	PermManageSupplierAccounts    = iddomain.PermManageSupplierAccounts
	PermManageSupplierWithdrawals = iddomain.PermManageSupplierWithdrawals
	PermObserveTenantBusiness     = iddomain.PermObserveTenantBusiness

	WorkspaceOwner    = idservice.WorkspaceOwner
	WorkspaceManager  = idservice.WorkspaceManager
	WorkspaceOperator = idservice.WorkspaceOperator
	WorkspaceReviewer = idservice.WorkspaceReviewer
	WorkspaceViewer   = idservice.WorkspaceViewer

	CapWorkspaceRead          = idservice.CapWorkspaceRead
	CapWorkspaceManage        = idservice.CapWorkspaceManage
	CapWorkspaceProfileManage = idservice.CapWorkspaceProfileManage
	CapWorkspaceDissolve      = idservice.CapWorkspaceDissolve
	CapWorkspaceLeave         = idservice.CapWorkspaceLeave
	CapMemberInvite           = idservice.CapMemberInvite
	CapMemberManage           = idservice.CapMemberManage
	CapBillingRead            = idservice.CapBillingRead
	CapBillingManage          = idservice.CapBillingManage
	CapUsageRead              = idservice.CapUsageRead
	CapBudgetManage           = idservice.CapBudgetManage
	CapStoreRead              = idservice.CapStoreRead
	CapStoreManage            = idservice.CapStoreManage
	CapStoreCredentialRotate  = idservice.CapStoreCredentialRotate
	CapPresetRead             = idservice.CapPresetRead
	CapPresetManage           = idservice.CapPresetManage
	CapListingPrepare         = idservice.CapListingPrepare
	CapListingReview          = idservice.CapListingReview
	CapListingPublish         = idservice.CapListingPublish
	CapListingSubmit          = idservice.CapListingSubmit
	CapListingReconcile       = idservice.CapListingReconcile
	CapGalleryRead            = idservice.CapGalleryRead
	CapGalleryWrite           = idservice.CapGalleryWrite
	CapGalleryDelete          = idservice.CapGalleryDelete
	CapAiUse                  = idservice.CapAiUse
	CapOcrUse                 = idservice.CapOcrUse
	CapAuditRead              = idservice.CapAuditRead
	CapAuditExport            = idservice.CapAuditExport
	CapWarehouseWrite         = idservice.CapWarehouseWrite
)

var (
	PlatformPermissions = iddomain.PlatformPermissions
	AllCapabilities     = idservice.AllCapabilities
)

func ParseRole(raw string) (Role, error) { return iddomain.ParseRole(raw) }

func RoleFromStored(raw string) Role { return iddomain.RoleFromStored(raw) }

func Authorize(actor Role, change Change, target Role, lastActiveSuperAdmin bool) error {
	return iddomain.Authorize(actor, change, target, lastActiveSuperAdmin)
}

func AuthorizeUpdate(actor, target, newRole Role, leavingActive, lastActiveSuperAdmin bool) error {
	return iddomain.AuthorizeUpdate(actor, target, newRole, leavingActive, lastActiveSuperAdmin)
}

func CanAssign(actor, role Role) bool { return iddomain.CanAssign(actor, role) }

func ParseWorkspaceRole(raw string) (WorkspaceRole, bool) {
	return idservice.ParseWorkspaceRole(raw)
}

func WorkspaceRoleFromStored(raw string) WorkspaceRole {
	return idservice.WorkspaceRoleFromStored(raw)
}

func CanManageStored(role string) bool { return idservice.CanManageStored(role) }

func StoreVisible(role string, assigneeMembershipID *int64, actorMembershipID int64) bool {
	return idservice.StoreVisible(role, assigneeMembershipID, actorMembershipID)
}

func MembershipDirectoryStatus(status string, manualDisabled, quotaSuspended bool) string {
	return idservice.MembershipDirectoryStatus(status, manualDisabled, quotaSuspended)
}

func PendingInviteLimit(seats int64) int64 { return idservice.PendingInviteLimit(seats) }
