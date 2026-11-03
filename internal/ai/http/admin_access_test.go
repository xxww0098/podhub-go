package aihttp

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
)

func TestOcrTestsRequirePlatformStaff(t *testing.T) {
	for _, role := range []string{"", "user", "owner", "manager", "admin", "super_admin", " ADMIN "} {
		var p *access.Principal
		if role != "" {
			p = &access.Principal{UserID: 1, OrgID: 1, WorkspaceRole: "owner", PlatformRole: role}
		}
		r := chi.NewRouter()
		Register(r, HTTPDeps{Access: access.FixedResolver{Principal: p}})
		for _, op := range []struct{ method, suffix string }{
			{http.MethodGet, ""}, {http.MethodPost, ""}, {http.MethodPost, "/upload"}, {http.MethodPost, "/confirm"},
		} {
			path := "/api/admin/ai/ocr-tests/11111111-2222-3333-4444-555555555555" + op.suffix
			want := http.StatusForbidden
			if p == nil {
				want = http.StatusUnauthorized
			} else if role == "admin" || role == "super_admin" || role == " ADMIN " {
				want = http.StatusServiceUnavailable
			}
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, httptest.NewRequest(op.method, path, nil))
			if rec.Code != want {
				t.Fatalf("%s %s role=%q: %d %s; want %d", op.method, path, role, rec.Code, rec.Body.String(), want)
			}
			rec = httptest.NewRecorder()
			r.ServeHTTP(rec, httptest.NewRequest(op.method, "/api/ai/ocr-tests/11111111-2222-3333-4444-555555555555"+op.suffix, nil))
			if rec.Code != http.StatusNotFound {
				t.Fatalf("old OCR test route is still mounted: %d", rec.Code)
			}
		}
	}
}
