package automationhttp

// Route table for this file. Do not edit by hand.

// Guard is which session check runs before the 501 body.
type Guard string

const (
	// GuardWorkspace is a workspace session (org_id required).
	GuardWorkspace Guard = "workspace"
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
		{Method: "GET", Path: "/api/automation/asset-sets", OperationID: "automation_asset_sets_list", RustOperationID: "automation_asset_sets_list", Guard: GuardWorkspace, Source: ""},
		{Method: "POST", Path: "/api/automation/asset-sets", OperationID: "automation_asset_set_create", RustOperationID: "automation_asset_set_create", Guard: GuardWorkspace, Source: "src/automation/api/asset_sets.rs"},
		{Method: "POST", Path: "/api/automation/commands/claim", OperationID: "automation_commands_claim", RustOperationID: "automation_commands_claim", Guard: GuardWorkspace, Source: ""},
		{Method: "POST", Path: "/api/automation/commands/renew", OperationID: "automation_command_renew", RustOperationID: "automation_command_renew", Guard: GuardWorkspace, Source: ""},
		{Method: "POST", Path: "/api/automation/commands/{id}/progress", OperationID: "automation_command_progress", RustOperationID: "automation_command_progress", Guard: GuardWorkspace, Source: ""},
		{Method: "POST", Path: "/api/automation/commands/{id}/settle", OperationID: "automation_command_settle", RustOperationID: "automation_command_settle", Guard: GuardWorkspace, Source: ""},
		{Method: "GET", Path: "/api/automation/grants", OperationID: "automation_grants_list", RustOperationID: "automation_grants_list", Guard: GuardWorkspace, Source: "src/automation/api/grant_management.rs"},
		{Method: "POST", Path: "/api/automation/grants", OperationID: "automation_grant_create", RustOperationID: "automation_grant_create", Guard: GuardWorkspace, Source: "src/automation/api/grant_management.rs"},
		{Method: "POST", Path: "/api/automation/grants/{id}/revoke", OperationID: "automation_grant_revoke", RustOperationID: "automation_grant_revoke", Guard: GuardWorkspace, Source: "src/automation/api/grant_management.rs"},
		{Method: "GET", Path: "/api/automation/runtimes", OperationID: "automation_runtimes_list", RustOperationID: "automation_runtimes_list", Guard: GuardWorkspace, Source: ""},
		{Method: "POST", Path: "/api/automation/runtimes", OperationID: "automation_runtime_register", RustOperationID: "automation_runtime_register", Guard: GuardWorkspace, Source: "src/automation/api/runtimes.rs"},
		{Method: "POST", Path: "/api/automation/runtimes/{id}/deregister", OperationID: "automation_runtime_deregister", RustOperationID: "automation_runtime_deregister", Guard: GuardWorkspace, Source: ""},
		{Method: "POST", Path: "/api/automation/runtimes/{id}/heartbeat", OperationID: "automation_runtime_heartbeat", RustOperationID: "automation_runtime_heartbeat", Guard: GuardWorkspace, Source: "src/automation/api/runtimes.rs"},
	}
}
