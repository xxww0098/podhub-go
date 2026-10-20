package adminhttp

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
)

func TestAdminRouteCounts(t *testing.T) {
	if len(SupplierRoutes()) != 40 || len(CatalogRoutes()) != 3 || len(PlatformRoutes()) != 76 {
		t.Fatalf("supplier %d catalog %d platform %d", len(SupplierRoutes()), len(CatalogRoutes()), len(PlatformRoutes()))
	}
	for _, rt := range Routes() {
		if strings.Contains(rt.Path, "banned-tags") {
			t.Fatal(rt.Path)
		}
	}
}

func TestAdminGuards(t *testing.T) {
	super := access.FixedResolver{Principal: &access.Principal{UserID: 1, OrgID: 1, PlatformRole: "super_admin", WorkspaceRole: "owner"}}
	staff := access.FixedResolver{Principal: &access.Principal{UserID: 1, OrgID: 1, PlatformRole: "admin", WorkspaceRole: "owner"}}
	user := access.FixedResolver{Principal: &access.Principal{UserID: 1, OrgID: 1, PlatformRole: "user", WorkspaceRole: "member"}}
	none := access.FixedResolver{Principal: &access.Principal{UserID: 1, PlatformRole: "user"}}

	r := router(super)
	rec := call(r, http.MethodPost, "/api/admin/supplier-withdrawals/7/pay", `{"reference":"R1"}`)
	if rec.Code != http.StatusInternalServerError || !strings.Contains(rec.Body.String(), `"code":"internal"`) {
		t.Fatalf("pay %d %s", rec.Code, rec.Body.String())
	}
	rec = call(r, http.MethodGet, "/api/admin/supplier-db-storage/objects", "")
	if rec.Code != http.StatusServiceUnavailable || rec.Body.String() != `{"error":"先配置平台货源存储桶","code":"STORAGE_NOT_CONFIGURED"}` {
		t.Fatalf("storage %d %s", rec.Code, rec.Body.String())
	}
	rec = call(router(staff), http.MethodGet, "/api/admin/supplier-accounts", "")
	if rec.Code != http.StatusInternalServerError || !strings.Contains(rec.Body.String(), `"code":"internal"`) {
		t.Fatalf("staff list %d %s", rec.Code, rec.Body.String())
	}
	rec = call(router(staff), http.MethodPost, "/api/admin/supplier-withdrawals/7/pay", `{"reference":"R1"}`)
	if rec.Code != http.StatusInternalServerError || !strings.Contains(rec.Body.String(), `"code":"internal"`) {
		t.Fatalf("staff pay %d %s", rec.Code, rec.Body.String())
	}
	rec = call(router(user), http.MethodGet, "/api/admin/supplier-accounts", "")
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "需要平台管理员权限") || !strings.Contains(rec.Body.String(), `"code":"forbidden"`) {
		t.Fatalf("user list %d %s", rec.Code, rec.Body.String())
	}
	rec = call(router(staff), http.MethodGet, "/api/admin/users", "")
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), msgSuperAdmin) {
		t.Fatalf("staff users %d %s", rec.Code, rec.Body.String())
	}
	rec = call(router(none), http.MethodGet, "/api/admin/ai-requests", "")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("workspace %d %s", rec.Code, rec.Body.String())
	}
	rec = call(router(user), http.MethodDelete, "/api/admin/videos/vid", "")
	if rec.Code != http.StatusNotImplemented {
		t.Fatalf("login delete %d %s", rec.Code, rec.Body.String())
	}
	anon := chi.NewRouter()
	Mount(anon, Deps{})
	rec = call(anon, http.MethodGet, "/api/admin/plans", "")
	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), `"code":"AUTH_INVALID"`) {
		t.Fatal(rec.Code, rec.Body.String())
	}
	rec = call(anon, http.MethodGet, "/api/admin/ai-requests", "")
	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), `"code":"AUTH_REQUIRED"`) {
		t.Fatalf("ai anon %d %s", rec.Code, rec.Body.String())
	}
	rec = call(router(super), http.MethodGet, "/api/admin/users", "")
	if rec.Code != http.StatusNotImplemented || !strings.Contains(rec.Body.String(), `"code":"not_ported"`) {
		t.Fatalf("unwired users %d %s", rec.Code, rec.Body.String())
	}
}

func TestPortedSkipsInventoryGuard(t *testing.T) {
	user := access.FixedResolver{Principal: &access.Principal{UserID: 1, PlatformRole: "user", WorkspaceRole: "member"}}
	r := chi.NewRouter()
	Mount(r, Deps{
		Resolve: fixed(user),
		Ported: map[string]http.HandlerFunc{
			"DELETE /api/admin/videos/{video_id}": func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(299)
			},
		},
	})
	rec := call(r, http.MethodDelete, "/api/admin/videos/vid", "")
	if rec.Code != 299 {
		t.Fatalf("ported %d %s", rec.Code, rec.Body.String())
	}
}

func router(res access.Resolver) http.Handler {
	r := chi.NewRouter()
	Mount(r, Deps{Resolve: fixed(res)})
	return r
}

func fixed(res access.Resolver) Resolve {
	if res == nil {
		return nil
	}
	return func(r *http.Request) (*Session, *Refusal, error) {
		p, refusal, err := res.Resolve(r)
		if err != nil {
			return nil, nil, err
		}
		if refusal != nil {
			return nil, &Refusal{Status: refusal.Status, Message: refusal.Message}, nil
		}
		if p == nil {
			return nil, nil, nil
		}
		return &Session{
			UserID: p.UserID, OrgID: p.OrgID, WorkspaceRole: p.WorkspaceRole, PlatformRole: p.PlatformRole,
			Email: p.Email, PublicID: p.PublicID, TokenHash: p.TokenHash,
		}, nil, nil
	}
}

func call(h http.Handler, method, path, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(method, path, strings.NewReader(body)))
	return rec
}
