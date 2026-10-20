package domain

import "github.com/xxww0098/podhub-go/internal/supply/contract"

// Procurement statuses are ck_sc_procurements_status in
// db/migrations/00122_supply_chain_procurements.sql. No function in
// db/migrations updates sc_procurements.status, so every edge is refused.
func ValidProcurementStatus(status string) bool {
	switch status {
	case "prepared", "dispatching", "accepted", "rejected", "unknown":
		return true
	default:
		return false
	}
}

// TransitionProcurement refuses every edge, including a no-op.
func TransitionProcurement(from, to string) error {
	return contract.ErrUnproven
}
