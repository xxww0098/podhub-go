package readhttp

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
)

func TestUserPSDCloudRoutesAreRemoved(t *testing.T) {
	router := chi.NewRouter()
	Mount(router, Host{})
	for _, path := range []string{
		"/api/listing/templates",
		"/api/listing/templates/template-id/confirm",
		"/api/listing/templates/template-id/multipart/complete",
		"/api/listing/templates/template-id/multipart/abort",
		"/api/listing/cards/card-id/templates/digest",
	} {
		method := http.MethodPost
		if path == "/api/listing/cards/card-id/templates/digest" {
			method = http.MethodGet
		}
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(method, path, nil))
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s %s: got %d, want 404", method, path, rec.Code)
		}
	}
}
