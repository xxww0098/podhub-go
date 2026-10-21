package domain

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
)

func TestIntentQueryEdges(t *testing.T) {
	ok, msg, valid := ParseIntentQuery(map[string][]string{"limit": {"50"}})
	if !valid || ok.Limit != 50 || ok.Fetch != 51 {
		t.Fatalf("%+v %s", ok, msg)
	}
	wide, _, valid := ParseIntentQuery(map[string][]string{"limit": {"100"}})
	if !valid || wide.Fetch != 101 {
		t.Fatalf("limit 100 must keep the extra row, fetch=%d", wide.Fetch)
	}
	if _, msg, valid = ParseIntentQuery(map[string][]string{"limit": {"nope"}}); valid || msg != "limit 无效" {
		t.Fatal(msg)
	}
	if _, msg, valid = ParseIntentQuery(map[string][]string{"categoryKey": {"a"}, "extra": {"1"}}); valid || msg != "请求格式无效" {
		t.Fatal(msg)
	}
	if _, msg, valid = ParseIntentQuery(map[string][]string{"latestPerRow": {"1"}}); valid || msg != "请求格式无效" {
		t.Fatal(msg)
	}
	if _, msg, valid = ParseIntentQuery(map[string][]string{"rowId": {"x"}, "rowIds": {"y"}}); valid || msg != "rowId 与 rowIds 不能同时使用" {
		t.Fatal(msg)
	}
	if _, msg, valid = ParseIntentQuery(map[string][]string{"rowIds": {"x"}}); valid || msg != "按 rowIds 或 intentIds 查询时 storeId 必填" {
		t.Fatal(msg)
	}
	if _, msg, valid = ParseIntentQuery(map[string][]string{"storeId": {"nope"}}); valid || msg != "storeId 无效" {
		t.Fatal(msg)
	}
	if _, msg, valid = ParseIntentQuery(map[string][]string{"cardId": {"nope"}}); valid || msg != "cardId 无效" {
		t.Fatal(msg)
	}
	id := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	id2 := "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	store := "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
	got, _, valid := ParseIntentQuery(map[string][]string{
		"storeId": {store}, "rowIds": {id2 + "," + id + "," + strings.ToUpper(id)}, "cursor": {"nope"},
		"categoryKey": {"ignored"}, "stableOrder": {"true"},
	})
	if !valid || len(got.RowIDs) != 2 || got.RowIDs[0] != id || got.CursorID != "" || !got.StableOrder || !got.ExactStore {
		t.Fatalf("%+v", got)
	}
	var manyIDs strings.Builder
	for i := 0; i < 101; i++ {
		if i > 0 {
			manyIDs.WriteByte(',')
		}
		manyIDs.WriteString("aaaaaaaa-aaaa-4aaa-8aaa-" + pad(i+1))
	}
	if _, msg, valid = ParseIntentQuery(map[string][]string{"storeId": {store}, "intentIds": {manyIDs.String()}}); valid || msg != "intentIds 一次最多 100 个" {
		t.Fatal(msg)
	}
	empty, _, valid := ParseIntentQuery(map[string][]string{"storeId": {store}, "rowIds": {""}})
	if !valid || len(empty.RowIDs) != 0 {
		t.Fatal("empty list")
	}
}

func TestReleaseIDsAndPredicates(t *testing.T) {
	if _, msg, ok := ParseReleaseIDs(nil); ok || msg != "至少选择一个提交意图" {
		t.Fatal(msg)
	}
	if _, msg, ok := ParseReleaseIDs([]string{"nope"}); ok || msg != "intentIds 含无效标识" {
		t.Fatal(msg)
	}
	id := "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"
	got, _, ok := ParseReleaseIDs([]string{" " + id + " ", id})
	if !ok || len(got) != 1 || got[0] != "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" {
		t.Fatalf("%v", got)
	}
	many := make([]string, 101)
	for i := range many {
		many[i] = "aaaaaaaa-aaaa-4aaa-8aaa-" + pad(i)
	}
	if _, msg, ok := ParseReleaseIDs(many); ok || msg != "一次最多处理 100 个提交意图" {
		t.Fatal(msg)
	}

	task := "9"
	if !CancelMovesToCancelled("queued", nil) {
		t.Fatal("queued without a task cancels")
	}
	for _, state := range []string{"submitting", "unknown", "accepted", "rejected", "cancelled", "reconciled", "conflict", "operator_attested", "superseded"} {
		if CancelMovesToCancelled(state, nil) {
			t.Fatalf("%s must not move", state)
		}
	}
	if CancelMovesToCancelled("queued", &task) {
		t.Fatal("external task stays")
	}
	if !ReleaseAllowed("unknown", false, false) {
		t.Fatal("clear unknown releases")
	}
	for _, state := range []string{"queued", "submitting", "accepted", "rejected", "cancelled", "reconciled", "conflict", "operator_attested", "superseded"} {
		if ReleaseAllowed(state, false, false) {
			t.Fatalf("%s is not a release source", state)
		}
	}
	if ReleaseAllowed("unknown", true, false) || ReleaseAllowed("unknown", false, true) {
		t.Fatal("live claim or unfinished job blocks release")
	}
}

