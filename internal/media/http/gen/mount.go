package mediagen

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

// Mount registers the media presign route.
func Mount(r chi.Router, h ServerInterface) http.Handler {
	return HandlerFromMux(h, r)
}
