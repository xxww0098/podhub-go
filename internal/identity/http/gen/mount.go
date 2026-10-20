package identitygen

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

// Mount registers the auth and workspace routes in spec order.
func Mount(r chi.Router, h ServerInterface) http.Handler {
	return HandlerFromMux(h, r)
}
