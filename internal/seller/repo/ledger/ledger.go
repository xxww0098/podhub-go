package ledger

import "errors"

// Upstream write states. The CHECK is dispatching, settled, result_unknown,
// reconciled, conflict. Only settled carries a response. The named edges
// below are the ones the migration comment and the response-shape CHECK
// allow; see docs/parity/seller-parity.md.

const (
	WriteDispatching   = "dispatching"
	WriteSettled       = "settled"
	WriteResultUnknown = "result_unknown"
	WriteReconciled    = "reconciled"
	WriteConflict      = "conflict"
)

type WriteEdge int

const (
	WriteSettle WriteEdge = iota
	WriteLose
	WriteReconcile
	WriteConflictEdge
)

func (e WriteEdge) From() string {
	switch e {
	case WriteSettle, WriteLose:
		return WriteDispatching
	case WriteReconcile, WriteConflictEdge:
		return WriteResultUnknown
	default:
		return ""
	}
}

func (e WriteEdge) To() string {
	switch e {
	case WriteSettle:
		return WriteSettled
	case WriteLose:
		return WriteResultUnknown
	case WriteReconcile:
		return WriteReconciled
	case WriteConflictEdge:
		return WriteConflict
	default:
		return ""
	}
}

// ErrIllegalWrite is a pair the response-shape CHECK would reject or that
// is not one of the four edges above.
var ErrIllegalWrite = errors.New("illegal seller upstream write edge")

func ApplyWrite(from string, edge WriteEdge) (string, error) {
	if from != edge.From() || edge.To() == "" {
		return "", ErrIllegalWrite
	}
	return edge.To(), nil
}

// Occupancy reasons are the four literals in
// seller_resource_occupancies_release_complete. Which call site picks which
// reason for an import was not located; the submit classifier's choice is
// listed as inferred.
const (
	OccupancyHeld       = "held"
	OccupancyReleased   = "released"
	ReasonNotDispatched = "not_dispatched"
	ReasonRejected      = "rejected_no_pending"
	ReasonConfirmed     = "relationship_confirmed"
	ReasonPartial       = "partial_settled"
)

var releaseReasons = map[string]struct{}{
	ReasonNotDispatched: {},
	ReasonRejected:      {},
	ReasonConfirmed:     {},
	ReasonPartial:       {},
}

// ErrIllegalRelease means a held row would be released without one of the
// four reasons, or a row that is not held would be released.
var ErrIllegalRelease = errors.New("illegal seller occupancy release")

func ReleaseOccupancy(state, reason string) error {
	if state != OccupancyHeld {
		return ErrIllegalRelease
	}
	if _, ok := releaseReasons[reason]; !ok {
		return ErrIllegalRelease
	}
	return nil
}
