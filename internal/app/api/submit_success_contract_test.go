package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/xxww0098/podhub-go/internal/listing/submit"
	"github.com/xxww0098/podhub-go/tests/parity"
	"github.com/xxww0098/podhub-go/tests/testkit"
)

func TestSubmitSuccessResponsesMatchContract(t *testing.T) {
	spec, err := testkit.LoadOpenAPI()
	if err != nil {
		t.Fatal(err)
	}
	const rowID = "33333333-3333-4333-8333-333333333333"
	const queuedIntentJSON = `{"submission_issues":[],"current_issue_status":"absent","can_resume":false,"id":"44444444-4444-4444-8444-444444444444","store_id":"11111111-1111-4111-8111-111111111111","listing_row_id":"33333333-3333-4333-8333-333333333333","row_revision":7,"client_operation_id":"operation-7","state":"queued","submission_receipt_status":"absent","updated_at_ms":1792540800000}`
	acceptedIntentJSON := strings.Replace(queuedIntentJSON, `"state":"queued"`, `"state":"accepted"`, 1)
	const issues = `[{"field_key":"name","code":"required","parameters":{},"severity":"blocking","address":{"kind":"plain","field_key":"name"},"message":"商品名称为必填项","remediation":"填写商品名称"}]`
	const blockers = `[{"kind":"video_snapshot_incomplete","supplier_product_id":"supplier-1"}]`
	intent := func(state string) *submit.IntentView {
		return &submit.IntentView{
			SubmissionIssues: []struct{}{}, CurrentIssueStatus: "absent", CanResume: false,
			ID: "44444444-4444-4444-8444-444444444444", StoreID: "11111111-1111-4111-8111-111111111111",
			ListingRowID: rowID, RowRevision: 7, ClientOperationID: "operation-7", State: state,
			SubmissionReceiptStatus: "absent", UpdatedAtMS: 1792540800000,
		}
	}
	cases := []struct {
		name string
		data any
		want string
	}{
		{
			name: "draft created",
			data: submit.DraftData{ServerSchemaRevision: "schema-current", AcceptedSchemaRevisions: []string{"schema-current", "schema-legacy"}, Items: []submit.DraftItem{{RowID: rowID, Outcome: "created", Intent: intent("queued")}}},
			want: `{"data":{"server_schema_revision":"schema-current","accepted_schema_revisions":["schema-current","schema-legacy"],"items":[{"row_id":"` + rowID + `","outcome":"created","intent":` + queuedIntentJSON + `}]}}`,
		},
		{
			name: "draft replayed",
			data: submit.DraftData{ServerSchemaRevision: "schema-current", Items: []submit.DraftItem{{RowID: rowID, Outcome: "replayed", Intent: intent("accepted")}}},
			want: `{"data":{"server_schema_revision":"schema-current","items":[{"row_id":"` + rowID + `","outcome":"replayed","intent":` + acceptedIntentJSON + `}]}}`,
		},
		{
			name: "draft schema skipped",
			data: submit.DraftData{ServerSchemaRevision: "schema-current", Items: []submit.DraftItem{{RowID: rowID, Outcome: "skipped", SkipReason: "schema_stale", Fields: []string{"brand"}}}},
			want: `{"data":{"server_schema_revision":"schema-current","items":[{"row_id":"` + rowID + `","outcome":"skipped","skip_reason":"schema_stale","fields":["brand"]}]}}`,
		},
		{
			name: "draft field blocked",
			data: submit.DraftData{ServerSchemaRevision: "schema-current", Items: []submit.DraftItem{{RowID: rowID, Outcome: "skipped", SkipReason: "blocked", Issues: json.RawMessage(issues)}}},
			want: `{"data":{"server_schema_revision":"schema-current","items":[{"row_id":"` + rowID + `","outcome":"skipped","skip_reason":"blocked","issues":` + issues + `}]}}`,
		},
		{
			name: "draft blocker preserved",
			data: submit.DraftData{ServerSchemaRevision: "schema-current", Items: []submit.DraftItem{{RowID: rowID, Outcome: "skipped", SkipReason: "blocked", Blockers: json.RawMessage(blockers)}}},
			want: `{"data":{"server_schema_revision":"schema-current","items":[{"row_id":"` + rowID + `","outcome":"skipped","skip_reason":"blocked","blockers":` + blockers + `}]}}`,
		},
		{
			name: "draft empty",
			data: submit.DraftData{ServerSchemaRevision: "schema-current", Items: []submit.DraftItem{}},
			want: `{"data":{"server_schema_revision":"schema-current","items":[]}}`,
		},
		{
			name: "stored created",
			data: submit.BatchData{Items: []submit.BatchItem{{RowID: rowID, Created: true, Intent: intent("queued")}}},
			want: `{"data":{"items":[{"row_id":"` + rowID + `","intent":` + queuedIntentJSON + `,"created":true}]}}`,
		},
		{
			name: "stored replayed",
			data: submit.BatchData{Items: []submit.BatchItem{{RowID: rowID, Created: false, Intent: intent("accepted")}}},
			want: `{"data":{"items":[{"row_id":"` + rowID + `","intent":` + acceptedIntentJSON + `,"created":false}]}}`,
		},
		{
			name: "stored skipped",
			data: submit.BatchData{Items: []submit.BatchItem{{RowID: rowID, Skipped: "revision_mismatch"}}},
			want: `{"data":{"items":[{"row_id":"` + rowID + `","created":false,"skipped":"revision_mismatch"}]}}`,
		},
		{
			name: "stored schema skipped",
			data: submit.BatchData{Items: []submit.BatchItem{{RowID: rowID, Skipped: "compose_failed", Detail: "schema_stale", Fields: []string{"brand"}}}},
			want: `{"data":{"items":[{"row_id":"` + rowID + `","created":false,"skipped":"compose_failed","detail":"schema_stale","fields":["brand"]}]}}`,
		},
		{
			name: "stored empty",
			data: submit.BatchData{Items: []submit.BatchItem{}},
			want: `{"data":{"items":[]}}`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			writeListingJSON(rec, http.StatusOK, struct {
				Data any `json:"data"`
			}{Data: tc.data})
			if err := parity.DiffHTTP(parity.Exchange{Status: rec.Code, Body: rec.Body.Bytes()}, parity.Exchange{Status: http.StatusOK, Body: []byte(tc.want)}); err != nil {
				t.Error(err)
			}
			if err := spec.CheckResponse(http.MethodPost, "/api/listing/submit", rec.Code, rec.Header(), rec.Body.Bytes()); err != nil {
				t.Error(err)
			}
		})
	}
}

func TestSubmitSuccessContractRejectsMalformedBodies(t *testing.T) {
	spec, err := testkit.LoadOpenAPI()
	if err != nil {
		t.Fatal(err)
	}
	for _, body := range []string{
		`{}`,
		`{"data":{}}`,
		`{"data":{"items":null}}`,
		`{"data":{"serverSchemaRevision":"schema-current","items":[]}}`,
		`{"data":{"server_schema_revision":"schema-current","items":[{"rowId":"row-1","outcome":"skipped","skipReason":"blocked"}]}}`,
		`{"data":{"items":[{"row_id":"row-1","created":true,"intent":{"id":"intent-1","state":"queued"}}]}}`,
		`{"data":{"items":[],"unexpected":"field"}}`,
	} {
		if err := spec.CheckResponse(http.MethodPost, "/api/listing/submit", http.StatusOK, http.Header{"Content-Type": {"application/json"}}, []byte(body)); err == nil {
			t.Errorf("malformed successful response passed OpenAPI: %s", body)
		}
	}
}
