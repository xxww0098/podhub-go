package cataloggen

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

// Mount registers GET /api/me/catalog/banned-tags.
func Mount(r chi.Router, h ServerInterface) http.Handler {
	return HandlerFromMux(h, r)
}
