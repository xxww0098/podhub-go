package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/internal/listing/read/domain"
	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
	"github.com/xxww0098/podhub-go/tests/testkit"
)

func TestIntentSuccessResponsesMatchOpenAPI(t *testing.T) {
	spec, err := testkit.LoadOpenAPI()
	if err != nil {
		t.Fatal(err)
	}
	code, task := "OZON_WRITES_DISABLED", "42"
	issue := json.RawMessage(`{"phase":"pre_dispatch","scope":"store","code":"OZON_WRITES_DISABLED","summary":"暂停写入","remediation":"等待恢复","allowedActions":["resume"],"traceId":"job","endpoint":"/v3/product/import","safeMessage":"暂停写入","dispatchEvidence":"not_dispatched","intentId":"intent","inputRevision":4,"requestHash":"hash","rowId":"row","storeId":"store","credentialRevision":2,"retryAfterFallback":false,"createdAtMs":1}`)
	source := domain.IntentSource{
		ID: "intent", StoreID: "store", ListingRowID: "row", RowRevision: 4,
		ClientOperationID: "operation", State: "rejected", LastErrorCode: &code,
		SubmissionIssues: json.RawMessage(`[` + string(issue) + `]`), UpdatedAt: time.UnixMilli(1000),
	}
	for _, state := range []string{"queued", "rejected", "accepted", "unknown", "superseded"} {
		t.Run(state, func(t *testing.T) {
			src := source
			src.State = state
			if state == "accepted" {
				src.ExternalTaskID = &task
				src.SubmissionReceipt = json.RawMessage(`{"batch_id":"batch","item_count":1,"task_id":42,"received_at_ms":900}`)
			}
			view := domain.ProjectIntent(src)
			for _, path := range []string{"/api/listing/intents/{id}", "/api/listing/intents/{id}/cancel", "/api/listing/intents/{id}/probe"} {
				method := http.MethodPost
				if path == "/api/listing/intents/{id}" {
					method = http.MethodGet
				}
				rec := httptest.NewRecorder()
				jsonwire.Write(rec, http.StatusOK, struct {
					Data domain.IntentView `json:"data"`
				}{Data: view})
				if err := spec.CheckResponse(method, path, rec.Code, rec.Header(), rec.Body.Bytes()); err != nil {
					t.Error(err)
				}
				var body struct {
					Data map[string]json.RawMessage `json:"data"`
				}
				if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
					t.Fatal(err)
				}
				for _, key := range []string{"listing_row_id", "store_id", "client_operation_id", "row_revision", "updated_at_ms", "can_resume", "submission_issues", "current_issue_status", "submission_receipt_status"} {
					if _, ok := body.Data[key]; !ok {
						t.Errorf("%s missing %s: %s", path, key, rec.Body.Bytes())
					}
				}
			}
		})
	}
}
