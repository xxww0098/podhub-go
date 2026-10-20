package app

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/podhub-go/tests/parity"
)

// TestRouteTableMatchesGolden compares method+path with the table captured
// before httpapi was removed. Middleware count stays 3: otel, CSRF, identity.
func TestRouteTableMatchesGolden(t *testing.T) {
	h := Handler(nil)
	routes, ok := h.(chi.Routes)
	if !ok {
		t.Fatalf("%T", h)
	}
	var lines []string
	err := chi.Walk(routes, func(method, route string, _ http.Handler, mws ...func(http.Handler) http.Handler) error {
		route = strings.ReplaceAll(route, "/*/", "/")
		if len(mws) != 3 {
			t.Errorf("%s %s middleware count %d", method, route, len(mws))
		}
		lines = append(lines, method+" "+route)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(lines)
	got := strings.Join(lines, "\n") + "\n"
	want, err := os.ReadFile("testdata/routes.txt")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal([]byte(got), want) {
		t.Fatalf("route table changed\n got %d lines\n want %d lines", len(lines), bytes.Count(want, []byte("\n")))
	}
	ops := 0
	for _, line := range lines {
		if strings.Contains(line, " /api/ops/") {
			ops++
		}
	}
	if ops != 18 {
		t.Fatalf("ops routes %d", ops)
	}

	probes := []struct {
		method, path string
		status       int
		body         string
		ct           string
	}{
		{http.MethodGet, "/no-such", http.StatusNotFound, "404 page not found\n", "text/plain; charset=utf-8"},
		{http.MethodPost, "/api/health", http.StatusMethodNotAllowed, "", ""},
		{http.MethodPut, "/api/listing/rules", http.StatusMethodNotAllowed, "", ""},
		{http.MethodGet, "/openapi.json", http.StatusNotFound, "404 page not found\n", "text/plain; charset=utf-8"},
		{http.MethodGet, "/api", http.StatusNotFound, `{"code":"invalid_request","message":"接口不存在"}`, "application/json"},
		{http.MethodGet, "/api/", http.StatusNotFound, `{"code":"invalid_request","message":"接口不存在"}`, "application/json"},
		{http.MethodGet, "/api/does-not-exist", http.StatusNotFound, `{"code":"invalid_request","message":"接口不存在"}`, "application/json"},
		{http.MethodGet, "/api/admin/redeem-codes/", http.StatusNotFound, `{"code":"invalid_request","message":"接口不存在"}`, "application/json"},
	}
	for _, p := range probes {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(p.method, p.path, nil))
		if rec.Code != p.status || rec.Body.String() != p.body || rec.Header().Get("Content-Type") != p.ct {
			t.Fatalf("%s %s -> %d %q ct=%q", p.method, p.path, rec.Code, rec.Body.String(), rec.Header().Get("Content-Type"))
		}
		if strings.HasPrefix(p.path, "/api") && p.path != "/api/health" && rec.Header().Get("X-Content-Type-Options") != "nosniff" && p.status == http.StatusNotFound {
			t.Fatalf("%s missing nosniff", p.path)
		}
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/health", nil))
	if rec.Header().Get("Content-Type") != "application/json" {
		t.Fatal(rec.Header().Get("Content-Type"))
	}
	if err := parity.DiffHTTP(parity.Exchange{Status: rec.Code, Body: rec.Body.Bytes()}, parity.Exchange{
		Status: http.StatusServiceUnavailable,
		Body:   []byte(`{"ok":false,"db":"unavailable","ts":0,"writer_leases":[]}`),
	}); err != nil {
		t.Fatal(err)
	}
}
