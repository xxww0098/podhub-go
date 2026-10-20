package contract

import "time"

// Seat and store quota planning. Limits below 1 are floored at 1.
// Manual-disabled rows never take a seat and are never restored.

const (
	minSeats      = 1
	maxSeats      = 200
	freeStores    = 1
	storesPerSeat = 5
	maxStores     = 100
	ActionSuspend = "SUSPEND"
	ActionRestore = "RESTORE"
)

// SeatRange is the member override window.
func SeatRange(seats int64) bool { return seats >= minSeats && seats <= maxSeats }

// StoreQuotaFor is the plan default store count.
func StoreQuotaFor(plan string, seats int64) int64 {
	if TierKey(plan) == "lite" {
		return freeStores
	}
	n := seats
	if n < 1 {
		n = 1
	}
	n *= storesPerSeat
	if n > maxStores {
		return maxStores
	}
	return n
}

// EffectiveSeats is override or purchased, floored at 1.
func EffectiveSeats(purchased int64, override *int64) int64 {
	if override != nil {
		if *override < 1 {
			return minSeats
		}
		return *override
	}
	if purchased < 1 {
		return minSeats
	}
	return purchased
}

// EffectiveTier picks the highest live lot. No lot is lite.
func EffectiveTier(tiers []string) string {
	best := "lite"
	rank := 0
	for _, tier := range tiers {
		r := 0
		switch tier {
		case "ultra":
			r = 3
		case "max":
			r = 2
		case "pro":
			r = 1
		}
		if r > rank {
			rank = r
			best = tier
		}
	}
	return best
}

// MemberRow is one organization_members row in join order.
type MemberRow struct {
	ID             int64
	UserID         int64
	Role           string
	JoinOrder      int64
	ManualDisabled bool
	QuotaSuspended bool
}

// MemberChange is one planned membership flag change.
type MemberChange struct {
	MembershipID int64
	UserID       int64
	JoinOrder    int64
	Action       string
}

// MemberPlan is the reconcile result.
type MemberPlan struct {
	Used      int64
	Suspended int64
	Suspend   []MemberChange
	Restore   []MemberChange
}

// Lot is one live member_seat_lots group.
type Lot struct {
	Tier  string
	Seats int64
}

// SeatState is the organization row plus live lots.
type SeatState struct {
	OrgID          int64
	Plan           string
	SeatLimit      int64
	Revision       int64
	StoreOverride  *int64
	MemberOverride *int64
	Lots           []Lot
	Expires        *time.Time
}

// SeatIntent is the preview or apply body after JSON defaults.
type SeatIntent struct {
	MemberOverride *int64
	FollowMembers  bool
	StoreOverride  *int64
	FollowStores   bool
}

// SeatTarget is what resolve_target_seats persists and previews.
type SeatTarget struct {
	Plan              string
	SeatLimit         int64
	Purchased         int64
	MemberOverride    *int64
	StoreLimit        int64
	StoreOverride     *int64
	PlanDefaultStores int64
	FollowMembers     bool
	FollowStores      bool
	Expires           *time.Time
}

// ResolveSeats applies the preview and apply seat rules.
func ResolveSeats(state SeatState, intent SeatIntent) (SeatTarget, string) {
	plan := EffectiveTier(lotTiers(state.Lots))
	var purchased int64
	if plan != "lite" {
		for _, lot := range state.Lots {
			if lot.Tier == plan {
				purchased += lot.Seats
			}
		}
	}
	planDefault := purchased
	if planDefault < 1 {
		planDefault = 1
	}
	var member *int64
	if intent.FollowMembers {
		member = nil
	} else if intent.MemberOverride != nil {
		if !SeatRange(*intent.MemberOverride) {
			return SeatTarget{}, "成员名额需在 1-200 之间"
		}
		v := *intent.MemberOverride
		member = &v
	} else if state.MemberOverride != nil {
		v := *state.MemberOverride
		member = &v
	}
	seatLimit := EffectiveSeats(planDefault, member)
	planStores := StoreQuotaFor(plan, seatLimit)
	followStores := intent.FollowStores || (intent.StoreOverride == nil && state.StoreOverride == nil)
	var storeLimit int64
	var storeOverride *int64
	if followStores {
		storeLimit = planStores
	} else if intent.StoreOverride != nil {
		if *intent.StoreOverride < 1 {
			return SeatTarget{}, "店铺名额至少为一"
		}
		if *intent.StoreOverride > maxStores {
			return SeatTarget{}, "一个工作空间最多 100 家店铺"
		}
		storeLimit = *intent.StoreOverride
		v := storeLimit
		storeOverride = &v
	} else {
		v := *state.StoreOverride
		if v < 1 {
			storeLimit = planStores
		} else if v > maxStores {
			return SeatTarget{}, "一个工作空间最多 100 家店铺"
		} else {
			storeLimit = v
		}
		stored := storeLimit
		storeOverride = &stored
	}
	return SeatTarget{
		Plan: plan, SeatLimit: seatLimit, Purchased: planDefault,
		MemberOverride: member, StoreLimit: storeLimit, StoreOverride: storeOverride,
		PlanDefaultStores: planStores, FollowMembers: intent.FollowMembers, FollowStores: followStores,
		Expires: state.Expires,
	}, ""
}

