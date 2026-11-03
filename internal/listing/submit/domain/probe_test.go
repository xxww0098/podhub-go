package domain

import "testing"

func TestFoundProductAcceptsImmediately(t *testing.T) {
	got := DecideProbe(ProbeMemory{}, SightFound, Found{ProductID: 9, SKU: 0})
	if got.Kind != "accept" || got.ProductID != 9 || got.SKU != 0 {
		t.Fatalf("%+v", got)
	}
}

func TestOneAbsenceWaitsAndTwoAbsencesRelease(t *testing.T) {
	first := DecideProbe(ProbeMemory{}, SightAbsent, Found{})
	if first.Kind != "retry" || first.Passes != 1 || first.Observation != "absent" || first.BackoffSecs != 60 {
		t.Fatalf("%+v", first)
	}
	second := DecideProbe(ProbeMemory{Passes: 1, Observation: "absent"}, SightAbsent, Found{})
	if second.Kind != "release" || second.Passes != 2 {
		t.Fatalf("%+v", second)
	}
}

func TestUnreadableDoesNotCountAsAbsence(t *testing.T) {
	got := DecideProbe(ProbeMemory{Passes: 1, Observation: "absent"}, SightUnreadable, Found{})
	if got.Kind != "retry" || got.Observation != "unreadable" {
		t.Fatalf("%+v", got)
	}
	again := DecideProbe(ProbeMemory{Passes: 2, Observation: "unreadable"}, SightAbsent, Found{})
	if again.Kind != "retry" || again.Observation != "absent" {
		t.Fatalf("%+v", again)
	}
}

func TestEighthPassStops(t *testing.T) {
	got := DecideProbe(ProbeMemory{Passes: 7, Observation: "absent"}, SightUnreadable, Found{})
	if got.Kind != "give_up" || got.Passes != 8 || got.Observation != "unreadable" {
		t.Fatalf("%+v", got)
	}
}

func TestProbeBackoffDoublesAndCaps(t *testing.T) {
	if probeBackoffSecs(0) != 60 || probeBackoffSecs(1) != 120 || probeBackoffSecs(2) != 240 || probeBackoffSecs(3) != 480 {
		t.Fatal(probeBackoffSecs(0), probeBackoffSecs(1), probeBackoffSecs(2), probeBackoffSecs(3))
	}
	if probeBackoffSecs(4) != 900 || probeBackoffSecs(40) != 900 {
		t.Fatal(probeBackoffSecs(4), probeBackoffSecs(40))
	}
}

func TestZeroProductIDIsUnreadable(t *testing.T) {
	got := DecideProbe(ProbeMemory{}, SightFound, Found{ProductID: 0, SKU: 4})
	if got.Kind != "retry" || got.Observation != "unreadable" {
		t.Fatalf("%+v", got)
	}
}

func TestAcceptedProbeUsesTighterBackoffAndStopsAfterTwoAbsences(t *testing.T) {
	first := DecideAcceptedProbe(ProbeMemory{}, SightAbsent, Found{})
	if first.Kind != "retry" || first.Passes != 1 || first.Observation != "absent" || first.BackoffSecs != 15 {
		t.Fatalf("%+v", first)
	}
	second := DecideAcceptedProbe(ProbeMemory{Passes: 1, Observation: "absent"}, SightAbsent, Found{})
	if second.Kind != "stop" || second.Passes != 2 || second.Observation != "absent" {
		t.Fatalf("%+v", second)
	}
}

func TestAcceptedProbeAcceptsAndGivesUp(t *testing.T) {
	found := DecideAcceptedProbe(ProbeMemory{}, SightFound, Found{ProductID: 9, SKU: 4})
	if found.Kind != "accept" || found.ProductID != 9 || found.SKU != 4 {
		t.Fatalf("%+v", found)
	}
	unreadable := DecideAcceptedProbe(ProbeMemory{Passes: 7, Observation: "unreadable"}, SightUnreadable, Found{})
	if unreadable.Kind != "give_up" || unreadable.Passes != 8 {
		t.Fatalf("%+v", unreadable)
	}
	if acceptedProbeBackoffSecs(0) != 15 || acceptedProbeBackoffSecs(1) != 30 || acceptedProbeBackoffSecs(4) != 240 || acceptedProbeBackoffSecs(5) != 300 {
		t.Fatal(acceptedProbeBackoffSecs(0), acceptedProbeBackoffSecs(1), acceptedProbeBackoffSecs(4), acceptedProbeBackoffSecs(5))
	}
}
