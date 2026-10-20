package ratingshttp

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
)

func TestRatingReadsAuth(t *testing.T) {
	r := chi.NewRouter()
	Mount(r, Deps{})
	req := httptest.NewRequest(http.MethodGet, "/api/workspaces/stores/11111111-1111-1111-1111-111111111111/ratings", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), `"code":"auth_invalid"`) {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("nosniff")
	}

	r = chi.NewRouter()
	Mount(r, Deps{Access: access.FixedResolver{Principal: &access.Principal{UserID: 1}}})
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/workspaces/stores/11111111-1111-1111-1111-111111111111/ratings/history", nil))
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), access.MsgNoWorkspace) {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}

	r = chi.NewRouter()
	Mount(r, Deps{Access: access.FixedResolver{Principal: &access.Principal{UserID: 1, OrgID: 2, WorkspaceRole: "owner"}}})
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/workspaces/stores/not-a-uuid/ratings", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("uuid %d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/workspaces/stores/11111111-1111-1111-1111-111111111111/ratings", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("nil svc %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/workspaces/stores/11111111-1111-1111-1111-111111111111/ratings/history?limit=0", nil))
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"code":"validation"`) {
		t.Fatalf("limit %d %s", rec.Code, rec.Body.String())
	}
}
