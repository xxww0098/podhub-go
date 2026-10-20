// Package access is the seam PR-1 fills in. It does not read cookies, sessions,
// or TOTP. Callers pass a Principal, or a Refusal when step-up or login failed.
package contract

import (
	"net/http"
	"strings"
)

const (
	// MsgUnauthenticated is authenticated()'s missing-session body.
	MsgUnauthenticated = "未登录"
	// MsgNoWorkspace is identity::NO_ACTIVE_WORKSPACE.
	MsgNoWorkspace = "当前账号尚未加入任何工作空间，请先创建工作空间，或等待他人邀请后在通知中接受"
	// MsgBadWorkspaceRole is require_tenant's unknown stored role.
	MsgBadWorkspaceRole = "工作空间角色无效"
	// MsgListingForbidden is require_listing's capability refusal.
	MsgListingForbidden = "当前角色无权执行此操作"
	// MsgSuperAdmin is PlatformPermission::ManagePlatform.
	MsgSuperAdmin = "需要超级管理员权限"
	// MsgManager is require_org_manager.
	MsgManager = "需要主管权限"
	// MsgUnavailable is the shared database failure body.
	MsgUnavailable = "服务暂不可用"
)

// RefusalKind tells a handler which wire code to use. The status and message
// are the resolver's, so a TOTP refusal is not rewritten here.
type RefusalKind int

const (
	RefusalUnauthenticated RefusalKind = iota
	RefusalForbidden
	RefusalOther
)

// Refusal is an authentication answer. Status is the HTTP status.
type Refusal struct {
	Status  int
	Message string
	Kind    RefusalKind
}

// Principal is the account PR-1 already resolved. WorkspaceRole is the stored
// membership string (owner, manager, admin, member, reviewer, viewer).
// PlatformRole is user, admin, or super_admin. OrgID 0 means no active workspace.
type Principal struct {
	UserID        int64
	OrgID         int64
	WorkspaceRole string
	PlatformRole  string
	Email         string
	PublicID      string
	TokenHash     string
}

// Resolver resolves one request. A non-nil Refusal wins over Principal: that
// is how step-up refuses before a super admin is returned. A nil principal
// and a nil refusal means logged out.
type Resolver interface {
	Resolve(r *http.Request) (*Principal, *Refusal, error)
}

// FixedResolver returns one principal. Tests and local wiring use it.
// It is not a session implementation.
type FixedResolver struct {
	Principal *Principal
	Refusal   *Refusal
	Err       error
}

func (f FixedResolver) Resolve(*http.Request) (*Principal, *Refusal, error) {
	return f.Principal, f.Refusal, f.Err
}

// ParseWorkspace is WorkspaceRole::parse_stored. Unknown is not viewer.
func ParseWorkspace(raw string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "owner":
		return "owner", true
	case "manager", "admin":
		return "manager", true
	case "member":
		return "operator", true
	case "reviewer":
		return "reviewer", true
	case "viewer":
		return "viewer", true
	default:
		return "", false
	}
}

// CanManage is entitlement::can_manage. Unknown stored roles become viewer
// via from_stored, and viewer cannot manage.
func CanManage(raw string) bool {
	role, ok := ParseWorkspace(raw)
	return ok && (role == "owner" || role == "manager")
}

// AllowsListingPrepare is Capability::ListingPrepare: every parsed role except viewer.
func AllowsListingPrepare(raw string) bool {
	role, ok := ParseWorkspace(raw)
	return ok && role != "viewer"
}

// AllowsListingSubmit is Capability::ListingSubmit: owner, manager, and the
// stored member role (parsed as operator). Reviewer prepares but does not submit.
func AllowsListingSubmit(raw string) bool {
	role, ok := ParseWorkspace(raw)
	return ok && (role == "owner" || role == "manager" || role == "operator")
}

// StoreVisible is is_store_visible_to_operator.
// Unknown stored roles see nothing. An owner or manager sees every store.
// Any other parsed role sees a store only when its assignee membership is theirs.
func StoreVisible(role string, assigneeMembershipID *int64, actorMembershipID int64) bool {
	parsed, ok := ParseWorkspace(role)
	if !ok {
		return false
	}
	if parsed == "owner" || parsed == "manager" {
		return true
	}
	return assigneeMembershipID != nil && *assigneeMembershipID == actorMembershipID
}

// IsSuperAdmin is Role::is_super_admin after from_stored. Case and surrounding
// space are ignored. Unknown ranks are users.
func IsSuperAdmin(raw string) bool {
	return strings.ToLower(strings.TrimSpace(raw)) == "super_admin"
}

// ListingPrepare is require_tenant plus Capability::ListingPrepare.
// status is 403 when ok is false.
func ListingPrepare(p Principal) (status int, message string, ok bool) {
	if p.OrgID <= 0 || strings.TrimSpace(p.WorkspaceRole) == "" {
		return http.StatusForbidden, MsgNoWorkspace, false
	}
	if _, parsed := ParseWorkspace(p.WorkspaceRole); !parsed {
		return http.StatusForbidden, MsgBadWorkspaceRole, false
	}
	if !AllowsListingPrepare(p.WorkspaceRole) {
		return http.StatusForbidden, MsgListingForbidden, false
	}
	return 0, "", true
}

// ListingSubmit is require_tenant plus Capability::ListingSubmit.
// status is 403 when ok is false.
func ListingSubmit(p Principal) (status int, message string, ok bool) {
	if status, message, ok = ListingPrepare(p); !ok {
		return status, message, false
	}
	if !AllowsListingSubmit(p.WorkspaceRole) {
		return http.StatusForbidden, MsgListingForbidden, false
	}
	return 0, "", true
}

// OrgMember is require_org_member: only org_id == 0 is workspaceless.
func OrgMember(p Principal) (status int, message string, ok bool) {
	if p.OrgID == 0 {
		return http.StatusForbidden, MsgNoWorkspace, false
	}
	return 0, "", true
}

// OrgManager is require_org_manager. The role is the resolver's membership
// string; this package does not read organization_members.
func OrgManager(p Principal) (status int, message string, ok bool) {
	if status, message, ok = OrgMember(p); !ok {
		return status, message, false
	}
	if !CanManage(p.WorkspaceRole) {
		return http.StatusForbidden, MsgManager, false
	}
	return 0, "", true
}

// SuperAdmin is ManagePlatform after the resolver has already applied step-up.
func SuperAdmin(p Principal) (status int, message string, ok bool) {
	if !IsSuperAdmin(p.PlatformRole) {
		return http.StatusForbidden, MsgSuperAdmin, false
	}
	return 0, "", true
}
