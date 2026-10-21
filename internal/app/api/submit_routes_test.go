package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/listing/submit"
)

func submitHandler(p *access.Principal) http.Handler {
	router := chi.NewRouter()
	srv := &Server{Access: access.FixedResolver{Principal: p}}
	return HandlerFromMux(srv, router)
}

func TestSubmitSelectsBranchByBodyShape(t *testing.T) {
	store := "11111111-1111-4111-8111-111111111111"
	draft := `{"storeId":"` + store + `","cardId":"22222222-2222-4222-8222-222222222222","items":[{"rowId":"33333333-3333-4333-8333-333333333333"}]}`
	batch := `{"storeId":"` + store + `","row_ids":["33333333-3333-4333-8333-333333333333"],"expectedRevisions":[{"rowId":"33333333-3333-4333-8333-333333333333","revision":1}]}`

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

func TestSubmitBatchRequiresRevisionPins(t *testing.T) {
	body := `{"storeId":"11111111-1111-4111-8111-111111111111","row_ids":["33333333-3333-4333-8333-333333333333"]}`
	rec := httptest.NewRecorder()
	submitHandler(&access.Principal{UserID: 1, OrgID: 2, WorkspaceRole: "owner"}).ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/listing/submit", strings.NewReader(body)))
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "bad_request") {
		t.Fatalf("batch without revision pins: %d %s", rec.Code, rec.Body.String())
	}
}

func TestSubmitBatchRevisionMismatchWire(t *testing.T) {
	const rowID = "33333333-3333-4333-8333-333333333333"
	rec := httptest.NewRecorder()
	writeListingJSON(rec, http.StatusOK, struct {
		Data submit.BatchData `json:"data"`
	}{Data: submit.BatchData{Items: []submit.BatchItem{{RowID: rowID, Skipped: "revision_mismatch"}}}})
	var body struct {
		Data struct {
			Items []map[string]json.RawMessage `json:"items"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if rec.Code != http.StatusOK || len(body.Data.Items) != 1 {
		t.Fatalf("batch response: %d %s", rec.Code, rec.Body.String())
	}
	item := body.Data.Items[0]
	if string(item["row_id"]) != `"`+rowID+`"` || item["rowId"] != nil || string(item["skipped"]) != `"revision_mismatch"` {
		t.Fatalf("batch refusal does not match the frontend row_id contract: %s", rec.Body.String())
	}
}
