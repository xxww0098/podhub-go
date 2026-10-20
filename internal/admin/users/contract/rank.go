package contract

import "strings"

// Platform role names stored on account_users.role.
const (
	RankUser  = "user"
	RankAdmin = "admin"
	RankSuper = "super_admin"
)

const (
	msgCannotAssign = "无权分配该角色"
	msgCannotMutate = "无权修改该账号"
	msgLastSuper    = "不能移除最后一个超级管理员"
)

// ParseRank trims and lowercases. Empty and unknown are invalid.
func ParseRank(raw string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case RankUser, RankAdmin, RankSuper:
		return strings.ToLower(strings.TrimSpace(raw)), true
	default:
		return "", false
	}
}

// RankFromStored collapses empty and unknown to user.
func RankFromStored(raw string) string {
	rank, ok := ParseRank(raw)
	if !ok {
		return RankUser
	}
	return rank
}

// Staff is admin or super_admin after from_stored.
func Staff(raw string) bool {
	switch RankFromStored(raw) {
	case RankAdmin, RankSuper:
		return true
	default:
		return false
	}
}

// RankLabel is the directory label.
func RankLabel(raw string) string {
	switch RankFromStored(raw) {
	case RankSuper:
		return "超级管理员"
	case RankAdmin:
		return "平台管理员"
	default:
		return "用户"
	}
}

// Change is create, assign, edit, or disable.
type Change struct {
	Kind string
	Role string
}

// Authorize applies assign, mutate, and protect_last.
// last is meaningful only when the target is already a super admin.
// Create checks assign only. The target rank for create is unused.
func Authorize(actor string, change Change, target string, last bool) (string, bool) {
	actor = RankFromStored(actor)
	target = RankFromStored(target)
	switch change.Kind {
	case "create":
		return assignRank(actor, RankFromStored(change.Role))
	case "assign":
		if msg, ok := mutateRank(actor, target); !ok {
			return msg, false
		}
		if msg, ok := assignRank(actor, RankFromStored(change.Role)); !ok {
			return msg, false
		}
		return protectLast(target, target == RankSuper && RankFromStored(change.Role) != RankSuper, last)
	case "edit":
		return mutateRank(actor, target)
	case "disable":
		if msg, ok := mutateRank(actor, target); !ok {
			return msg, false
		}
		return protectLast(target, target == RankSuper, last)
	default:
		return msgCannotMutate, false
	}
}

func assignRank(actor, role string) (string, bool) {
	if role == RankSuper {
		return msgCannotAssign, false
	}
	switch actor {
	case RankSuper:
		return "", true
	case RankAdmin:
		if role == RankUser {
			return "", true
		}
		return msgCannotAssign, false
	default:
		return msgCannotAssign, false
	}
}

func mutateRank(actor, target string) (string, bool) {
	switch actor {
	case RankSuper:
		return "", true
	case RankAdmin:
		if target == RankUser {
			return "", true
		}
		return msgCannotMutate, false
	default:
		return msgCannotMutate, false
	}
}

func protectLast(target string, leaving, last bool) (string, bool) {
	if target == RankSuper && leaving && last {
		return msgLastSuper, false
	}
	return "", true
}

// CanMutate is the directory manageable bit before the self check.
func CanMutate(actor, target string) bool {
	_, ok := mutateRank(RankFromStored(actor), RankFromStored(target))
	return ok
}

// TierKey folds blank, free, and unknown plans to lite.
func TierKey(plan string) string {
	switch strings.ToLower(strings.TrimSpace(plan)) {
	case "pro", "max", "ultra", "lite":
		return strings.ToLower(strings.TrimSpace(plan))
	default:
		return "lite"
	}
}
