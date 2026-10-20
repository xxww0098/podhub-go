// Package domain is the automation state vocabulary.
// Status and action strings are the CHECK constraints in
// db/migrations/00182_automation_commands.sql. The transition table is the
// WHERE clause of claim, renew, progress, settle, and deregister.
package domain

import "github.com/xxww0098/podhub-go/internal/automation/contract"

// Command statuses. Order matches the CHECK list.
const (
	StatusQueued    = "queued"
	StatusClaimed   = "claimed"
	StatusCompleted = "completed"
	StatusFailed    = "failed"
	StatusCanceled  = "canceled"
)

// Command actions. Order matches the CHECK list.
const (
	ActionAssetsImport   = "assets_import"
	ActionListingPrepare = "listing_prepare"
)

// Named edges. release is deregister's UPDATE of claimed rows.
const (
	EdgeClaim           = "claim"
	EdgeRenew           = "renew"
	EdgeProgress        = "progress"
	EdgeSettleCompleted = "settle_completed"
	EdgeSettleFailed    = "settle_failed"
	EdgeSettleCanceled  = "settle_canceled"
	EdgeRelease         = "release"
)

// Lease and stale windows. SQL writes interval '90 seconds'. live uses 45s.
const (
	ClaimLeaseSeconds  int64 = 90
	RuntimeStaleMillis int64 = 45 * 1000
	ClaimLimitDefault  int64 = 4
	ClaimLimitMin      int64 = 1
	ClaimLimitMax      int64 = 8
)

// Lease controls returned by renew.
const (
	ControlContinue = "continue"
	ControlCancel   = "cancel"
	ControlLost     = "lost"
)

// Gate is the set of predicates the command SQL evaluates besides status.
// RuntimeLive means the runtime row exists and deregistered_at is null.
type Gate struct {
	RuntimeLive     bool
	LeaseExpired    bool
	EpochMatch      bool
	GrantLive       bool
	SameRuntime     bool
	CancelRequested bool
}

// Statuses is the CHECK vocabulary.
func Statuses() []string {
	return []string{StatusQueued, StatusClaimed, StatusCompleted, StatusFailed, StatusCanceled}
}

// Edges is the named edge list.
func Edges() []string {
	return []string{
		EdgeClaim, EdgeRenew, EdgeProgress,
		EdgeSettleCompleted, EdgeSettleFailed, EdgeSettleCanceled,
		EdgeRelease,
	}
}

// ParseStatus accepts only the CHECK vocabulary.
func ParseStatus(raw string) (string, bool) {
	switch raw {
	case StatusQueued, StatusClaimed, StatusCompleted, StatusFailed, StatusCanceled:
		return raw, true
	default:
		return "", false
	}
}

// ParseAction accepts only the CHECK vocabulary.
func ParseAction(raw string) (string, bool) {
	switch raw {
	case ActionAssetsImport, ActionListingPrepare:
		return raw, true
	default:
		return "", false
	}
}

// Apply returns the next status when the named edge's WHERE matches.
// An unknown status or edge is a different error from a WHERE miss.
// Renew and progress keep the status. Release (deregister) sends claimed
// back to queued without bumping the epoch. Claim's epoch increment is
// applied by SQL, not by this function.
func Apply(status, edge string, g Gate) (string, error) {
	if _, ok := ParseStatus(status); !ok {
		return "", contract.ErrIllegalStatus
	}
	switch edge {
	case EdgeClaim, EdgeRenew, EdgeProgress, EdgeSettleCompleted, EdgeSettleFailed, EdgeSettleCanceled, EdgeRelease:
	default:
		return "", contract.ErrIllegalEdge
	}
	if !g.RuntimeLive {
		return "", contract.ErrNotApplied
	}
	switch edge {
	case EdgeClaim:
		if g.GrantLive && (status == StatusQueued || (status == StatusClaimed && g.LeaseExpired)) {
			return StatusClaimed, nil
		}
		return "", contract.ErrNotApplied
	case EdgeRenew:
		if status == StatusClaimed && !g.LeaseExpired && g.EpochMatch && g.GrantLive && g.SameRuntime {
			return StatusClaimed, nil
		}
		return "", contract.ErrNotApplied
	case EdgeProgress:
		if held(status, g) {
			return StatusClaimed, nil
		}
		return "", contract.ErrNotApplied
	case EdgeSettleCompleted:
		if held(status, g) {
			return StatusCompleted, nil
		}
		return "", contract.ErrNotApplied
	case EdgeSettleFailed:
		if held(status, g) {
			return StatusFailed, nil
		}
		return "", contract.ErrNotApplied
	case EdgeSettleCanceled:
		if held(status, g) {
			return StatusCanceled, nil
		}
		return "", contract.ErrNotApplied
	case EdgeRelease:
		if status == StatusClaimed && g.SameRuntime {
			return StatusQueued, nil
		}
		return "", contract.ErrNotApplied
	default:
		return "", contract.ErrIllegalEdge
	}
}

// held is the progress/settle predicate: claimed, unexpired, epoch and runtime match.
// Grant liveness is not part of it.
func held(status string, g Gate) bool {
	return status == StatusClaimed && !g.LeaseExpired && g.EpochMatch && g.SameRuntime
}

// RenewControl is continue, cancel, or lost. lost does not extend the lease.
func RenewControl(status string, g Gate) string {
	if _, err := Apply(status, EdgeRenew, g); err != nil {
		return ControlLost
	}
	if g.CancelRequested {
		return ControlCancel
	}
	return ControlContinue
}
