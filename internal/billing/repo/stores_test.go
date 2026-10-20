package billingrepo

import "testing"

func TestPlanStoreSuspension(t *testing.T) {
	rows := []StoreSeat{
		{ID: 2, Order: 2},
		{ID: 1, Order: 1},
		{ID: 3, Order: 3, Manual: true},
		{ID: 4, Order: 0, Deleted: true},
		{ID: 5, Order: 2},
	}
	got := PlanStoreSuspension(1, rows)
	if len(got) != 3 {
		t.Fatalf("manual and deleted must be left out: %+v", got)
	}
	if got[1] || !got[2] || !got[5] {
		t.Fatalf("first create_order stays, the rest suspend: %+v", got)
	}
	none := PlanStoreSuspension(0, []StoreSeat{{ID: 9, Order: 1}})
	if !none[9] {
		t.Fatal("limit 0 suspends every live store")
	}
}
