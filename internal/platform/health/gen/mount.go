package healthgen

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

// Mount registers GET /api/health on r in the same way the monolith did.
func Mount(r chi.Router, h ServerInterface) http.Handler {
	return HandlerFromMux(h, r)
}
