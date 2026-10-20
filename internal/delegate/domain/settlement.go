package domain

import "github.com/xxww0098/podhub-go/internal/delegate/contract"

// Settlement states are the CHECK on delegate_settlements
// (db/migrations/00258_delegate_settlement.sql). No function in db/migrations
// moves held, settled or released, so every edge is refused.
func ValidSettlement(state string) bool {
	switch state {
	case "held", "settled", "released":
		return true
	default:
		return false
	}
}

// TransitionSettlement refuses every edge, including a no-op.
func TransitionSettlement(from, to string) error {
	return contract.ErrUnproven
}
