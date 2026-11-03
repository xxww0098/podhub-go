// Package contract shares resolved identities and authorization rules.
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
	// MsgListingForbidden is the refusal for a restricted workspace action.
	MsgListingForbidden = "当前角色无权执行此操作"
	// MsgSuperAdmin is the platform administration refusal.
	MsgSuperAdmin = "需要超级管理员权限"
	// MsgManager is require_org_manager.
	MsgManager = "需要主管权限"
	// MsgUnavailable is the shared database failure body.
	MsgUnavailable = "服务暂不可用"
)

// RefusalKind tells a handler which wire code to use. The status and message
// are the resolver's, so a refusal is not rewritten here.
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

// Principal is a resolved account. WorkspaceRole is the stored
// membership string (owner, manager, member).
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
// is how a resolver refuses before a super admin is returned. A nil principal
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

// CanManage allows only workspace owners and managers.
func CanManage(raw string) bool {
	role, ok := ParseWorkspace(raw)
	return ok && role.CanManage()
}

// StoreVisible is is_store_visible_to_operator.
// Unknown stored roles see nothing. An owner or manager sees every store.
// Any other parsed role sees a store only when its assignee membership is theirs.
func StoreVisible(role string, assigneeMembershipID *int64, actorMembershipID int64) bool {
	parsed, ok := ParseWorkspace(role)
	if !ok {
		return false
	}
	if parsed.CanManage() {
		return true
	}
	return assigneeMembershipID != nil && *assigneeMembershipID == actorMembershipID
}

// IsPlatformStaff checks platform roles independently of workspace membership.
func IsPlatformStaff(raw string) bool {
	role := strings.ToLower(strings.TrimSpace(raw))
	return role == "admin" || role == "super_admin"
}

// IsSuperAdmin rejects every platform role except super_admin.
func IsSuperAdmin(raw string) bool {
	return strings.ToLower(strings.TrimSpace(raw)) == "super_admin"
}

// OrgMember requires a positive workspace ID and one of its three roles.
func OrgMember(p Principal) (status int, message string, ok bool) {
	if p.OrgID <= 0 || strings.TrimSpace(p.WorkspaceRole) == "" {
		return http.StatusForbidden, MsgNoWorkspace, false
	}
	if _, parsed := ParseWorkspace(p.WorkspaceRole); !parsed {
		return http.StatusForbidden, MsgBadWorkspaceRole, false
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

// SuperAdmin is ManagePlatform for a resolved principal.
func SuperAdmin(p Principal) (status int, message string, ok bool) {
	if !IsSuperAdmin(p.PlatformRole) {
		return http.StatusForbidden, MsgSuperAdmin, false
	}
	return 0, "", true
}
