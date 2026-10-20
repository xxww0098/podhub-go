package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
)

func submitHandler(p *access.Principal) http.Handler {
	router := chi.NewRouter()
	srv := &Server{Access: access.FixedResolver{Principal: p}}
	return HandlerFromMux(srv, router)
}

func TestSubmitSelectsBranchByBodyShape(t *testing.T) {
	store := "11111111-1111-4111-8111-111111111111"
	draft := `{"storeId":"` + store + `","cardId":"22222222-2222-4222-8222-222222222222","items":[{"rowId":"33333333-3333-4333-8333-333333333333"}]}`
	batch := `{"storeId":"` + store + `","row_ids":["33333333-3333-4333-8333-333333333333"]}`

	rec := httptest.NewRecorder()
	submitHandler(nil).ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/listing/submit", strings.NewReader(draft)))
	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), "未登录") {
		t.Fatalf("logged out %d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	submitHandler(&access.Principal{UserID: 1, OrgID: 2, WorkspaceRole: "viewer"}).ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/listing/submit", strings.NewReader(batch)))
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "当前角色无权执行此操作") {
		t.Fatalf("viewer batch %d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/listing/submit", strings.NewReader(`{"storeId":"`+store+`","row_ids":["not-a-uuid"]}`))
	submitHandler(&access.Principal{UserID: 1, OrgID: 2, WorkspaceRole: "member"}).ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("row id %d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	submitHandler(&access.Principal{UserID: 1, OrgID: 2, WorkspaceRole: "owner"}).ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/listing/submit", strings.NewReader(draft)))
	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), "服务暂不可用") {
		t.Fatalf("pool %d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	submitHandler(&access.Principal{UserID: 1, OrgID: 2, WorkspaceRole: "owner"}).ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/listing/submit", strings.NewReader(batch)))
	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), "服务暂不可用") {
		t.Fatalf("batch pool %d %s", rec.Code, rec.Body.String())
	}
}
