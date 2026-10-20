package listinggen

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

// Mount registers the listing job reads and the merged submit route.
func Mount(r chi.Router, h ServerInterface) http.Handler {
	return HandlerFromMux(h, r)
}
