package domain

// Five listing_rows facts, copied from src/listing/kernel/facts.rs at a03d735.
// These strings are the column values and the kernel's fact names. They are
// not a second state machine: unknown values fail toward more work.

// ContentFact maps content_state.
func ContentFact(contentState string) string {
	switch contentState {
	case "recognizing":
		return "running"
	case "ready":
		return "ready"
	case "failed":
		return "failed"
	default:
		return "missing"
	}
}

// MediaFact maps media_state. pending, rendered, and anything unknown are missing.
func MediaFact(mediaState string) string {
	switch mediaState {
	case "processing", "uploading":
		return "running"
	case "ready":
		return "ready"
	case "failed":
		return "failed"
	default:
		return "missing"
	}
}

// ValidationFact maps validation_state. stale and unknown ask for revalidation.
func ValidationFact(validationState string) string {
	switch validationState {
	case "blocked":
		return "blocked"
	case "passed":
		return "passed"
	default:
		return "stale"
	}
}

// SubmissionFact maps a submission state. cancelled and superseded read as none.
// unknown, operator_attested, and any later value read as unknown.
func SubmissionFact(submissionState string) string {
	switch submissionState {
	case "none", "cancelled", "superseded":
		return "none"
	case "queued":
		return "queued"
	case "submitting":
		return "submitting"
	case "accepted", "reconciled":
		return "accepted"
	case "rejected", "conflict":
		return "rejected"
	default:
		return "unknown"
	}
}

// SubmissionColumn prefers the latest intent state, then the row column.
// A missing or non-string intent state keeps the column. Matches
// facts.rs submission_state.
func SubmissionColumn(column string, latestIntentState string, hasIntentState bool) string {
	if hasIntentState {
		return latestIntentState
	}
	return column
}

// CandidatesSettled is true when there is no candidate list, or every
// candidate state is confirmed or rejected. A missing state is unsettled.
func CandidatesSettled(states []string, present bool) bool {
	if !present {
		return true
	}
	for _, state := range states {
		if state != "confirmed" && state != "rejected" {
			return false
		}
	}
	return true
}