func lotTiers(lots []Lot) []string {
	out := make([]string, len(lots))
	for i, lot := range lots {
		out[i] = lot.Tier
	}
	return out
}

// PlanMembers walks join order. Owner is always targeted active and consumes
// one slot. used and suspended count current non-manual rows.
func PlanMembers(limit int64, rows []MemberRow) MemberPlan {
	if limit < 1 {
		limit = 1
	}
	var out MemberPlan
	var running int64
	for _, row := range rows {
		if row.ManualDisabled {
			continue
		}
		if row.QuotaSuspended {
			out.Suspended++
		} else {
			out.Used++
		}
		target := row.Role == "owner" || running < limit
		if target {
			running++
		}
		if !row.QuotaSuspended && !target {
			out.Suspend = append(out.Suspend, MemberChange{row.ID, row.UserID, row.JoinOrder, ActionSuspend})
		}
		if row.QuotaSuspended && target {
			out.Restore = append(out.Restore, MemberChange{row.ID, row.UserID, row.JoinOrder, ActionRestore})
		}
	}
	if out.Suspend == nil {
		out.Suspend = []MemberChange{}
	}
	if out.Restore == nil {
		out.Restore = []MemberChange{}
	}
	return out
}

// StoreRow is one live store.
type StoreRow struct {
	ID             int64
	UUID           string
	CreateOrder    int64
	ManualDisabled bool
	QuotaSuspended bool
	LastUsed       int64
}

// StoreChange is one planned store flag change.
type StoreChange struct {
	UUID        string
	CreateOrder int64
	Action      string
}

// StorePlan is the store reconcile result.
type StorePlan struct {
	Used      int64
	Suspended int64
	Suspend   []StoreChange
	Restore   []StoreChange
}

// PlanStores fills the most recently used stores first.
// The suspend list is reordered least-recently-used first.
func PlanStores(limit int64, rows []StoreRow) StorePlan {
	if limit < 1 {
		limit = 1
	}
	ordered := append([]StoreRow(nil), rows...)
	sortStores(ordered)
	var out StorePlan
	var used int64
	for _, row := range ordered {
		if row.ManualDisabled {
			if row.QuotaSuspended {
				out.Suspended++
			}
			continue
		}
		if row.QuotaSuspended {
			out.Suspended++
		} else {
			out.Used++
		}
		target := used < limit
		if target {
			used++
		}
		if !row.QuotaSuspended && !target {
			out.Suspend = append(out.Suspend, StoreChange{row.UUID, row.CreateOrder, ActionSuspend})
		}
		if row.QuotaSuspended && target {
			out.Restore = append(out.Restore, StoreChange{row.UUID, row.CreateOrder, ActionRestore})
		}
	}
	sortSuspend(out.Suspend, ordered)
	if out.Suspend == nil {
		out.Suspend = []StoreChange{}
	}
	if out.Restore == nil {
		out.Restore = []StoreChange{}
	}
	return out
}

func sortStores(rows []StoreRow) {
	for i := 1; i < len(rows); i++ {
		j := i
		for j > 0 && storeLess(rows[j], rows[j-1]) {
			rows[j], rows[j-1] = rows[j-1], rows[j]
			j--
		}
	}
}

func storeLess(a, b StoreRow) bool {
	if a.LastUsed != b.LastUsed {
		return a.LastUsed > b.LastUsed
	}
	if a.CreateOrder != b.CreateOrder {
		return a.CreateOrder < b.CreateOrder
	}
	return a.ID < b.ID
}

func sortSuspend(changes []StoreChange, rows []StoreRow) {
	index := map[string]StoreRow{}
	for _, row := range rows {
		index[row.UUID] = row
	}
	for i := 1; i < len(changes); i++ {
		j := i
		for j > 0 && suspendLess(index[changes[j].UUID], index[changes[j-1].UUID]) {
			changes[j], changes[j-1] = changes[j-1], changes[j]
			j--
		}
	}
}

func suspendLess(a, b StoreRow) bool {
	if a.LastUsed != b.LastUsed {
		return a.LastUsed < b.LastUsed
	}
	if a.CreateOrder != b.CreateOrder {
		return a.CreateOrder < b.CreateOrder
	}
	return a.ID < b.ID
}
