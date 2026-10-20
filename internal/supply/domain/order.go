package domain

// Order statuses are ck_sc_orders_status after
// db/migrations/00122_supply_chain_procurements.sql. No function in
// db/migrations updates sc_orders.status; this package validates filters only.
func ValidOrderStatus(status string) bool {
	switch status {
	case "awaiting_payment", "awaiting_procurement", "processing", "in_production", "shipped":
		return true
	default:
		return false
	}
}
