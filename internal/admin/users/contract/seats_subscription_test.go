package contract

import "testing"

// Members are capped, not sold: the owner always stays and joiners past the
// cap are suspended in join order.
func TestMemberCapSuspendsJoinersPastTheCap(t *testing.T) {
	rows := []MemberRow{{ID: 1, UserID: 1, Role: "owner", JoinOrder: 1}}
	for i := int64(2); i <= MemberCap+2; i++ {
		rows = append(rows, MemberRow{ID: i, UserID: i, Role: "member", JoinOrder: i})
	}
	plan := PlanMembers(MemberCap, rows)
	if len(plan.Suspend) != 2 || plan.Suspend[0].MembershipID != MemberCap+1 || plan.Suspend[1].MembershipID != MemberCap+2 {
		t.Fatalf("members past the cap: %+v", plan.Suspend)
	}
}

func TestSeatRangeIsOneToTheCap(t *testing.T) {
	for _, over := range []int64{0, MemberCap + 1} {
		if SeatRange(over) {
			t.Fatalf("override %d accepted", over)
		}
	}
	if !SeatRange(1) || !SeatRange(MemberCap) {
		t.Fatal("bounds rejected")
	}
}
