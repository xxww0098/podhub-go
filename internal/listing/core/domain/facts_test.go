package domain

import "testing"

func TestPhaseFactsMatchRust(t *testing.T) {
	// facts.rs phase_facts_map_the_four_orthogonal_states
	if ContentFact("draft") != "missing" || ContentFact("recognizing") != "running" ||
		ContentFact("ready") != "ready" || ContentFact("failed") != "failed" {
		t.Fatalf("content facts")
	}
	if MediaFact("pending") != "missing" || MediaFact("processing") != "running" ||
		MediaFact("rendered") != "missing" || MediaFact("uploading") != "running" ||
		MediaFact("ready") != "ready" || MediaFact("failed") != "failed" {
		t.Fatalf("media facts")
	}
	if ValidationFact("stale") != "stale" || ValidationFact("blocked") != "blocked" ||
		ValidationFact("passed") != "passed" {
		t.Fatalf("validation facts")
	}
	if SubmissionFact("none") != "none" || SubmissionFact("queued") != "queued" ||
		SubmissionFact("submitting") != "submitting" || SubmissionFact("unknown") != "unknown" ||
		SubmissionFact("accepted") != "accepted" || SubmissionFact("rejected") != "rejected" ||
		SubmissionFact("reconciled") != "accepted" || SubmissionFact("conflict") != "rejected" ||
		SubmissionFact("operator_attested") != "unknown" {
		t.Fatalf("submission facts")
	}
}

func TestCancelledSubmissionReadsAsNeverSubmitted(t *testing.T) {
	if SubmissionFact("cancelled") != "none" || SubmissionFact("superseded") != "none" {
		t.Fatal(SubmissionFact("cancelled"))
	}
}

func TestUnknownColumnValuesFailTowardsMoreWork(t *testing.T) {
	if ContentFact("teleported") != "missing" || MediaFact("teleported") != "missing" ||
		ValidationFact("teleported") != "stale" || SubmissionFact("teleported") != "unknown" {
		t.Fatal("unknown facts")
	}
}

func TestCandidatesSettled(t *testing.T) {
	if !CandidatesSettled(nil, false) || !CandidatesSettled(nil, true) {
		t.Fatal("empty")
	}
	if !CandidatesSettled([]string{"confirmed", "rejected"}, true) {
		t.Fatal("settled")
	}
	if CandidatesSettled([]string{"confirmed", "proposed"}, true) ||
		CandidatesSettled([]string{"unresolved"}, true) ||
		CandidatesSettled([]string{""}, true) {
		t.Fatal("unsettled")
	}
}

func TestLatestIntentOverridesColumn(t *testing.T) {
	if SubmissionColumn("none", "accepted", true) != "accepted" {
		t.Fatal("intent")
	}
	if SubmissionColumn("queued", "", false) != "queued" {
		t.Fatal("column")
	}
}
