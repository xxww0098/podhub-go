package domain

import "time"

// Intent states. granted and unknown hold the warehouse fence.
const (
	StateGranted  = "granted"
	StateAccepted = "accepted"
	StateRejected = "rejected"
	StateUnknown  = "unknown"
)

const (
	CodeInterrupted    = "OZON_DISPATCH_INTERRUPTED"
	CodeRejected       = "OZON_ROW_REJECTED"
	CodeAccess         = "OZON_ACCESS_UNCLASSIFIED"
	CodeWritesDisabled = "OZON_WRITES_DISABLED"
)

// GrantTTL is how long a replay of the same client operation returns
// grant_in_flight instead of grant_expired. The number matches the listing
// browser grant. It is not an Ozon field.
const GrantTTL = 120 * time.Second

// ActiveStatus is the only warehouse status the existing products reader
// treats as active. Archive requires this exact value.
const ActiveStatus = "created"

// Allows is the named edge table. Any other pair is illegal.
func Allows(from, to string) bool {
	switch from + "->" + to {
	case StateGranted + "->" + StateAccepted,
		StateGranted + "->" + StateRejected,
		StateGranted + "->" + StateUnknown:
		return true
	default:
		return false
	}
}

// ClassifyReport maps a browser report onto one legal edge.
// A nil or non-positive status is unknown and keeps the fence.
// 2xx without an operation id is unknown. 4xx releases the fence.
// 5xx and every other status keep the fence as unknown.
func ClassifyReport(status *int, operationID string) (state, code string) {
	if status == nil || *status <= 0 {
		return StateUnknown, CodeInterrupted
	}
	switch {
	case *status >= 200 && *status < 300:
		if operationID == "" {
			return StateUnknown, CodeInterrupted
		}
		return StateAccepted, ""
	case *status == 403:
		return StateRejected, CodeAccess
	case *status >= 400 && *status < 500:
		return StateRejected, CodeRejected
	default:
		return StateUnknown, CodeInterrupted
	}
}

// Expired reports whether a grant issued at `at` is past GrantTTL at now.
func Expired(at, now time.Time) bool {
	if at.IsZero() {
		return false
	}
	return !now.Before(at.Add(GrantTTL))
}
