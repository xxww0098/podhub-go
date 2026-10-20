package domain

import "strings"

// Role is the platform rank stored as user, admin, or super_admin.
type Role int

const (
	RoleUser Role = iota
	RoleAdmin
	RoleSuperAdmin
)

// ParseRole rejects empty and unknown strings.
func ParseRole(raw string) (Role, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "user":
		return RoleUser, nil
	case "admin":
		return RoleAdmin, nil
	case "super_admin":
		return RoleSuperAdmin, nil
	case "":
		return 0, errEmptyRole
	default:
		return 0, errUnknownRole
	}
}

var (
	errEmptyRole   = parseErr("empty role")
	errUnknownRole = parseErr("unknown role")
)

type parseErr string

func (e parseErr) Error() string { return string(e) }

// RoleFromStored collapses empty and unknown values to user so they never pass a staff gate.
func RoleFromStored(raw string) Role {
	role, err := ParseRole(raw)
	if err != nil {
		return RoleUser
	}
	return role
}

func (r Role) String() string {
	switch r {
	case RoleAdmin:
		return "admin"
	case RoleSuperAdmin:
		return "super_admin"
	default:
		return "user"
	}
}

func (r Role) IsStaff() bool      { return r == RoleAdmin || r == RoleSuperAdmin }
func (r Role) IsSuperAdmin() bool { return r == RoleSuperAdmin }

// Change is one identity change the algebra can allow or deny.
type Change struct {
	Kind string // create, assign, edit, disable
	Role Role
}

// Deny is why authorize refused.
type Deny string

const (
	DenyCannotAssign   Deny = "cannot assign that role"
	DenyCannotMutate   Deny = "cannot mutate that account"
	DenyLastSuperAdmin Deny = "cannot strip the last super_admin"
)

// Authorize allows or denies one identity change.
// lastActiveSuperAdmin is false when target is not a super admin.
func Authorize(actor Role, change Change, target Role, lastActiveSuperAdmin bool) error {
	switch change.Kind {
	case "create":
		return assignRole(actor, change.Role)
	case "assign":
		if err := mutateRole(actor, target); err != nil {
			return err
		}
		if err := assignRole(actor, change.Role); err != nil {
			return err
		}
		return protectLast(target, leavesSuperAdmin(target, change.Role), lastActiveSuperAdmin)
	case "edit":
		return mutateRole(actor, target)
	case "disable":
		if err := mutateRole(actor, target); err != nil {
			return err
		}
		return protectLast(target, target == RoleSuperAdmin, lastActiveSuperAdmin)
	default:
		return DenyCannotMutate
	}
}

// AuthorizeUpdate mixes a role change, a disable, and field edits.
func AuthorizeUpdate(actor, target, newRole Role, leavingActive, lastActiveSuperAdmin bool) error {
	if err := Authorize(actor, Change{Kind: "edit"}, target, lastActiveSuperAdmin); err != nil {
		return err
	}
	if newRole != target {
		if err := Authorize(actor, Change{Kind: "assign", Role: newRole}, target, lastActiveSuperAdmin); err != nil {
			return err
		}
	}
	if leavingActive {
		return Authorize(actor, Change{Kind: "disable"}, target, lastActiveSuperAdmin)
	}
	return nil
}

func CanAssign(actor, role Role) bool { return assignRole(actor, role) == nil }
func CanMutate(actor, target Role) bool {
	return mutateRole(actor, target) == nil
}

func assignRole(actor, role Role) error {
	if role == RoleSuperAdmin {
		return DenyCannotAssign
	}
	switch actor {
	case RoleSuperAdmin:
		return nil
	case RoleAdmin:
		if role == RoleUser {
			return nil
		}
		return DenyCannotAssign
	default:
		return DenyCannotAssign
	}
}

func mutateRole(actor, target Role) error {
	switch actor {
	case RoleSuperAdmin:
		return nil
	case RoleAdmin:
		if target == RoleUser {
			return nil
		}
		return DenyCannotMutate
	default:
		return DenyCannotMutate
	}
}

func leavesSuperAdmin(from, to Role) bool {
	return from == RoleSuperAdmin && (to == RoleUser || to == RoleAdmin)
}

func protectLast(target Role, wouldLeave, isLast bool) error {
	if target == RoleSuperAdmin && wouldLeave && isLast {
		return DenyLastSuperAdmin
	}
	return nil
}

func (d Deny) Error() string { return string(d) }
