package domain

import (
	"strings"
	"unicode/utf8"

	corecontract "github.com/xxww0098/podhub-go/internal/admin/core/contract"
	userscontract "github.com/xxww0098/podhub-go/internal/admin/users/contract"
)

const maxPasswordBytes = 72

// CreateCredential reports whether email and password pass the create check.
// Password is not trimmed. Both failures share one sentence.
func CreateCredential(email, password string) bool {
	if !EmailShaped(email) {
		return false
	}
	if utf8.RuneCountInString(password) < 8 || len(password) > maxPasswordBytes {
		return false
	}
	return true
}

// PasswordReset trims, then checks length. The message is empty when valid.
func PasswordReset(password string) string {
	password = strings.TrimSpace(password)
	if utf8.RuneCountInString(password) < 8 {
		return "密码至少 8 位"
	}
	if len(password) > maxPasswordBytes {
		return "密码过长（最多 72 字节）"
	}
	return ""
}

// PlanInEffect prefers a non-blank org plan.
func PlanInEffect(orgPlan, accountPlan string) string {
	if strings.TrimSpace(orgPlan) != "" {
		return TierKey(orgPlan)
	}
	return TierKey(accountPlan)
}

// AccountStatus is disabled or active.
func AccountStatus(disabled bool) string {
	if disabled {
		return "disabled"
	}
	return "active"
}

// MembershipStatus is suspended when either flag is set.
func MembershipStatus(manual, quota bool) string {
	if manual || quota {
		return "suspended"
	}
	return "active"
}

// Actor is the admin caller. Users and AI-auth fill ID, Email, Role, and
// TokenHash. Billing and observation fill UserID and PublicID.
type Actor = corecontract.Actor

// The rank rules live in the users contract; these wrappers keep the admin
// names.
const (
	RankUser  = userscontract.RankUser
	RankAdmin = userscontract.RankAdmin
	RankSuper = userscontract.RankSuper
)

// Change is create, assign, edit, or disable.
type Change = userscontract.Change

// ParseRank trims and lowercases. Empty and unknown are invalid.
func ParseRank(raw string) (string, bool) { return userscontract.ParseRank(raw) }

// RankFromStored collapses empty and unknown to user.
func RankFromStored(raw string) string { return userscontract.RankFromStored(raw) }

// Staff is admin or super_admin after from_stored.
func Staff(raw string) bool { return userscontract.Staff(raw) }

// RankLabel is the directory label.
func RankLabel(raw string) string { return userscontract.RankLabel(raw) }

// Authorize applies assign, mutate, and protect_last.
func Authorize(actor string, change Change, target string, last bool) (string, bool) {
	return userscontract.Authorize(actor, change, target, last)
}

// CanMutate is the directory manageable bit before the self check.
func CanMutate(actor, target string) bool { return userscontract.CanMutate(actor, target) }

// TierKey folds blank, free, and unknown plans to lite.
func TierKey(plan string) string { return userscontract.TierKey(plan) }
