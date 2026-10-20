package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	adminhttp "github.com/xxww0098/podhub-go/internal/admin/http"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
)

func TestAdminBRejectsBeforeADatabase(t *testing.T) {
	anon := mountAdmin(&Server{})
	rec := callAdmin(anon, http.MethodGet, "/api/admin/listing/packages/official", "")
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"code":"VALIDATION"`) {
		t.Fatalf("missing query %d %s", rec.Code, rec.Body.String())
	}
	rec = callAdmin(anon, http.MethodGet, "/api/admin/listing/packages/official?category_id=cat", "")
	if rec.Code != http.StatusUnauthorized || rec.Body.String() != `{"error":"未登录","code":"AUTH_INVALID"}` {
		t.Fatalf("anon %d %s", rec.Code, rec.Body.String())
	}

	user := mountAdmin(&Server{Access: access.FixedResolver{Principal: &access.Principal{UserID: 2, PlatformRole: "admin"}}})
	rec = callAdmin(user, http.MethodPost, "/api/admin/prompts", `{}`)
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "需要超级管理员权限") {
		t.Fatalf("role %d %s", rec.Code, rec.Body.String())
	}

	super := mountAdmin(&Server{Access: access.FixedResolver{Principal: &access.Principal{UserID: 3, PlatformRole: "super_admin"}}})
	rec = callAdmin(super, http.MethodGet, "/api/admin/listing/packages/official?category_id=%20", "")
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "category_id 无效") {
		t.Fatalf("blank category %d %s", rec.Code, rec.Body.String())
	}
	rec = callAdmin(super, http.MethodPost, "/api/admin/prompts", `{"name":1}`)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "请求格式无效") {
		t.Fatalf("json %d %s", rec.Code, rec.Body.String())
	}
	rec = callAdmin(super, http.MethodPost, "/api/admin/videos", `{"name":"a","videoUrl":"https://cdn.example/a","durationMs":1,"descriptionCategoryId":1,"typeId":1,"extra":true}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unknown %d %s", rec.Code, rec.Body.String())
	}
	rec = callAdmin(super, http.MethodGet, "/api/admin/media/objects?prefix=a", "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("objects query %d %s", rec.Code, rec.Body.String())
	}
	rec = callAdmin(super, http.MethodPost, "/api/admin/media/objects/move", `{"accountId":"a","sourcePath":"a","destinationPath":"b","kind":"directory"}`)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "不支持移动目录") {
		t.Fatalf("move dir %d %s", rec.Code, rec.Body.String())
	}
}

func mountAdmin(s *Server) http.Handler {
	r := chi.NewRouter()
	adminhttp.Mount(r, adminhttp.Deps{Ported: AdminPorted(s)})
	return r
}

func callAdmin(h http.Handler, method, path, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	h.ServeHTTP(rec, req)
	return rec
}
