package adminhttp

// Route table for this file. Do not edit by hand.

// CatalogRoutes is the route table for this file.
func CatalogRoutes() []Route {
	return []Route{
		{Method: "GET", Path: "/api/admin/platform-catalog", OperationID: "admin_list", RustOperationID: "admin_list", Guard: GuardSuper, Source: "src/supply_chain/catalog/reads.rs"},
		{Method: "POST", Path: "/api/admin/platform-catalog/products", OperationID: "create_product", RustOperationID: "create_product", Guard: GuardSuper, Source: "src/supply_chain/catalog.rs"},
		{Method: "POST", Path: "/api/admin/platform-catalog/skus", OperationID: "create_sku", RustOperationID: "create_sku", Guard: GuardSuper, Source: "src/supply_chain/catalog.rs"},
	}
}
