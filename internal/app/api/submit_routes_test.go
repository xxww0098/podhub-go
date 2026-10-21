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
	draft := `{"store_id":"` + store + `","card_id":"22222222-2222-4222-8222-222222222222","items":[{"rowId":"33333333-3333-4333-8333-333333333333"}]}`
	batch := `{"store_id":"` + store + `","row_ids":["33333333-3333-4333-8333-333333333333"],"expected_revisions":[{"row_id":"33333333-3333-4333-8333-333333333333","revision":1}]}`

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
	req := httptest.NewRequest(http.MethodPost, "/api/listing/submit", strings.NewReader(`{"store_id":"`+store+`","row_ids":["not-a-uuid"]}`))
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
	body := `{"store_id":"11111111-1111-4111-8111-111111111111","row_ids":["33333333-3333-4333-8333-333333333333"]}`
	rec := httptest.NewRecorder()
	submitHandler(&access.Principal{UserID: 1, OrgID: 2, WorkspaceRole: "owner"}).ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/listing/submit", strings.NewReader(body)))
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "bad_request") {
		t.Fatalf("batch without revision pins: %d %s", rec.Code, rec.Body.String())
	}
}

func TestSubmitDraftRulesVersion(t *testing.T) {
	rules := &memRules{}
	handler := HandlerFromMux(&Server{
		Access: access.FixedResolver{Principal: &access.Principal{UserID: 1, OrgID: 2, WorkspaceRole: "owner"}},
		Rules:  rules,
	}, chi.NewRouter())
	const envelope = `"store_id":"11111111-1111-4111-8111-111111111111","card_id":"22222222-2222-4222-8222-222222222222","items":[{"rowId":"33333333-3333-4333-8333-333333333333"}]`
	rec := post(handler, "/api/listing/submit", `{`+envelope+`,"rules_version":"stale"}`)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), `"code":"rules_stale"`) || rules.reads != 1 {
		t.Fatalf("draft must check the snake_case rules version: %d %s reads=%d", rec.Code, rec.Body.String(), rules.reads)
	}
	rec = post(handler, "/api/listing/submit", `{`+envelope+`,"rulesVersion":"stale","tags":["tag"]}`)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"code":"rules_version_required"`) {
		t.Fatalf("camelCase rules version must not satisfy the handshake: %d %s", rec.Code, rec.Body.String())
	}
}

func TestSubmitDraftRejectsCamelCaseEnvelope(t *testing.T) {
	const store = "11111111-1111-4111-8111-111111111111"
	const card = "22222222-2222-4222-8222-222222222222"
	for _, body := range []string{
		`{"storeId":"` + store + `","card_id":"` + card + `","items":[{}]}`,
		`{"store_id":"` + store + `","cardId":"` + card + `","items":[{}]}`,
	} {
		rec := post(submitHandler(&access.Principal{UserID: 1, OrgID: 2, WorkspaceRole: "owner"}), "/api/listing/submit", body)
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"code":"bad_request"`) {
			t.Fatalf("camelCase draft envelope accepted: %d %s", rec.Code, rec.Body.String())
		}
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
