package api

import (
	"net/http"

	"github.com/xxww0098/podhub-go/internal/identity"
)

// Handlers for operations that api/openapi.yaml carries but this service does
// not serve yet. They answer 501 instead of silently 404ing, which keeps the
// generated ServerInterface satisfied and makes the gap visible from outside.
//
// These routes are mounted and listed in internal/app/testdata/routes.txt, so
// TestRouteTableMatchesGolden and the OpenAPI ratchet cover them. Replacing one
// with a real handler must not move the route: only the body changes.
//
// The SPA's own view of what it may call is web/src/api/mounted.test.ts.

// CatalogFetchConfig is GET /api/admin/catalog/fetch-config.
func (s *Server) CatalogFetchConfig(w http.ResponseWriter, r *http.Request) {
	writeNotPorted(w)
}

func (s *Server) SaveCatalogFetchConfig(w http.ResponseWriter, r *http.Request) {
	writeNotPorted(w)
}

// RunNow is POST /api/admin/catalog/fetch-config/run.
func (s *Server) RunNow(w http.ResponseWriter, r *http.Request) {
	writeNotPorted(w)
}

// SearchCatalogDictionary is POST /api/catalog/schema/dictionary-search.
func (s *Server) SearchCatalogDictionary(w http.ResponseWriter, r *http.Request) {
	writeNotPorted(w)
}

// AcceptInvite is POST /api/invitations/{uuid}/accept.
func (s *Server) AcceptInvite(w http.ResponseWriter, r *http.Request, uuid string) {
	identity.WriteResult(w, s.identity().RespondInvitation(r, uuid, true))
}

// DeclineInvite is POST /api/invitations/{uuid}/decline.
func (s *Server) DeclineInvite(w http.ResponseWriter, r *http.Request, uuid string) {
	identity.WriteResult(w, s.identity().RespondInvitation(r, uuid, false))
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
	identity.WriteResult(w, s.identity().CreateInvitation(r))
}

// RevokeInvite is DELETE /api/invitations/{uuid}.
func (s *Server) RevokeInvite(w http.ResponseWriter, r *http.Request, uuid string) {
	identity.WriteResult(w, s.identity().RevokeInvitation(r, uuid))
}
