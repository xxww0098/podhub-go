package domain

import (
	"strings"

	"github.com/xxww0098/podhub-go/internal/agent/contract"
)

// Withdrawal statuses are agent_withdrawals_status_known.
const (
	StatusNone     = ""
	StatusPending  = "pending"
	StatusPaid     = "paid"
	StatusRejected = "rejected"
)

// Edges are the only transitions whose resulting row satisfies
// agent_withdrawals_terminal_shape. Pay and reject are admin outcomes;
// request is the agent endpoint. The migration has no separate transition
// function, so a pair outside this set is illegal.
const (
	EdgeRequest = "request"
	EdgePay     = "pay"
	EdgeReject  = "reject"
)

// WithdrawalShape is the row shape after a legal edge. Decided means
// decided_at and decided_by_user_id are both required. Reference stays empty:
// the paid CHECK allows it, but no statement in the migration sets it.
type WithdrawalShape struct {
	Status  string
	Decided bool
	Reason  string
}

// ApplyWithdrawal moves a withdrawal along one named edge.
// reason is required only for reject, and must survive btrim, matching
// agent_withdrawals_terminal_shape.
func ApplyWithdrawal(from, edge, reason string) (WithdrawalShape, error) {
	switch edge {
	case EdgeRequest:
		if from != StatusNone {
			return WithdrawalShape{}, contract.ErrIllegalEdge
		}
		return WithdrawalShape{Status: StatusPending}, nil
	case EdgePay:
		if from != StatusPending {
			return WithdrawalShape{}, contract.ErrIllegalEdge
		}
		return WithdrawalShape{Status: StatusPaid, Decided: true}, nil
	case EdgeReject:
		if from != StatusPending {
			return WithdrawalShape{}, contract.ErrIllegalEdge
		}
		trimmed := strings.TrimSpace(reason)
		if trimmed == "" {
			return WithdrawalShape{}, contract.ErrInvalidShape
		}
		return WithdrawalShape{Status: StatusRejected, Decided: true, Reason: trimmed}, nil
	default:
		return WithdrawalShape{}, contract.ErrIllegalEdge
	}
}

// RequestAllowed reports the partial unique index
// agent_withdrawals_one_pending_per_user. A second pending row is illegal.
func RequestAllowed(openPending bool) error {
	if openPending {
		return contract.ErrIllegalEdge
	}
	return nil
}
