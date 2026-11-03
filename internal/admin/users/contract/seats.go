package contract

// Member cap planning. Members are not sold: every workspace follows the
// global cap unless an admin tightens it with an override.
// Manual-disabled rows never take a seat and are never restored.

const (
	minSeats = 1
	// MemberCap is the member limit of every workspace. billing/domain.MemberCap
	// and subscription_capacity() in the baseline schema carry the same number;
	// the integration suite compares all three.
	MemberCap     = 10
	ActionSuspend = "SUSPEND"
	ActionRestore = "RESTORE"
)

// SeatRange is the member override window: one to the global cap.
func SeatRange(seats int64) bool { return seats >= minSeats && seats <= MemberCap }

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

// PlanMembers walks join order. Owner is always targeted active and consumes
// one slot. used and suspended count current non-manual rows. Limits below 1
// are floored at 1.
func PlanMembers(limit int64, rows []MemberRow) MemberPlan {
	if limit < minSeats {
		limit = minSeats
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
