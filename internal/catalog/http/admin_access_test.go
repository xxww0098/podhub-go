package cataloghttp

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
)

func TestFetchConfigRequiresSuperAdmin(t *testing.T) {
	for _, role := range []string{"", "user", "owner", "manager", "admin", "super_admin"} {
		var p *access.Principal
		if role != "" {
			p = &access.Principal{UserID: 1, OrgID: 1, WorkspaceRole: "owner", PlatformRole: role}
		}
		r := chi.NewRouter()
		Mount(r, Host{Access: access.FixedResolver{Principal: p}})
		for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodPost} {
			path := "/api/admin/catalog/fetch-config"
			if method == http.MethodPost {
				path += "/run"
			}
			want := http.StatusForbidden
			if p == nil {
				want = http.StatusUnauthorized
			} else if role == "super_admin" {
				want = http.StatusInternalServerError
				if method == http.MethodPost {
					want = http.StatusServiceUnavailable
				}
			}
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, httptest.NewRequest(method, path, nil))
			if rec.Code != want {
				t.Fatalf("%s %s role=%q: %d %s; want %d", method, path, role, rec.Code, rec.Body.String(), want)
			}
		}
	}
	for _, path := range []string{"/api/catalog/fetch-config", "/api/catalog/fetch-config/run"} {
		r := chi.NewRouter()
		Mount(r, Host{})
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusNotFound {
			t.Fatalf("old path %s is still mounted: %d", path, rec.Code)
		}
	}
}
