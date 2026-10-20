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
	mediagen.Mount(r, s)
	r.Get("/api/billing/usage-stats", s.BillingUsageStats)
	return r
}
