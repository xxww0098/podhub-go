package domain

// Order statuses are ck_sc_orders_status after
// the baseline schema. No function in
// db/migrations updates sc_orders.status; this package validates filters only.
func ValidOrderStatus(status string) bool {
	switch status {
	case "awaiting_payment", "awaiting_procurement", "processing", "in_production", "shipped":
		return true
	default:
		return false
	}
}