func pad(i int) string {
	const hex = "0123456789abcdef"
	out := []byte("000000000000")
	for pos := 11; pos >= 0 && i > 0; pos-- {
		out[pos] = hex[i%16]
		i /= 16
	}
	return string(out)
}

func TestIntentView(t *testing.T) {
	when := time.UnixMilli(1_787_333_400_000).UTC()
	issue := json.RawMessage(`{"code":"OZON_WRITES_DISABLED","resolvedAtMs":null,"allowedActions":["resume"],"summary":"保持原文"}`)
	src := IntentSource{
		ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", StoreID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		ListingRowID: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", RowRevision: 3, ClientOperationID: "op",
		State: "rejected", LastErrorCode: strPtr("OZON_WRITES_DISABLED"),
		SubmissionIssues:  json.RawMessage(`[` + string(issue) + `]`),
		SubmissionReceipt: json.RawMessage(`{"batch_id":"b","item_count":1}`),
		UpdatedAt:         when,
	}
	view := ProjectIntent(src)
	if view.CurrentIssueStatus != IssuePresent || !view.CanResume || view.KnownErrorCode == nil || *view.KnownErrorCode != "OZON_WRITES_DISABLED" {
		t.Fatalf("%+v", view)
	}
	if view.SubmissionReceiptStatus != ReceiptValid {
		t.Fatal("valid receipt")
	}
	assertIntentJSONEqual(t, view.CurrentIssue, json.RawMessage(`{"code":"OZON_WRITES_DISABLED","resolved_at_ms":null,"allowed_actions":["resume"],"summary":"保持原文"}`))
	raw, err := jsonwire.Marshal(view)
	if err != nil {
		t.Fatal(err)
	}
	if !json.Valid(raw) || !contains(string(raw), `"submission_issues":[`) || contains(string(raw), "import_probe") {
		t.Fatal(string(raw))
	}
	src.State = "accepted"
	accepted := ProjectIntent(src)
	if accepted.CurrentIssueStatus != IssueAbsent || accepted.CanResume || accepted.CurrentIssue != nil {
		t.Fatal("other states omit the current issue")
	}
	src.State = "queued"
	src.LastErrorCode = strPtr("not_a_wire_code")
	src.SubmissionIssues = json.RawMessage(`[{"code":"not_a_wire_code","resolvedAtMs":null,"allowedActions":["wait"]}]`)
	unknownCode := ProjectIntent(src)
	if unknownCode.KnownErrorCode != nil || unknownCode.CanResume || unknownCode.CurrentIssueStatus != IssuePresent {
		t.Fatal("unknown code stays only on lastErrorCode")
	}
	src.SubmissionReceipt = json.RawMessage(`[]`)
	if status, body := receiptOf(src.SubmissionReceipt); status != ReceiptUnreadable || body != nil {
		t.Fatal(status)
	}
	src.SubmissionReceipt = nil
	if status, _ := receiptOf(src.SubmissionReceipt); status != ReceiptAbsent {
		t.Fatal(status)
	}
	live := true
	src.HasLiveReconcileClaim = &live
	if ProjectIntent(src).HasLiveReconcileClaim == nil {
		t.Fatal("facts copy")
	}
	now := time.Unix(1_000, 0)
	future := now.Add(time.Second)
	if msg, conflict := ProbeRefusal("queued", "", "offer", nil, now); !conflict || msg == "" {
		t.Fatal("not stopped")
	}
	if _, conflict := ProbeRefusal("unknown", ReconcileStillUnknown, "", nil, now); !conflict {
		t.Fatal("missing offer")
	}
	if _, conflict := ProbeRefusal("unknown", ReconcileStillUnknown, "offer", &future, now); !conflict {
		t.Fatal("busy")
	}
	if _, conflict := ProbeRefusal("unknown", ReconcileStillUnknown, "offer", nil, now); conflict {
		t.Fatal("ready probe is not a 409")
	}
}

func strPtr(s string) *string { return &s }

func contains(s, part string) bool { return strings.Contains(s, part) }
