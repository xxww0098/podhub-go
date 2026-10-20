package domain

// Classification of one /v3/product/import exchange.
//
// The branches are submit_dispatch/transport.rs classify_seller_error and
// submit/outcomes.rs settle_submit_dispatch at a03d735. A connect failure
// is pre_dispatch and the intent is still queued, so the edge is
// RejectQueued. After Begin, a response is submit-stage: business and rate
// limits use RejectSubmitting and fail the job; a lost response or a 2xx
// without a positive task id is OutcomeUnknown, parks the intent, and
// succeeds the job with outcome unknown. A positive task id uses
// AcceptInFlight.
//
// Seller write rows follow seller_upstream_writes_response_shape: only
// settled carries a status and body. A sent request with no response is
// result_unknown. The kill switch returns before any request, so it writes
// no upstream row.

const (
	CodeWritesDisabled      = "OZON_WRITES_DISABLED"
	CodeRowRejected         = "OZON_ROW_REJECTED"
	CodeRateLimited         = "OZON_RATE_LIMITED"
	CodeDispatchInterrupted = "OZON_DISPATCH_INTERRUPTED"
	CodeCredentialInvalid   = "OZON_CREDENTIAL_INVALID"
	CodePermissionDenied    = "OZON_PERMISSION_DENIED"
	CodeAccessUnclassified  = "OZON_ACCESS_UNCLASSIFIED"
	CodeEgressUnreachable   = "OZON_EGRESS_UNREACHABLE"
	CodeEgressUnavailable   = "OZON_EGRESS_UNAVAILABLE"
	// CodeSubmitInFlight is the variant IntentErrorCode::OzonSubmitInFlight.
	// The string spelling was not in the files read; see the parity note.
	CodeSubmitInFlight = "OZON_SUBMIT_IN_FLIGHT"
)

// Reply is what the loopback mock returned. Status 0 means no HTTP status.
type Reply struct {
	Status       int
	Body         string
	TaskID       int64
	ProviderCode int64
	// Sent is true once the request left the process.
	Sent bool
	// Connect is a failure before the body could reach the mock.
	Connect bool
	// CrashAfterSend stops before the receipt commit.
	CrashAfterSend bool
	// WritesDisabled is the kill switch, checked before admit.
	WritesDisabled bool
}

// Outcome is the row a single attempt must leave. WriteStatus 0 means the
// status column is null. Occupancy empty means no occupancy row.
type Outcome struct {
	Edge          Edge
	IntentState   string
	IntentError   string
	JobState      string
	JobError      string
	JobResult     string
	WriteState    string
	WriteStatus   int
	WriteBody     string
	Occupancy     string
	ReleaseReason string
	Requests      int
}

// Classify is the pure mapping. It does not dial and does not write.
func Classify(reply Reply) Outcome {
	if reply.WritesDisabled {
		return Outcome{
			Edge:        RejectQueued,
			IntentState: Rejected,
			IntentError: CodeWritesDisabled,
			JobState:    "failed",
			JobError:    CodeWritesDisabled,
			Requests:    0,
		}
	}
	if reply.Connect || !reply.Sent {
		return Outcome{
			Edge:        RejectQueued,
			IntentState: Rejected,
			IntentError: CodeEgressUnreachable,
			JobState:    "failed",
			JobError:    CodeEgressUnreachable,
			Requests:    0,
		}
	}
	if reply.CrashAfterSend {
		return Outcome{
			Edge:        ParkSubmitting,
			IntentState: Unknown,
			IntentError: CodeDispatchInterrupted,
			JobState:    "succeeded",
			JobError:    CodeDispatchInterrupted,
			JobResult:   "unknown",
			WriteState:  "result_unknown",
			Occupancy:   "held",
			Requests:    1,
		}
	}
	if reply.Status >= 200 && reply.Status < 300 && reply.TaskID > 0 {
		return Outcome{
			Edge:          AcceptInFlight,
			IntentState:   Accepted,
			JobState:      "succeeded",
			JobResult:     "accepted",
			WriteState:    "settled",
			WriteStatus:   reply.Status,
			WriteBody:     reply.Body,
			Occupancy:     "released",
			ReleaseReason: "relationship_confirmed",
			Requests:      1,
		}
	}
	code, _ := submitCode(reply)
	unknown := code == CodeDispatchInterrupted
	out := Outcome{
		IntentError: code,
		JobError:    code,
		Requests:    1,
		Occupancy:   "held",
	}
	if unknown {
		out.Edge = ParkSubmitting
		out.IntentState = Unknown
		out.JobState = "succeeded"
		out.JobResult = "unknown"
		if reply.Status == 0 {
			out.WriteState = "result_unknown"
		} else {
			out.WriteState = "settled"
			out.WriteStatus = reply.Status
			out.WriteBody = reply.Body
		}
		return out
	}
	out.Edge = RejectSubmitting
	out.IntentState = Rejected
	out.JobState = "failed"
	out.WriteState = "settled"
	out.WriteStatus = reply.Status
	out.WriteBody = reply.Body
	out.Occupancy = "released"
	out.ReleaseReason = "rejected_no_pending"
	return out
}

func submitCode(reply Reply) (string, bool) {
	switch reply.Status {
	case 401:
		return CodeCredentialInvalid, false
	case 403:
		if reply.ProviderCode == 16 {
			return CodeCredentialInvalid, false
		}
		if reply.ProviderCode == 7 {
			return CodePermissionDenied, false
		}
		return CodeAccessUnclassified, false
	case 400, 422:
		return CodeRowRejected, false
	case 429:
		return CodeRateLimited, false
	case 408:
		return CodeDispatchInterrupted, true
	}
	if reply.Status >= 400 && reply.Status <= 499 {
		return CodeAccessUnclassified, false
	}
	return CodeDispatchInterrupted, true
}

// RecoverSubmitting is the branch in execute_listing_submit for an intent
// already submitting with no task id: park it, do not send again.
func RecoverSubmitting() Outcome {
	return Outcome{
		Edge:        ParkSubmitting,
		IntentState: Unknown,
		IntentError: CodeSubmitInFlight,
		JobState:    "succeeded",
		JobError:    CodeSubmitInFlight,
		JobResult:   "unknown",
		WriteState:  "result_unknown",
		Occupancy:   "held",
		Requests:    0,
	}
}
