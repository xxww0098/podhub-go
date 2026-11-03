package domain

import userscontract "github.com/xxww0098/podhub-go/internal/admin/users/contract"

// Member cap planning lives in the users contract; these aliases and wrappers
// keep the admin names.

const (
	ActionSuspend = userscontract.ActionSuspend
	ActionRestore = userscontract.ActionRestore
)

type (
	MemberRow    = userscontract.MemberRow
	MemberChange = userscontract.MemberChange
	MemberPlan   = userscontract.MemberPlan
)

// SeatRange is the member override window.
func SeatRange(seats int64) bool { return userscontract.SeatRange(seats) }

func PlanMembers(limit int64, rows []MemberRow) MemberPlan {
	return userscontract.PlanMembers(limit, rows)
}
