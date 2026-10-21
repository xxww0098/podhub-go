package domain

import (
	"bytes"
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
)

func TestIntentResumeOnlyForRejected(t *testing.T) {
	code := "OZON_WRITES_DISABLED"
	issue := json.RawMessage(`[{"code":"OZON_WRITES_DISABLED","resolvedAtMs":null,"allowedActions":["resume"]}]`)
	for _, state := range []string{"queued", "submitting", "unknown", "accepted", "cancelled", "reconciled", "conflict", "superseded", "operator_attested", "future_state", "rejected"} {
		t.Run(state, func(t *testing.T) {
			view := ProjectIntent(IntentSource{State: state, LastErrorCode: &code, SubmissionIssues: issue})
			if want := state == "rejected"; view.CanResume != want {
				t.Errorf("state %s can_resume = %v, want %v", state, view.CanResume, want)
			}
			if (state == "queued" || state == "unknown" || state == "rejected") && (view.CurrentIssueStatus != IssuePresent || view.CurrentIssue == nil) {
				t.Fatal("current issue display was removed with resume permission")
			}
		})
	}
}

func TestIntentReceiptRequiresDeclaredFields(t *testing.T) {
	for _, tc := range []struct {
		name, raw, want string
	}{
		{"absent", "", ReceiptAbsent},
		{"null", " null ", ReceiptAbsent},
		{"array", `[]`, ReceiptUnreadable},
		{"empty object", `{}`, ReceiptUnreadable},
		{"missing batch", `{"item_count":1}`, ReceiptUnreadable},
		{"missing count", `{"batch_id":"batch"}`, ReceiptUnreadable},
		{"case variant is not a required key", `{"BATCH_ID":"batch","ITEM_COUNT":1}`, ReceiptUnreadable},
		{"null batch", `{"batch_id":null,"item_count":1}`, ReceiptUnreadable},
		{"null count", `{"batch_id":"batch","item_count":null}`, ReceiptUnreadable},
		{"wrong batch type", `{"batch_id":1,"item_count":1}`, ReceiptUnreadable},
		{"wrong count type", `{"batch_id":"batch","item_count":"1"}`, ReceiptUnreadable},
		{"fractional count", `{"batch_id":"batch","item_count":1.5}`, ReceiptUnreadable},
		{"count overflow", `{"batch_id":"batch","item_count":2147483648}`, ReceiptUnreadable},
		{"wrong status type", `{"batch_id":"batch","item_count":1,"http_status":"200"}`, ReceiptUnreadable},
		{"wrong received type", `{"batch_id":"batch","item_count":1,"received_at_ms":false}`, ReceiptUnreadable},
		{"wrong response type", `{"batch_id":"batch","item_count":1,"response_body":[]}`, ReceiptUnreadable},
		{"wrong task type", `{"batch_id":"batch","item_count":1,"task_id":"42"}`, ReceiptUnreadable},
		{"wrong transport type", `{"batch_id":"batch","item_count":1,"transport_error":false}`, ReceiptUnreadable},
		{"minimal", `{"batch_id":"batch","item_count":1}`, ReceiptValid},
		{"nullable optional", `{"batch_id":"batch","item_count":1,"http_status":null,"received_at_ms":null,"response_body":null,"task_id":null,"transport_error":null}`, ReceiptValid},
		{"no undeclared constraints", `{"batch_id":"","item_count":-1,"task_id":-1}`, ReceiptValid},
		{"unknown future data", ` {"batch_id":"batch","item_count":1,"http_status":200,"received_at_ms":900,"response_body":"<raw>","task_id":42,"transport_error":"","futureData":{"anything":true}} `, ReceiptValid},
		{"case variant stays an extra key", `{"batch_id":"batch","item_count":1,"Task_id":"opaque","HTTP_STATUS":[]}`, ReceiptValid},
	} {
		t.Run(tc.name, func(t *testing.T) {
			status, body := receiptOf(json.RawMessage(tc.raw))
			if status != tc.want {
				t.Fatalf("receipt status = %s, want %s: %s", status, tc.want, tc.raw)
			}
			if tc.want == ReceiptValid {
				if !bytes.Equal(body, bytes.TrimSpace([]byte(tc.raw))) {
					t.Fatalf("valid receipt was rewritten: %s", body)
				}
			} else if body != nil {
				t.Fatalf("absent or unreadable receipt was exposed: %s", body)
			}
		})
	}
}

