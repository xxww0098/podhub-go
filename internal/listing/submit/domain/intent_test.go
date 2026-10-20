package domain

import "testing"

func TestNamedEdgesMatchRustTable(t *testing.T) {
	if len(Edges) != 11 {
		t.Fatalf("edges %d", len(Edges))
	}
	want := []struct {
		edge Edge
		from []string
		to   string
	}{
		{Begin, []string{Queued}, Submitting},
		{RejectQueued, []string{Queued}, Rejected},
		{RejectSubmitting, []string{Submitting}, Rejected},
		{RejectBeforeAcceptance, []string{Queued, Submitting}, Rejected},
		{AcceptSubmitting, []string{Submitting}, Accepted},
		{AcceptInFlight, []string{Submitting, Unknown}, Accepted},
		{AcceptUnknown, []string{Unknown}, Accepted},
		{ParkSubmitting, []string{Submitting}, Unknown},
		{ParkInFlight, []string{Submitting, Unknown}, Unknown},
		{CancelBeforeDispatch, []string{Queued, Submitting}, Cancelled},
		{CancelSubmitting, []string{Submitting}, Cancelled},
	}
	for i, row := range want {
		if Edges[i] != row.edge {
			t.Fatalf("order %d %s", i, Edges[i])
		}
		got, err := Apply(row.from[0], row.edge)
		if err != nil || got != row.to {
			t.Fatalf("%s from %s: %s %v", row.edge, row.from[0], got, err)
		}
		for _, from := range row.from {
			got, err = Apply(from, row.edge)
			if err != nil || got != row.to {
				t.Fatalf("%s from %s: %s %v", row.edge, from, got, err)
			}
		}
		if only, err := row.edge.OnlyFrom(); len(row.from) == 1 {
			if err != nil || only != row.from[0] {
				t.Fatalf("only %s %s %v", row.edge, only, err)
			}
		} else if err == nil {
			t.Fatalf("%s must not be a single predecessor", row.edge)
		}
	}
}

func TestIllegalEdgesFail(t *testing.T) {
	states := []string{
		Queued, Submitting, Unknown, Accepted, Rejected, Cancelled,
		Reconciled, Conflict, OperatorAttested, Superseded,
	}
	failures := 0
	for _, from := range states {
		for _, edge := range Edges {
			_, err := Apply(from, edge)
			legal := false
			for _, allowed := range edge.From() {
				if from == allowed {
					legal = true
				}
			}
			if legal {
				if err != nil {
					t.Fatalf("legal %s from %s: %v", edge, from, err)
				}
				continue
			}
			if err == nil {
				t.Fatalf("illegal %s from %s was applied", edge, from)
			}
			failures++
		}
	}
	if failures == 0 {
		t.Fatal("expected illegal pairs")
	}
}

func TestSubmitEdgesDoNotNameHistory(t *testing.T) {
	for _, edge := range Edges {
		for _, state := range append(append([]string{}, edge.From()...), edge.To()) {
			for _, history := range History {
				if state == history {
					t.Fatalf("%s names %s", edge, state)
				}
			}
		}
	}
}

func TestUnknownCannotBeRedispatchedOrCancelledHere(t *testing.T) {
	for _, to := range []string{Queued, Submitting, Rejected, Cancelled} {
		if Allows(Unknown, to) {
			t.Fatalf("unknown → %s", to)
		}
	}
	if !Allows(Unknown, Accepted) || !Allows(Unknown, Unknown) {
		t.Fatal("unknown may accept or be restamped")
	}
}

func TestAcceptanceRequiresInFlight(t *testing.T) {
	if Allows(Queued, Accepted) || Allows(Queued, Unknown) {
		t.Fatal("queued cannot accept or park")
	}
	if !Allows(Queued, Submitting) || !Allows(Queued, Rejected) || !Allows(Queued, Cancelled) {
		t.Fatal("queued edges")
	}
}

func TestBeginIsTheOnlyQueuedToSubmittingEdge(t *testing.T) {
	only, err := Begin.OnlyFrom()
	if err != nil || only != Queued || Begin.To() != Submitting {
		t.Fatalf("%s %v", only, err)
	}
	n := 0
	for _, edge := range Edges {
		if edge.To() != Submitting {
			continue
		}
		for _, from := range edge.From() {
			if from == Queued {
				n++
			}
		}
	}
	if n != 1 {
		t.Fatalf("queued→submitting edges %d", n)
	}
}

func TestParkSubmittingDoesNotMatchUnknown(t *testing.T) {
	if _, err := Apply(Unknown, ParkSubmitting); err == nil {
		t.Fatal("ParkSubmitting refreshed an unknown row")
	}
	got, err := Apply(Unknown, ParkInFlight)
	if err != nil || got != Unknown {
		t.Fatalf("ParkInFlight %s %v", got, err)
	}
}
