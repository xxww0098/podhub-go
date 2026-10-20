package adminhttp

// Route table for this file. Do not edit by hand.

// Guard is which session check runs before the 501 body.
type Guard string

const (
	// GuardStaff is platform staff (admin or super_admin).
	GuardStaff Guard = "staff"
	// GuardSuper is require_super_admin.
	GuardSuper Guard = "super"
	// GuardInferred is an unverified helper. Fail closed as super_admin.
	GuardInferred Guard = "inferred"
	// GuardWorkspace is a workspace session (org_id required).
	GuardWorkspace Guard = "workspace"
	// GuardPrice is require_price_publisher. Fail closed as super_admin.
	GuardPrice Guard = "price"
	// GuardLogin is any signed-in principal.
	GuardLogin Guard = "login"
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

// SupplierRoutes is the route table for this file.
func SupplierRoutes() []Route {
	return []Route{
		{Method: "GET", Path: "/api/admin/supplier-accounts", OperationID: "list_supplier_accounts", RustOperationID: "list_supplier_accounts", Guard: GuardStaff, Source: "src/supplier_portal/accounts.rs"},
		{Method: "POST", Path: "/api/admin/supplier-accounts", OperationID: "create_supplier_account", RustOperationID: "create_supplier_account", Guard: GuardSuper, Source: "src/supplier_portal/accounts.rs"},
		{Method: "DELETE", Path: "/api/admin/supplier-accounts/{member_id}", OperationID: "delete_supplier_account", RustOperationID: "delete_supplier_account", Guard: GuardStaff, Source: "src/supplier_portal/accounts.rs"},
		{Method: "PATCH", Path: "/api/admin/supplier-accounts/{member_id}", OperationID: "patch_supplier_account", RustOperationID: "patch_supplier_account", Guard: GuardSuper, Source: "src/supplier_portal/accounts.rs"},
		{Method: "GET", Path: "/api/admin/supplier-automation/grants", OperationID: "supplier_automation_grants_list", RustOperationID: "supplier_automation_grants_list", Guard: GuardStaff, Source: "src/automation/api/platform_grants.rs"},
		{Method: "POST", Path: "/api/admin/supplier-automation/grants", OperationID: "supplier_automation_grant_create", RustOperationID: "supplier_automation_grant_create", Guard: GuardStaff, Source: "src/automation/api/platform_grants.rs"},
		{Method: "POST", Path: "/api/admin/supplier-automation/grants/{id}/revoke", OperationID: "supplier_automation_grant_revoke", RustOperationID: "supplier_automation_grant_revoke", Guard: GuardStaff, Source: "src/automation/api/platform_grants.rs"},
		{Method: "POST", Path: "/api/admin/supplier-db-storage/directories", OperationID: "admin_supplier_db_storage_directories_create", RustOperationID: "admin_supplier_db_storage_directories_create", Guard: GuardSuper, Source: "src/platform/supplier_dbs/storage_objects.rs"},
		{Method: "GET", Path: "/api/admin/supplier-db-storage/objects", OperationID: "admin_supplier_db_storage_objects_list", RustOperationID: "admin_supplier_db_storage_objects_list", Guard: GuardSuper, Source: "src/platform/supplier_dbs/storage_objects.rs"},
		{Method: "POST", Path: "/api/admin/supplier-db-storage/objects/delete", OperationID: "admin_supplier_db_storage_objects_delete", RustOperationID: "admin_supplier_db_storage_objects_delete", Guard: GuardSuper, Source: "src/platform/supplier_dbs/storage_objects.rs"},
		{Method: "POST", Path: "/api/admin/supplier-db-storage/objects/move", OperationID: "admin_supplier_db_storage_objects_move", RustOperationID: "admin_supplier_db_storage_objects_move", Guard: GuardSuper, Source: "src/platform/supplier_dbs/storage_objects.rs"},
		{Method: "POST", Path: "/api/admin/supplier-db-storage/uploads", OperationID: "admin_supplier_db_storage_uploads_create", RustOperationID: "admin_supplier_db_storage_uploads_create", Guard: GuardSuper, Source: "src/platform/supplier_dbs/storage_uploads.rs"},
		{Method: "GET", Path: "/api/admin/supplier-dbs", OperationID: "list_supplier_dbs", RustOperationID: "list_supplier_dbs", Guard: GuardStaff, Source: "src/platform/supplier_dbs/databases.rs"},
		{Method: "POST", Path: "/api/admin/supplier-dbs", OperationID: "create_supplier_db", RustOperationID: "create_supplier_db", Guard: GuardStaff, Source: "src/platform/supplier_dbs/databases.rs"},
		{Method: "DELETE", Path: "/api/admin/supplier-dbs/{source_id}", OperationID: "delete_supplier_db", RustOperationID: "delete_supplier_db", Guard: GuardStaff, Source: "src/platform/supplier_dbs/databases.rs"},
		{Method: "GET", Path: "/api/admin/supplier-dbs/{source_id}", OperationID: "get_supplier_db", RustOperationID: "get_supplier_db", Guard: GuardStaff, Source: "src/platform/supplier_dbs/databases.rs"},
		{Method: "PUT", Path: "/api/admin/supplier-dbs/{source_id}", OperationID: "update_supplier_db", RustOperationID: "update_supplier_db", Guard: GuardStaff, Source: "src/platform/supplier_dbs/databases.rs"},
		{Method: "POST", Path: "/api/admin/supplier-dbs/{source_id}/props", OperationID: "create_supplier_db_prop", RustOperationID: "create_supplier_db_prop", Guard: GuardStaff, Source: "src/platform/supplier_dbs/props.rs"},
		{Method: "DELETE", Path: "/api/admin/supplier-dbs/{source_id}/props/{prop_id}", OperationID: "delete_supplier_db_prop", RustOperationID: "delete_supplier_db_prop", Guard: GuardStaff, Source: "src/platform/supplier_dbs/props.rs"},
		{Method: "PUT", Path: "/api/admin/supplier-dbs/{source_id}/props/{prop_id}", OperationID: "update_supplier_db_prop", RustOperationID: "update_supplier_db_prop", Guard: GuardStaff, Source: "src/platform/supplier_dbs/props.rs"},
		{Method: "POST", Path: "/api/admin/supplier-dbs/{source_id}/rows", OperationID: "create_supplier_db_row", RustOperationID: "create_supplier_db_row", Guard: GuardStaff, Source: "src/platform/supplier_dbs/rows.rs"},
		{Method: "DELETE", Path: "/api/admin/supplier-dbs/{source_id}/rows/{product_id}", OperationID: "delete_supplier_db_row", RustOperationID: "delete_supplier_db_row", Guard: GuardStaff, Source: "src/platform/supplier_dbs/rows.rs"},
		{Method: "PUT", Path: "/api/admin/supplier-dbs/{source_id}/rows/{product_id}", OperationID: "update_supplier_db_row", RustOperationID: "update_supplier_db_row", Guard: GuardStaff, Source: "src/platform/supplier_dbs/rows.rs"},
		{Method: "GET", Path: "/api/admin/supplier-dbs/{source_id}/rows/{product_id}/ozon-config", OperationID: "get_supplier_ozon_config", RustOperationID: "get_supplier_ozon_config", Guard: GuardStaff, Source: "src/platform/supplier_dbs/ozon_config_api.rs"},
		{Method: "PUT", Path: "/api/admin/supplier-dbs/{source_id}/rows/{product_id}/ozon-config", OperationID: "put_supplier_ozon_config", RustOperationID: "put_supplier_ozon_config", Guard: GuardStaff, Source: "src/platform/supplier_dbs/ozon_config_api.rs"},
		{Method: "POST", Path: "/api/admin/supplier-dbs/{source_id}/rows/{product_id}/price", OperationID: "adjust_supplier_db_price", RustOperationID: "adjust_supplier_db_price", Guard: GuardStaff, Source: "src/platform/supplier_dbs/rows.rs"},
		{Method: "GET", Path: "/api/admin/supplier-dbs/{source_id}/rows/{product_id}/prompt/diff", OperationID: "diff_supplier_prompt", RustOperationID: "diff_supplier_prompt", Guard: GuardStaff, Source: "src/platform/supplier_dbs/prompt_authoring.rs"},
		{Method: "POST", Path: "/api/admin/supplier-dbs/{source_id}/rows/{product_id}/prompt/preview", OperationID: "preview_supplier_prompt", RustOperationID: "preview_supplier_prompt", Guard: GuardStaff, Source: "src/platform/supplier_dbs/prompt_authoring.rs"},
		{Method: "POST", Path: "/api/admin/supplier-dbs/{source_id}/rows/{product_id}/prompt/publish", OperationID: "publish_supplier_prompt_revision", RustOperationID: "publish_supplier_prompt_revision", Guard: GuardStaff, Source: "src/platform/supplier_dbs/prompt_authoring.rs"},
		{Method: "POST", Path: "/api/admin/supplier-dbs/{source_id}/rows/{product_id}/publish", OperationID: "publish_supplier_db_row", RustOperationID: "publish_supplier_db_row", Guard: GuardStaff, Source: "src/platform/supplier_dbs/rows.rs"},
		{Method: "POST", Path: "/api/admin/supplier-dbs/{source_id}/rows/{product_id}/unpublish", OperationID: "unpublish_supplier_db_row", RustOperationID: "unpublish_supplier_db_row", Guard: GuardStaff, Source: "src/platform/supplier_dbs/rows.rs"},
		{Method: "POST", Path: "/api/admin/supplier-dbs/{source_id}/uploads", OperationID: "presign_supplier_db_upload", RustOperationID: "presign_supplier_db_upload", Guard: GuardStaff, Source: "src/platform/supplier_dbs/uploads.rs"},
		{Method: "POST", Path: "/api/admin/supplier-dbs/{source_id}/uploads/abort", OperationID: "abort_supplier_db_upload", RustOperationID: "abort_supplier_db_upload", Guard: GuardStaff, Source: "src/platform/supplier_dbs/uploads.rs"},
		{Method: "POST", Path: "/api/admin/supplier-dbs/{source_id}/uploads/confirm", OperationID: "confirm_supplier_db_upload", RustOperationID: "confirm_supplier_db_upload", Guard: GuardStaff, Source: "src/platform/supplier_dbs/uploads.rs"},
		{Method: "GET", Path: "/api/admin/supplier-prompts", OperationID: "list_supplier_prompts", RustOperationID: "list_supplier_prompts", Guard: GuardStaff, Source: "src/platform/supplier_dbs/prompts.rs"},
		{Method: "POST", Path: "/api/admin/supplier-prompts/sync", OperationID: "sync_supplier_prompts", RustOperationID: "sync_supplier_prompts", Guard: GuardSuper, Source: "src/platform/supplier_dbs/prompt_sync.rs"},
		{Method: "PATCH", Path: "/api/admin/supplier-prompts/{product_id}", OperationID: "patch_supplier_prompt", RustOperationID: "patch_supplier_prompt", Guard: GuardStaff, Source: "src/platform/supplier_dbs/prompts.rs"},
		{Method: "GET", Path: "/api/admin/supplier-withdrawals", OperationID: "list_factory_withdrawals", RustOperationID: "list_factory_withdrawals", Guard: GuardStaff, Source: "src/supplier_portal/wallet.rs"},
		{Method: "POST", Path: "/api/admin/supplier-withdrawals/{withdrawal_id}/pay", OperationID: "pay_withdrawal", RustOperationID: "pay_withdrawal", Guard: GuardStaff, Source: "src/supplier_portal/wallet.rs"},
		{Method: "POST", Path: "/api/admin/supplier-withdrawals/{withdrawal_id}/reject", OperationID: "reject_withdrawal", RustOperationID: "reject_withdrawal", Guard: GuardStaff, Source: "src/supplier_portal/wallet.rs"},
	}
}
