package ledger

import "testing"

func TestWriteEdges(t *testing.T) {
	cases := []struct {
		edge WriteEdge
		from string
		to   string
	}{
		{WriteSettle, WriteDispatching, WriteSettled},
		{WriteLose, WriteDispatching, WriteResultUnknown},
		{WriteReconcile, WriteResultUnknown, WriteReconciled},
		{WriteConflictEdge, WriteResultUnknown, WriteConflict},
	}
	for _, tc := range cases {
		got, err := ApplyWrite(tc.from, tc.edge)
		if err != nil || got != tc.to {
			t.Fatalf("%v %s %v", tc.edge, got, err)
		}
	}
	if _, err := ApplyWrite(WriteSettled, WriteLose); err == nil {
		t.Fatal("settled cannot become result_unknown")
	}
	if _, err := ApplyWrite(WriteDispatching, WriteReconcile); err == nil {
		t.Fatal("dispatching cannot reconcile")
	}
	if _, err := ApplyWrite(WriteResultUnknown, WriteSettle); err == nil {
		t.Fatal("unknown cannot settle without a response shape change through dispatching")
	}
}

func TestOccupancyRelease(t *testing.T) {
	for _, reason := range []string{ReasonNotDispatched, ReasonRejected, ReasonConfirmed, ReasonPartial} {
		if err := ReleaseOccupancy(OccupancyHeld, reason); err != nil {
			t.Fatal(reason, err)
		}
	}
	if err := ReleaseOccupancy(OccupancyHeld, ""); err == nil {
		t.Fatal("empty reason")
	}
	if err := ReleaseOccupancy(OccupancyHeld, "timeout"); err == nil {
		t.Fatal("clock release")
	}
	if err := ReleaseOccupancy(OccupancyReleased, ReasonRejected); err == nil {
		t.Fatal("second release")
	}
}