func TestIntentResponseUsesSnakeCase(t *testing.T) {
	issue := json.RawMessage(`{"phase":"pre_dispatch","scope":"store","code":"OZON_WRITES_DISABLED","summary":"保留 <原文>","remediation":"等待","allowedActions":["resume"],"traceId":"trace","endpoint":"/v3/product/import","safeMessage":"safe","dispatchEvidence":"not_dispatched","intentId":"intent","inputRevision":4,"requestHash":"hash","rowId":"row","storeId":"store","credentialRevision":2,"retryAfterFallback":false,"createdAtMs":1,"httpStatus":429,"providerCode":7,"resolvedAtMs":null,"retryAfterMs":20,"futureDetails":{"allowedActions":["unknown"],"rowId":"opaque"}}`)
	issues := json.RawMessage(`[` + string(issue) + `]`)
	receipt := json.RawMessage(`{"batch_id":"batch","item_count":1,"task_id":42,"futureData":{"rowId":"opaque"}}`)
	outcome := json.RawMessage(`{"released":{"byUserId":9,"atMs":10}}`)
	when := time.UnixMilli(1234).UTC()
	live, unfinished := false, true
	src := IntentSource{
		ID: "intent", StoreID: "store", ListingRowID: "row", RowRevision: 4,
		ClientOperationID: "operation", State: "rejected", ExternalTaskID: strPtr("42"),
		LastErrorCode: strPtr("OZON_WRITES_DISABLED"), SubmissionIssues: issues,
		SubmissionReceipt: receipt, ReconciliationOutcome: outcome, CancelRequestedAt: &when,
		UpdatedAt: when, HasLiveReconcileClaim: &live, HasUnfinishedDispatch: &unfinished,
	}
	view := ProjectIntent(src)
	if view.CurrentIssueStatus != IssuePresent || !view.CanResume || view.SubmissionReceiptStatus != ReceiptValid {
		t.Fatalf("projection facts changed: %+v", view)
	}
	raw, err := jsonwire.Marshal(view)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]json.RawMessage
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	keys := []string{"submission_issues", "current_issue_status", "current_issue", "can_resume", "id", "store_id", "listing_row_id", "row_revision", "client_operation_id", "state", "external_task_id", "last_error_code", "known_error_code", "reconciliation_outcome", "submission_receipt", "submission_receipt_status", "cancel_requested_at_ms", "updated_at_ms", "has_live_reconcile_claim", "has_unfinished_dispatch_job"}
	if len(got) != len(keys) {
		t.Fatalf("wire keys = %s", raw)
	}
	for _, key := range keys {
		if _, ok := got[key]; !ok {
			t.Errorf("missing HTTP key %s in %s", key, raw)
		}
	}
	var current map[string]json.RawMessage
	if err := json.Unmarshal(got["current_issue"], &current); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"allowed_actions", "trace_id", "safe_message", "dispatch_evidence", "intent_id", "input_revision", "request_hash", "row_id", "store_id", "credential_revision", "retry_after_fallback", "created_at_ms", "http_status", "provider_code", "resolved_at_ms", "retry_after_ms"} {
		if _, ok := current[key]; !ok {
			t.Errorf("missing nested HTTP key %s in %s", key, got["current_issue"])
		}
	}
	var history []json.RawMessage
	if err := json.Unmarshal(got["submission_issues"], &history); err != nil || len(history) != 1 {
		t.Fatalf("history = %s: %v", got["submission_issues"], err)
	}
	assertIntentJSONEqual(t, history[0], got["current_issue"])
	assertIntentJSONEqual(t, current["futureDetails"], json.RawMessage(`{"allowedActions":["unknown"],"rowId":"opaque"}`))
	assertIntentJSONEqual(t, got["submission_receipt"], receipt)
	assertIntentJSONEqual(t, got["reconciliation_outcome"], outcome)
	if string(src.SubmissionIssues) != string(issues) || string(src.SubmissionReceipt) != string(receipt) {
		t.Fatal("HTTP projection changed stored JSON")
	}
	status, selected, resume := currentIssue(src.State, src.LastErrorCode, src.SubmissionIssues)
	if status != IssuePresent || !resume || string(selected) != string(issue) {
		t.Fatal("HTTP projection changed the stored issue interpretation")
	}
}

func TestIntentResponsePreservesMissingAndExplicitFacts(t *testing.T) {
	falseFact, trueFact := false, true
	for _, tc := range []struct {
		name       string
		live, work *bool
	}{
		{name: "not enriched"},
		{name: "explicitly clear", live: &falseFact, work: &falseFact},
		{name: "busy", live: &trueFact, work: &trueFact},
	} {
		t.Run(tc.name, func(t *testing.T) {
			src := IntentSource{ID: "intent", StoreID: "store", ListingRowID: "row", ClientOperationID: "op", State: "unknown", UpdatedAt: time.UnixMilli(1), HasLiveReconcileClaim: tc.live, HasUnfinishedDispatch: tc.work}
			view := ProjectIntent(src)
			raw, err := jsonwire.Marshal(view)
			if err != nil {
				t.Fatal(err)
			}
			var got map[string]json.RawMessage
			if err := json.Unmarshal(raw, &got); err != nil {
				t.Fatal(err)
			}
			for key, want := range map[string]*bool{"has_live_reconcile_claim": tc.live, "has_unfinished_dispatch_job": tc.work} {
				value, present := got[key]
				if want == nil {
					if present {
						t.Errorf("missing %s became %s", key, value)
					}
					continue
				}
				var fact bool
				if !present || json.Unmarshal(value, &fact) != nil || fact != *want {
					t.Errorf("%s = %s, want %v", key, value, *want)
				}
			}
			if string(got["state"]) != `"unknown"` || string(got["can_resume"]) != "false" || string(got["submission_issues"]) != "[]" || string(got["submission_receipt_status"]) != `"absent"` {
				t.Fatalf("empty-history facts changed: %s", raw)
			}
			for _, key := range []string{"current_issue", "submission_receipt", "external_task_id", "known_error_code", "cancel_requested_at_ms"} {
				if _, present := got[key]; present {
					t.Errorf("absent %s was synthesized", key)
				}
			}
		})
	}
}

func assertIntentJSONEqual(t *testing.T, got, want json.RawMessage) {
	t.Helper()
	var left, right any
	if err := json.Unmarshal(got, &left); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(want, &right); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(left, right) {
		t.Fatalf("JSON changed\n got %s\nwant %s", got, want)
	}
}
