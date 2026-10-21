package contract

import "testing"

func TestSubscriptionSeatPlansMatchRetentionAndAdmission(t *testing.T) {
	seats, stores := int64(2), int64(1)
	state := SeatState{Plan: "lite", PurchasedMembers: &seats, PurchasedStores: &stores,
		KeepMembers: []int64{1, 3}, KeepStores: []string{"paid"}}
	target, msg := ResolveSeats(state, SeatIntent{FollowMembers: true, FollowStores: true})
	if msg != "" {
		t.Fatal(msg)
	}
	members := []MemberRow{{ID: 1, Role: "owner"}, {ID: 2, Role: "member"}, {ID: 3, Role: "member", QuotaSuspended: true}}
	plan := target.PlanMembers(members)
	if len(plan.Suspend) != 1 || plan.Suspend[0].MembershipID != 2 || len(plan.Restore) != 1 || plan.Restore[0].MembershipID != 3 {
		t.Fatalf("paid retained member lost: %+v", plan)
	}
	rows := []StoreRow{{ID: 1, UUID: "first", CreateOrder: 1}, {ID: 2, UUID: "paid", CreateOrder: 2, QuotaSuspended: true, LastUsed: 100}}
	storePlan := target.PlanStores(rows)
	if len(storePlan.Suspend) != 1 || storePlan.Suspend[0].UUID != "first" || len(storePlan.Restore) != 1 || storePlan.Restore[0].UUID != "paid" {
		t.Fatalf("paid retained store lost: %+v", storePlan)
	}
	// An explicit override uses the same creation order as SQL admission, even with recent activity.
	target, msg = ResolveSeats(state, SeatIntent{StoreOverride: &stores})
	storePlan = target.PlanStores(rows)
	if msg != "" || len(storePlan.Suspend) != 0 || len(storePlan.Restore) != 0 {
		t.Fatalf("override used a different admission order: %+v %s", storePlan, msg)
	}
}
