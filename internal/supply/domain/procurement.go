package domain

// Procurement statuses are ck_sc_procurements_status in
// the baseline schema. No function in
// db/migrations updates sc_procurements.status; this package validates filters only.
func ValidProcurementStatus(status string) bool {
	switch status {
	case "prepared", "dispatching", "accepted", "rejected", "unknown":
		return true
	default:
		return false
	}
}
