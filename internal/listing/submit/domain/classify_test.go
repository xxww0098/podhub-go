package domain

import "testing"

func TestClassifyMatchesDispatchOutcomes(t *testing.T) {
	cases := []struct {
		name  string
		reply Reply
		want  Outcome
	}{
		{
			name:  "kill switch",
			reply: Reply{WritesDisabled: true},
			want: Outcome{
				Edge: RejectQueued, IntentState: Rejected, IntentError: CodeWritesDisabled,
				JobState: "failed", JobError: CodeWritesDisabled,
			},
		},
		{
			name:  "connect",
			reply: Reply{Connect: true},
			want: Outcome{
				Edge: RejectQueued, IntentState: Rejected, IntentError: CodeEgressUnreachable,
				JobState: "failed", JobError: CodeEgressUnreachable,
			},
		},
		{
			name:  "success",
			reply: Reply{Sent: true, Status: 200, TaskID: 42, Body: `{"result":{"task_id":42}}`},
			want: Outcome{
				Edge: AcceptInFlight, IntentState: Accepted, JobState: "succeeded", JobResult: "accepted",
				WriteState: "settled", WriteStatus: 200, WriteBody: `{"result":{"task_id":42}}`,
				Occupancy: "released", ReleaseReason: "relationship_confirmed", Requests: 1,
			},
		},
		{
			name:  "reject",
			reply: Reply{Sent: true, Status: 400, Body: `{"code":3}`},
			want: Outcome{
				Edge: RejectSubmitting, IntentState: Rejected, IntentError: CodeRowRejected,
				JobState: "failed", JobError: CodeRowRejected,
				WriteState: "settled", WriteStatus: 400, WriteBody: `{"code":3}`,
				Occupancy: "released", ReleaseReason: "rejected_no_pending", Requests: 1,
			},
		},
		{
			name:  "429",
			reply: Reply{Sent: true, Status: 429, Body: `{"code":8}`},
			want: Outcome{
				Edge: RejectSubmitting, IntentState: Rejected, IntentError: CodeRateLimited,
				JobState: "failed", JobError: CodeRateLimited,
				WriteState: "settled", WriteStatus: 429, WriteBody: `{"code":8}`,
				Occupancy: "released", ReleaseReason: "rejected_no_pending", Requests: 1,
			},
		},
		{
			name:  "timeout",
			reply: Reply{Sent: true, Status: 0},
			want: Outcome{
				Edge: ParkSubmitting, IntentState: Unknown, IntentError: CodeDispatchInterrupted,
				JobState: "succeeded", JobError: CodeDispatchInterrupted, JobResult: "unknown",
				WriteState: "result_unknown", Occupancy: "held", Requests: 1,
			},
		},
		{
			name:  "lost",
			reply: Reply{Sent: true, Status: 0},
			want: Outcome{
				Edge: ParkSubmitting, IntentState: Unknown, IntentError: CodeDispatchInterrupted,
				JobState: "succeeded", JobError: CodeDispatchInterrupted, JobResult: "unknown",
				WriteState: "result_unknown", Occupancy: "held", Requests: 1,
			},
		},
		{
			name:  "crash after send",
			reply: Reply{Sent: true, Status: 200, TaskID: 7, Body: `{}`, CrashAfterSend: true},
			want: Outcome{
				Edge: ParkSubmitting, IntentState: Unknown, IntentError: CodeDispatchInterrupted,
				JobState: "succeeded", JobError: CodeDispatchInterrupted, JobResult: "unknown",
				WriteState: "result_unknown", Occupancy: "held", Requests: 1,
			},
		},
		{
			name:  "2xx without task",
			reply: Reply{Sent: true, Status: 200, Body: `{}`},
			want: Outcome{
				Edge: ParkSubmitting, IntentState: Unknown, IntentError: CodeDispatchInterrupted,
				JobState: "succeeded", JobError: CodeDispatchInterrupted, JobResult: "unknown",
				WriteState: "settled", WriteStatus: 200, WriteBody: `{}`,
				Occupancy: "held", Requests: 1,
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Classify(tc.reply)
			if got != tc.want {
				t.Fatalf("got %+v\nwant %+v", got, tc.want)
			}
			if tc.want.Requests == 0 && got.WriteState != "" {
				t.Fatal("a refusal before send wrote an upstream row")
			}
		})
	}
}

func TestRecoverDoesNotSendAgain(t *testing.T) {
	got := RecoverSubmitting()
	if got.Requests != 0 || got.IntentState != Unknown || got.Edge != ParkSubmitting || got.WriteState != "result_unknown" {
		t.Fatalf("%+v", got)
	}
	if _, err := Apply(Submitting, got.Edge); err != nil {
		t.Fatal(err)
	}
}

func TestProviderCodes(t *testing.T) {
	cred := Classify(Reply{Sent: true, Status: 403, ProviderCode: 16, Body: `x`})
	if cred.IntentError != CodeCredentialInvalid {
		t.Fatal(cred.IntentError)
	}
	denied := Classify(Reply{Sent: true, Status: 403, ProviderCode: 7, Body: `x`})
	if denied.IntentError != CodePermissionDenied {
		t.Fatal(denied.IntentError)
	}
}
