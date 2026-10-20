package domain

import "testing"

func TestPlanMembersEdges(t *testing.T) {
	owner := MemberRow{ID: 1, UserID: 10, Role: "owner", JoinOrder: 1}
	early := MemberRow{ID: 2, UserID: 11, Role: "member", JoinOrder: 2}
	later := MemberRow{ID: 3, UserID: 12, Role: "member", JoinOrder: 3}
	manual := MemberRow{ID: 4, UserID: 13, Role: "member", JoinOrder: 4, ManualDisabled: true, QuotaSuspended: true}
	suspended := MemberRow{ID: 5, UserID: 14, Role: "member", JoinOrder: 5, QuotaSuspended: true}

	t.Run("lowering_keeps_earliest_non_owner_and_suspends_later_joiners", func(t *testing.T) {
		plan := PlanMembers(2, []MemberRow{owner, early, later})
		if len(plan.Suspend) != 1 || plan.Suspend[0].MembershipID != 3 || plan.Suspend[0].Action != ActionSuspend {
			t.Fatalf("%+v", plan.Suspend)
		}
		if len(plan.Restore) != 0 || plan.Used != 3 {
			t.Fatalf("%+v", plan)
		}
	})
	t.Run("raising_restores_earliest_quota_suspended_members", func(t *testing.T) {
		plan := PlanMembers(3, []MemberRow{owner, early, suspended})
		if len(plan.Restore) != 1 || plan.Restore[0].UserID != 14 || len(plan.Suspend) != 0 {
			t.Fatalf("%+v", plan)
		}
	})
	t.Run("manual_disabled_never_restored_and_does_not_count_as_used", func(t *testing.T) {
		plan := PlanMembers(5, []MemberRow{owner, manual})
		if plan.Used != 1 || plan.Suspended != 0 || len(plan.Restore) != 0 || len(plan.Suspend) != 0 {
			t.Fatalf("%+v", plan)
		}
	})
	t.Run("owner_is_never_suspended_even_when_limit_is_one", func(t *testing.T) {
		plan := PlanMembers(1, []MemberRow{owner, early})
		if len(plan.Suspend) != 1 || plan.Suspend[0].MembershipID != 2 || len(plan.Restore) != 0 {
			t.Fatalf("%+v", plan)
		}
		held := PlanMembers(1, []MemberRow{{ID: 9, UserID: 1, Role: "owner", JoinOrder: 1, QuotaSuspended: true}})
		if len(held.Restore) != 1 || held.Restore[0].Action != ActionRestore {
			t.Fatalf("%+v", held)
		}
	})
	t.Run("seat_limit_is_floored_at_minimum", func(t *testing.T) {
		plan := PlanMembers(0, []MemberRow{owner, early})
		if len(plan.Suspend) != 1 {
			t.Fatalf("%+v", plan)
		}
	})
	t.Run("no_op_when_state_already_matches_limit", func(t *testing.T) {
		plan := PlanMembers(2, []MemberRow{owner, early})
		if len(plan.Suspend) != 0 || len(plan.Restore) != 0 {
			t.Fatalf("%+v", plan)
		}
	})
}

func TestPlanStoresOrdersLeastRecentlyUsedSuspend(t *testing.T) {
	rows := []StoreRow{
		{ID: 1, UUID: "a", CreateOrder: 1, LastUsed: 10},
		{ID: 2, UUID: "b", CreateOrder: 2, LastUsed: 1},
		{ID: 3, UUID: "c", CreateOrder: 3, LastUsed: 1, ManualDisabled: true, QuotaSuspended: true},
	}
	plan := PlanStores(1, rows)
	if plan.Used != 2 || plan.Suspended != 1 || len(plan.Suspend) != 1 || plan.Suspend[0].UUID != "b" {
		t.Fatalf("%+v", plan)
	}
	if StoreQuotaFor("lite", 9) != 1 || StoreQuotaFor("pro", 3) != 15 || StoreQuotaFor("pro", 100) != 100 {
		t.Fatal("quota")
	}
	if !SeatRange(1) || SeatRange(0) || SeatRange(201) {
		t.Fatal("range")
	}
	ov := int64(4)
	if EffectiveSeats(0, &ov) != 4 || EffectiveSeats(0, nil) != 1 || EffectiveTier(nil) != "lite" || EffectiveTier([]string{"pro", "ultra", "max"}) != "ultra" {
		t.Fatal("effective")
	}
}
