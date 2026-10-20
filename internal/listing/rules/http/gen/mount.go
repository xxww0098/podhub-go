package rulesgen

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

// Mount registers GET /api/listing/rules and POST /api/listing/validate.
func Mount(r chi.Router, h ServerInterface) http.Handler {
	return HandlerFromMux(h, r)
}
