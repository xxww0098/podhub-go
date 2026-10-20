package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/podhub-go/tests/parity"
)

func TestHealthWithoutDatabaseIsUnavailable(t *testing.T) {
	router := chi.NewRouter()
	handler := HandlerFromMux(&Server{}, router)
	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status %d", rec.Code)
	}
	if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("nosniff missing: %q", rec.Header().Get("X-Content-Type-Options"))
	}
	if err := parity.DiffHTTP(parity.Exchange{Status: rec.Code, Body: rec.Body.Bytes()}, parity.Exchange{
		Status: http.StatusServiceUnavailable,
		Body:   []byte(`{"ok":false,"db":"unavailable","ts":0,"writer_leases":[]}`),
	}); err != nil {
		t.Fatal(err)
	}
	var body HealthResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Ok || body.Db != Unavailable || body.WriterLeases == nil {
		t.Fatalf("%+v", body)
	}
}
