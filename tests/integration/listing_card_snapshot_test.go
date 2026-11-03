package integration

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"strconv"
	"testing"
	"time"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
)

// Exercise the actual snapshot SQL scan and HTTP projection together: an empty
// card cannot detect a SELECT/Scan arity mismatch or a row the SPA rejects.
func TestListingCardSnapshotCurrentInputFailureContract(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	engine := tagsEngine(t)
	owner, org := insertWorkspace(t, ctx, pool, "snapshot-wire@example.com", "Snapshot wire")
	member := insertMember(t, ctx, pool, org, owner, "owner", 1)
	const (
		card   = "b1111111-1111-4111-8111-111111111111"
		row    = "b2222222-2222-4222-8222-222222222222"
		store  = "b3333333-3333-4333-8333-333333333333"
		intent = "b4444444-4444-4444-8444-444444444444"
	)
	insertNamedStore(t, ctx, pool, org, store, member)
	insertCard(t, ctx, pool, card, org, "Snapshot", "2026-08-21 17:30:00+00", `{}`)
	insertListingRow(t, ctx, pool, row, org, card)
	if _, err := pool.Exec(ctx, `UPDATE listing_rows SET store_id = $2::uuid, revision = 4,
		content_state = 'ready', media_state = 'ready', validation_state = 'passed',
		build_state = 'built', submission_state = 'accepted' WHERE id = $1::uuid`, row, store); err != nil {
		t.Fatal(err)
	}
	insertIntent(t, ctx, pool, intent, org, store, row, "accepted", "snapshot-import", strPtr("OZON_ROW_REJECTED"), strPtr("snapshot-offer"))
	issue := fmt.Sprintf(`{"phase":"submit","scope":"row","code":"OZON_ROW_REJECTED","summary":"商品导入失败","remediation":"修正商品信息","allowedActions":["edit_row"],"traceId":"snapshot-job","endpoint":"/v1/product/import/info","safeMessage":"invalid attribute","dispatchEvidence":"response_received","intentId":%q,"inputRevision":4,"requestHash":"hash","rowId":%q,"storeId":%q,"credentialRevision":1,"retryAfterFallback":false,"createdAtMs":1787333400000}`, intent, row, store)
	if _, err := pool.Exec(ctx, `UPDATE submission_intents SET external_task_id = '42',
		submission_receipt = '{"batch_id":"snapshot-batch","item_count":1,"task_id":42}'::jsonb,
		submission_issues = $2::jsonb,
		reconciliation_outcome = '{"importTask":{"status":"failed"}}'::jsonb
		WHERE id = $1::uuid`, intent, "["+issue+"]"); err != nil {
		t.Fatal(err)
	}
	h := surfaceHandler(pool, engine, access.Principal{UserID: owner, OrgID: org, WorkspaceRole: "owner", PlatformRole: "user"}, time.Now)
	read := func(path string) map[string]json.RawMessage {
		t.Helper()
		rec := callJSON(h, http.MethodGet, path, "")
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s: %d %s", path, rec.Code, rec.Body.String())
		}
		return snapshotWireObject(t, snapshotWireObject(t, rec.Body.Bytes())["data"])
	}
	readRows := func() map[string]json.RawMessage {
		t.Helper()
		snapshot := read("/api/listing/cards/" + card + "/snapshot")
		snapshotWireField(t, snapshot, "workspace_id", strconv.Quote(strconv.FormatInt(org, 10)))
		snapshotWireField(t, snapshot, "card_id", strconv.Quote(card))
		var cursor uint64
		var cursorText string
		var err error
		if json.Unmarshal(snapshot["cursor"], &cursorText) != nil {
			t.Fatalf("snapshot cursor: %s", snapshot["cursor"])
		}
		if cursor, err = strconv.ParseUint(cursorText, 10, 63); err != nil || cursor == 0 {
			t.Fatalf("nonempty snapshot cursor %q: %v", cursorText, err)
		}
		var rows []map[string]json.RawMessage
		if err := json.Unmarshal(snapshot["rows"], &rows); err != nil || len(rows) != 1 {
			t.Fatalf("snapshot rows: %s, %v", snapshot["rows"], err)
		}
		snapshotRow := rows[0]
		snapshotWireField(t, snapshotRow, "id", strconv.Quote(row))
		snapshotWireField(t, snapshotRow, "card_id", strconv.Quote(card))
		snapshotWireField(t, snapshotRow, "store_id", strconv.Quote(store))
		for _, key := range []string{"view_revision", "content_state", "media_state", "validation_state", "submission_state", "validation_issues", "updated_at_ms"} {
			if _, ok := snapshotRow[key]; !ok {
				t.Fatalf("row missing %s: %s", key, snapshot["rows"])
			}
		}
		if single := read("/api/listing/rows/" + row); !reflect.DeepEqual(single, snapshotRow) {
			t.Fatalf("single row differs from snapshot: single=%s snapshot=%s", single, snapshotRow)
		}
		listed := read("/api/listing/rows?cardId=" + card)
		var items []map[string]json.RawMessage
		if err := json.Unmarshal(listed["items"], &items); err != nil || len(items) != 1 || !reflect.DeepEqual(items[0], snapshotRow) {
			t.Fatalf("list differs from snapshot: %s, %v", listed["items"], err)
		}
		summary := snapshotWireObject(t, snapshot["summary"])
		total := 0
		for _, key := range []string{"unprepared", "preparing", "attention", "ready", "sending", "sent"} {
			var count int
			if err := json.Unmarshal(summary[key], &count); err != nil || count < 0 {
				t.Fatalf("summary %s: %s, %v", key, summary[key], err)
			}
			total += count
		}
		if total != len(rows) {
			t.Fatalf("summary counted %d for %d rows", total, len(rows))
		}
		return snapshotRow
	}

	current := readRows()
	snapshotWireField(t, current, "revision", "4")
	snapshotWireField(t, current, "submission_state", `"accepted"`)
	projection := snapshotWireObject(t, current["projection"])
	snapshotWireField(t, projection, "stage", `"accepted"`)
	snapshotWireField(t, projection, "current_issue_status", `"present"`)
	snapshotWireField(t, projection, "submission_receipt_status", `"valid"`)
	snapshotWireField(t, projection, "can_resume", "false")
	snapshotWireField(t, projection, "error_code", `"OZON_ROW_REJECTED"`)
	snapshotWireField(t, projection, "task_id", `"42"`)
	var detail string
	if json.Unmarshal(projection["error_detail"], &detail) != nil || detail == "" {
		t.Fatalf("missing readable error: %s", current["projection"])
	}
	currentIssue := snapshotWireObject(t, projection["submission_issue"])
	snapshotWireField(t, currentIssue, "input_revision", "4")
	snapshotWireField(t, currentIssue, "intent_id", strconv.Quote(intent))
	snapshotWireField(t, currentIssue, "allowed_actions", `["check_store"]`)
	readiness := snapshotWireObject(t, projection["readiness"])
	snapshotWireField(t, readiness, "ready_to_publish", "false")
	snapshotWireField(t, readiness, "can_start_publish_attempt", "false")
	snapshotWireField(t, readiness, "allowed_actions", `[]`)

	// A newer input has no failure of its own. The historical accepted intent
	// and its failure remain stored, but must not leak into the edited row.
	if _, err := pool.Exec(ctx, `UPDATE listing_rows SET revision = 5, submission_state = 'none' WHERE id = $1::uuid`, row); err != nil {
		t.Fatal(err)
	}
	newer := readRows()
	snapshotWireField(t, newer, "revision", "5")
	projection = snapshotWireObject(t, newer["projection"])
	snapshotWireField(t, projection, "stage", `"ready_to_publish"`)
	snapshotWireField(t, projection, "current_issue_status", `"absent"`)
	snapshotWireField(t, projection, "submission_receipt_status", `"absent"`)
	snapshotWireField(t, projection, "can_resume", "false")
	for _, key := range []string{"error_code", "error_detail", "submission_issue", "task_id"} {
		if raw, ok := projection[key]; ok && string(raw) != "null" {
			t.Fatalf("old input leaked %s: %s", key, raw)
		}
	}
	var unchanged bool
	if err := pool.QueryRow(ctx, `SELECT state = 'accepted' AND row_revision = 4
		AND submission_issues = $2::jsonb FROM submission_intents WHERE id = $1::uuid`, intent, "["+issue+"]").Scan(&unchanged); err != nil || !unchanged {
		t.Fatalf("reads changed historical intent: %v, %v", unchanged, err)
	}
}

func snapshotWireObject(t *testing.T, raw []byte) map[string]json.RawMessage {
	t.Helper()
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil || object == nil {
		t.Fatalf("expected JSON object: %s, %v", raw, err)
	}
	return object
}

func snapshotWireField(t *testing.T, object map[string]json.RawMessage, key, want string) {
	t.Helper()
	if string(object[key]) != want {
		t.Fatalf("%s = %s, want %s", key, object[key], want)
	}
}
