package domain

import "github.com/xxww0098/podhub-go/internal/supply/contract"

// Order statuses are ck_sc_orders_status after
// db/migrations/00122_supply_chain_procurements.sql. No function in
// db/migrations updates sc_orders.status, so every edge is refused.
func ValidOrderStatus(status string) bool {
	switch status {
	case "awaiting_payment", "awaiting_procurement", "processing", "in_production", "shipped":
		return true
	default:
		return false
	}
}

// TransitionOrder refuses every edge, including a no-op.
func TransitionOrder(from, to string) error {
	return contract.ErrUnproven
}
