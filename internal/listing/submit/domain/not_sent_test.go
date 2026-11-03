package domain

import "testing"

func TestWriteNotSentClosesBegunAttemptWithoutInventingAResponse(t *testing.T) {
	out := WriteNotSent()
	if to, err := Apply(Submitting, out.Edge); err != nil || to != Rejected {
		t.Fatalf("begun attempt not rejected: %s %v", to, err)
	}
	if _, err := Apply(Unknown, out.Edge); err == nil {
		t.Fatal("an unknown attempt cannot be declared unsent")
	}
	if out.JobState != "failed" || out.JobResult != "not_dispatched" || out.JobError != CodeEgressUnavailable || out.IntentError != out.JobError {
		t.Fatalf("no actionable failure: %+v", out)
	}
	if out.Requests != 0 || out.WriteState != "reconciled" || out.WriteStatus != 0 || out.WriteBody != "" || out.Occupancy != "released" || out.ReleaseReason != "not_dispatched" {
		t.Fatalf("unsent attempt retained uncertainty or invented a response: %+v", out)
	}
	uncertain := Classify(Reply{Sent: true})
	if uncertain.IntentState != Unknown || uncertain.WriteState != "result_unknown" || uncertain.Occupancy != "held" || uncertain.Requests != 1 {
		t.Fatalf("unclassified network errors lost their uncertainty: %+v", uncertain)
	}
}
