package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	cataloggen "github.com/xxww0098/podhub-go/internal/catalog/http/gen"
	identitygen "github.com/xxww0098/podhub-go/internal/identity/http/gen"
	listinggen "github.com/xxww0098/podhub-go/internal/listing/http/gen"
	rulesgen "github.com/xxww0098/podhub-go/internal/listing/rules/http/gen"
	mediagen "github.com/xxww0098/podhub-go/internal/media/http/gen"
	healthgen "github.com/xxww0098/podhub-go/internal/platform/health/gen"
)

// The handler methods stay on Server. Each generated ServerInterface is the
// subset of those methods for one unit. The billing tag is models-only in
// api/codegen/billing.yaml, so its one route is mounted by hand below.
var (
	_ healthgen.ServerInterface   = (*Server)(nil)
	_ rulesgen.ServerInterface    = (*Server)(nil)
	_ listinggen.ServerInterface  = (*Server)(nil)
	_ cataloggen.ServerInterface  = (*Server)(nil)
	_ identitygen.ServerInterface = (*Server)(nil)
	_ mediagen.ServerInterface    = (*Server)(nil)
)

// HandlerFromMux registers the routes that used to live in one generated
// file. The call order is the order of that file's HandlerWithOptions.
func HandlerFromMux(s *Server, r chi.Router) http.Handler {
	if r == nil {
		r = chi.NewRouter()
	}
	healthgen.Mount(r, s)
	rulesgen.Mount(r, s)
	listinggen.Mount(r, s)
	cataloggen.Mount(r, s)
	identitygen.Mount(r, s)
	r.Get("/api/view/account-overview", s.AccountOverview)
	r.Get("/api/avatars/me", s.GetMyAvatar)
	r.Delete("/api/avatars/me", s.DeleteMyAvatar)
	r.Get("/api/avatars/workspaces/{workspace_id}", s.GetWorkspaceAvatar)
	r.Post("/api/avatars/workspaces/{workspace_id}/upload", s.InitWorkspaceAvatar)
	r.Put("/api/avatars/workspaces/{workspace_id}/upload", s.PutWorkspaceAvatarUpload)
	r.Put("/api/avatars/workspaces/{workspace_id}", s.PutWorkspaceAvatar)
	r.Get("/api/notifications", s.NotificationList)
	r.Post("/api/notifications/read-all", s.NotificationReadAll)
	r.Post("/api/notifications/{uuid}/read", s.NotificationRead)
	r.Get("/api/prompts/categories", s.ListPromptLeaves)
	r.Get("/api/prompts/category/{description_category_id}/{type_id}", s.ListCategoryPrompts)
	r.Get("/api/videos/category/{description_category_id}/{type_id}", s.ListCategoryVideos)
	mediagen.Mount(r, s)
	r.Get("/api/workspace/slice-storage", s.getWorkspaceSliceStorage)
	r.Patch("/api/workspace/slice-storage/cleanup", s.updateWorkspaceSliceCleanup)
	r.Get("/api/workspace/slice-storage/objects", s.listWorkspaceSliceObjects)
	r.Get("/api/workspace/slice-storage/stats", s.workspaceSliceStats)
	r.Get("/api/workspace/slice-storage/download", s.downloadWorkspaceSliceObject)
	r.Post("/api/workspace/slice-storage/objects/delete", s.deleteWorkspaceSliceObjects)
	r.Post("/api/workspace/slice-storage/clear", s.clearWorkspaceSliceStorage)
	r.Post("/api/workspace/slice-storage", s.configureWorkspaceSliceStorage)
	r.Get("/api/billing/usage-stats", s.BillingUsageStats)
	return r
}
