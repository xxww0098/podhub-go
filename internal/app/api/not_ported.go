package api

import "net/http"

// Handlers for operations that api/openapi.yaml carries but this service does
// not serve yet. They answer 501 instead of silently 404ing, which keeps the
// generated ServerInterface satisfied and makes the gap visible from outside.
//
// These routes are mounted and listed in internal/app/testdata/routes.txt, so
// TestRouteTableMatchesGolden and the OpenAPI ratchet cover them. Replacing one
// with a real handler must not move the route: only the body changes.
//
// The SPA's own view of what it may call is web/src/api/mounted.test.ts.

// CatalogFetchConfig is GET /api/catalog/fetch-config.
func (s *Server) CatalogFetchConfig(w http.ResponseWriter, r *http.Request) {
	writeNotPorted(w)
}

// PutWbCredential is PUT /api/catalog/fetch-config/wb-credential.
func (s *Server) PutWbCredential(w http.ResponseWriter, r *http.Request) {
	writeNotPorted(w)
}

// RunNow is POST /api/catalog/fetch-config/run.
func (s *Server) RunNow(w http.ResponseWriter, r *http.Request) {
	writeNotPorted(w)
}

// SearchCatalogDictionary is POST /api/catalog/schema/dictionary-search.
func (s *Server) SearchCatalogDictionary(w http.ResponseWriter, r *http.Request) {
	writeNotPorted(w)
}

// AcceptInvite is POST /api/invitations/{uuid}/accept.
func (s *Server) AcceptInvite(w http.ResponseWriter, r *http.Request, uuid string) {
	writeNotPorted(w)
}

// DeclineInvite is POST /api/invitations/{uuid}/decline.
func (s *Server) DeclineInvite(w http.ResponseWriter, r *http.Request, uuid string) {
	writeNotPorted(w)
}

// MediaObjectComplete is POST /api/media/objects/{digest}/{extension}/complete.
func (s *Server) MediaObjectComplete(w http.ResponseWriter, r *http.Request, digest string, extension string) {
	writeNotPorted(w)
}

// writeNotPorted is the one body for an operation the spec documents but this
// build does not implement.
func writeNotPorted(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusNotImplemented)
	_, _ = w.Write([]byte(`{"error":"该接口尚未实现","code":"NOT_PORTED"}`))
}

// CreateInvite is POST /api/invitations.
func (s *Server) CreateInvite(w http.ResponseWriter, r *http.Request) {
	writeNotPorted(w)
}

// ChangeWorkspaceMemberRole is PATCH /api/workspaces/members/{id}.
func (s *Server) ChangeWorkspaceMemberRole(w http.ResponseWriter, r *http.Request, id int64) {
	writeNotPorted(w)
}

// CompleteBatch is POST /api/media/objects/complete-batch.
func (s *Server) CompleteBatch(w http.ResponseWriter, r *http.Request) {
	writeNotPorted(w)
}

// Workspace lifecycle and membership: documented in api/openapi.yaml, not
// served by this build.

func (s *Server) ListWorkspaces(w http.ResponseWriter, r *http.Request)    { writeNotPorted(w) }
func (s *Server) CreateWorkspace(w http.ResponseWriter, r *http.Request)   { writeNotPorted(w) }
func (s *Server) DissolveWorkspace(w http.ResponseWriter, r *http.Request) { writeNotPorted(w) }
func (s *Server) LeaveWorkspace(w http.ResponseWriter, r *http.Request)    { writeNotPorted(w) }
func (s *Server) RenameWorkspace(w http.ResponseWriter, r *http.Request)   { writeNotPorted(w) }
func (s *Server) RevokeInvite(w http.ResponseWriter, r *http.Request, uuid string) {
	writeNotPorted(w)
}
func (s *Server) RemoveWorkspaceMember(w http.ResponseWriter, r *http.Request, id int64) {
	writeNotPorted(w)
}

// Media object lifecycle.

func (s *Server) PresignBatch(w http.ResponseWriter, r *http.Request) { writeNotPorted(w) }
func (s *Server) MediaObjectProbe(w http.ResponseWriter, r *http.Request, digest string, extension string) {
	writeNotPorted(w)
}
func (s *Server) DownloadSupplierTemplate(w http.ResponseWriter, r *http.Request, productId string, digest string) {
	writeNotPorted(w)
}
func (s *Server) VerifySupplierMedia(w http.ResponseWriter, r *http.Request, productId string) {
	writeNotPorted(w)
}
func (s *Server) IssueUploadBatch(w http.ResponseWriter, r *http.Request) { writeNotPorted(w) }
