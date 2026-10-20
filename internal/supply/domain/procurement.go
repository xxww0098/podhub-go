package domain

// Procurement statuses are ck_sc_procurements_status in
// db/migrations/00122_supply_chain_procurements.sql. No function in
// db/migrations updates sc_procurements.status; this package validates filters only.
func ValidProcurementStatus(status string) bool {
	switch status {
	case "prepared", "dispatching", "accepted", "rejected", "unknown":
		return true
	default:
		return false
	}
}
