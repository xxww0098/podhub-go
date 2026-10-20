package telemetryhttp

// Route table for this domain. It includes POST /api/listing/client-logs,
// which the generated route table omitted.

// Guard is which session check runs before the handler body.
type Guard string

const (
	// GuardWorkspace is a workspace session (org_id required).
	GuardWorkspace Guard = "workspace"
	// GuardCollect is the client-log switch, checked before the session.
	GuardCollect Guard = "collect"
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
		{Method: "POST", Path: "/api/events/inbox", OperationID: "event_inbox", RustOperationID: "event_inbox", Guard: GuardWorkspace, Source: "src/telemetry/inbox.rs"},
		{Method: "POST", Path: "/api/listing/client-logs", OperationID: "ingest_client_listing_logs", RustOperationID: "ingest_client_listing_logs", Guard: GuardCollect, Source: "src/telemetry/client_listing_logs_http.rs"},
	}
}
