package domain

import userscontract "github.com/xxww0098/podhub-go/internal/admin/users/contract"

// Seat and store quota planning lives in the users contract; these aliases
// and wrappers keep the admin names.

const (
	ActionSuspend = userscontract.ActionSuspend
	ActionRestore = userscontract.ActionRestore
)

type (
	MemberRow    = userscontract.MemberRow
	MemberChange = userscontract.MemberChange
	MemberPlan   = userscontract.MemberPlan
	Lot          = userscontract.Lot
	SeatState    = userscontract.SeatState
	SeatIntent   = userscontract.SeatIntent
	SeatTarget   = userscontract.SeatTarget
	StoreRow     = userscontract.StoreRow
	StoreChange  = userscontract.StoreChange
	StorePlan    = userscontract.StorePlan
)

// SeatRange is the member override window.
func SeatRange(seats int64) bool { return userscontract.SeatRange(seats) }

// StoreQuotaFor is the plan default store count.
func StoreQuotaFor(plan string, seats int64) int64 { return userscontract.StoreQuotaFor(plan, seats) }

func EffectiveSeats(purchased int64, override *int64) int64 {
	return userscontract.EffectiveSeats(purchased, override)
}

func EffectiveTier(tiers []string) string { return userscontract.EffectiveTier(tiers) }

func ResolveSeats(state SeatState, intent SeatIntent) (SeatTarget, string) {
	return userscontract.ResolveSeats(state, intent)
}

func PlanMembers(limit int64, rows []MemberRow) MemberPlan {
	return userscontract.PlanMembers(limit, rows)
}

func PlanStores(limit int64, rows []StoreRow) StorePlan {
	return userscontract.PlanStores(limit, rows)
}
