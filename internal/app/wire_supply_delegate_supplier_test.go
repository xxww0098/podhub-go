package app

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPR8ARoutesRequireASession(t *testing.T) {
	handler := Handler(nil)
	for _, path := range []string{"/api/platform-catalog", "/api/supplier/me", "/api/seller/delegate/sources"} {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s %d %s", path, rec.Code, rec.Body.Bytes())
		}
	}
}
