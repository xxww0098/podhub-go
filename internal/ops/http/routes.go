package opshttp

// Route table for this file. Do not edit by hand.

// Guard is which session check runs before the 501 body.
type Guard string

const (
	// GuardWorkspace is a workspace session (org_id required).
	GuardWorkspace Guard = "workspace"
	// GuardWrite is admit_write: workspace session, then the seller write gate.
	GuardWrite Guard = "write"
)

// Route is one mounted operation.
type Route struct {
	Method          string
	Path            string
	OperationID     string
	RustOperationID string
	Guard           Guard
	Source          string
}

// Routes is the route table for this file.
func Routes() []Route {
	return []Route{
		{Method: "POST", Path: "/api/ops/console/reconcile", OperationID: "console_reconcile", RustOperationID: "console_reconcile", Guard: GuardWorkspace, Source: "src/ops/console/reconcile.rs"},
		{Method: "POST", Path: "/api/ops/console/refresh-metrics", OperationID: "console_refresh_metrics", RustOperationID: "console_refresh_metrics", Guard: GuardWorkspace, Source: "src/ops/console.rs"},
		{Method: "GET", Path: "/api/ops/console/snapshot", OperationID: "console_snapshot", RustOperationID: "console_snapshot", Guard: GuardWorkspace, Source: "src/ops/console.rs"},
		{Method: "POST", Path: "/api/ops/message-center/history", OperationID: "message_center_history", RustOperationID: "message_center_history", Guard: GuardWorkspace, Source: "src/ops/message_center.rs"},
		{Method: "POST", Path: "/api/ops/message-center/inbox", OperationID: "message_center_inbox", RustOperationID: "message_center_inbox", Guard: GuardWorkspace, Source: "src/ops/message_center.rs"},
		{Method: "POST", Path: "/api/ops/message-center/send", OperationID: "message_center_send", RustOperationID: "message_center_send", Guard: GuardWrite, Source: "src/ops/message_center.rs"},
		{Method: "POST", Path: "/api/ops/products/metrics", OperationID: "products_metrics", RustOperationID: "products_metrics", Guard: GuardWorkspace, Source: "src/ops/products/monitor.rs"},
		{Method: "POST", Path: "/api/ops/products/mutate", OperationID: "products_mutate", RustOperationID: "products_mutate", Guard: GuardWrite, Source: "src/ops/products/mutate.rs"},
		{Method: "POST", Path: "/api/ops/products/promotions", OperationID: "products_promotions", RustOperationID: "products_promotions", Guard: GuardWorkspace, Source: "src/ops/products/promotions.rs"},
		{Method: "POST", Path: "/api/ops/products/sync", OperationID: "products_sync", RustOperationID: "products_sync", Guard: GuardWorkspace, Source: "src/ops/products/monitor.rs"},
		{Method: "POST", Path: "/api/ops/products/warehouses", OperationID: "products_warehouses", RustOperationID: "products_warehouses", Guard: GuardWorkspace, Source: "src/ops/products/warehouses.rs"},
		{Method: "POST", Path: "/api/ops/returns/cancellations", OperationID: "cancellations_list", RustOperationID: "cancellations_list", Guard: GuardWorkspace, Source: "src/ops/returns.rs"},
		{Method: "POST", Path: "/api/ops/returns/list", OperationID: "returns_list", RustOperationID: "returns_list", Guard: GuardWorkspace, Source: "src/ops/returns.rs"},
		{Method: "POST", Path: "/api/ops/shipping/list", OperationID: "shipping_list", RustOperationID: "shipping_list", Guard: GuardWorkspace, Source: "src/ops/shipping.rs"},
		{Method: "POST", Path: "/api/ops/supply/orders", OperationID: "supply_orders", RustOperationID: "supply_orders", Guard: GuardWorkspace, Source: "src/ops/supply.rs"},
		{Method: "POST", Path: "/api/ops/supply/warehouse-stocks", OperationID: "supply_warehouse_stocks", RustOperationID: "supply_warehouse_stocks", Guard: GuardWorkspace, Source: "src/ops/supply.rs"},
		{Method: "POST", Path: "/api/ops/voice/questions", OperationID: "voice_questions", RustOperationID: "voice_questions", Guard: GuardWorkspace, Source: "src/ops/voice.rs"},
		{Method: "POST", Path: "/api/ops/voice/reviews", OperationID: "voice_reviews", RustOperationID: "voice_reviews", Guard: GuardWorkspace, Source: "src/ops/voice.rs"},
	}
}
