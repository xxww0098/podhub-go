package domain

import "testing"

func TestNamedEdgesAndIllegalEdges(t *testing.T) {
	allowed := []struct{ from, to string }{
		{StateGranted, StateAccepted},
		{StateGranted, StateRejected},
		{StateGranted, StateUnknown},
	}
	for _, edge := range allowed {
		if !Allows(edge.from, edge.to) {
			t.Fatalf("missing edge %s -> %s", edge.from, edge.to)
		}
	}
	illegal := []struct{ from, to string }{
		{StateAccepted, StateGranted},
		{StateAccepted, StateRejected},
		{StateAccepted, StateUnknown},
		{StateAccepted, StateAccepted},
		{StateRejected, StateGranted},
		{StateRejected, StateAccepted},
		{StateRejected, StateUnknown},
		{StateRejected, StateRejected},
		{StateUnknown, StateAccepted},
		{StateUnknown, StateRejected},
		{StateUnknown, StateGranted},
		{StateUnknown, StateUnknown},
		{"", StateGranted},
		{StateGranted, ""},
		{StateGranted, StateGranted},
	}
	for _, edge := range illegal {
		if Allows(edge.from, edge.to) {
			t.Fatalf("illegal edge allowed %s -> %s", edge.from, edge.to)
		}
	}
}

func TestClassifyReport(t *testing.T) {
	status := func(n int) *int { return &n }
	cases := []struct {
		name   string
		status *int
		op     string
		state  string
		code   string
	}{
		{"no status", nil, "op", StateUnknown, CodeInterrupted},
		{"zero", status(0), "op", StateUnknown, CodeInterrupted},
		{"200 with operation", status(200), "op-1", StateAccepted, ""},
		{"201 without operation", status(201), "", StateUnknown, CodeInterrupted},
		{"400", status(400), "", StateRejected, CodeRejected},
		{"422", status(422), "x", StateRejected, CodeRejected},
		{"403", status(403), "", StateRejected, CodeAccess},
		{"409", status(409), "", StateRejected, CodeRejected},
		{"500", status(500), "op", StateUnknown, CodeInterrupted},
		{"302", status(302), "op", StateUnknown, CodeInterrupted},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			state, code := ClassifyReport(tc.status, tc.op)
			if state != tc.state || code != tc.code {
				t.Fatalf("got %s %s", state, code)
			}
			if !Allows(StateGranted, state) {
				t.Fatal(state)
			}
		})
	}
}
