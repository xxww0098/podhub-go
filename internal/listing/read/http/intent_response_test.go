package readhttp

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/xxww0098/podhub-go/tests/testkit"
)

func TestIntentHandlersMatchResponseContract(t *testing.T) {
	pool, ctx := listingBatchDB(t)
	org, user, row := seedOwner(t, ctx, pool, "intent-wire-"+uuid.NewString())
	store := uuid.NewString()
	if _, err := pool.Exec(ctx, `INSERT INTO organization_stores (org_id, uuid, create_order, name) VALUES ($1, $2::uuid, 1, 'wire store')`, org, store); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE listing_rows SET revision = 4, submission_state = 'queued' WHERE org_id = $1 AND id = $2::uuid`, org, row); err != nil {
		t.Fatal(err)
	}
	seed := func(state string) string {
		t.Helper()
		id := uuid.NewString()
		var last any
		if state == "unknown" {
			last = "OZON_RECONCILE_STILL_UNKNOWN"
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO submission_intents (id, org_id, store_id, listing_row_id, row_revision,
			    client_operation_id, request_hash, state, last_error_code, offer_id)
			VALUES ($1::uuid, $2, $3::uuid, $4::uuid, 4, $1, 'hash', $5, $6, $1)`, id, org, store, row, state, last); err != nil {
			t.Fatal(err)
		}
		return id
	}
	queued, unknown, busy, rejected, accepted := seed("queued"), seed("unknown"), seed("unknown"), seed("rejected"), seed("accepted")
	issue := fmt.Sprintf(`{"phase":"pre_dispatch","scope":"store","code":"OZON_WRITES_DISABLED","summary":"暂停写入","remediation":"等待恢复","allowedActions":["resume"],"traceId":"job","endpoint":"/v3/product/import","safeMessage":"safe","dispatchEvidence":"not_dispatched","intentId":%q,"inputRevision":4,"requestHash":"hash","rowId":%q,"storeId":%q,"credentialRevision":1,"retryAfterFallback":false,"createdAtMs":1,"futureDetails":{"allowedActions":["keep-opaque"]}}`, rejected, row, store)
	if _, err := pool.Exec(ctx, `UPDATE submission_intents SET last_error_code = 'OZON_WRITES_DISABLED', submission_issues = $2::jsonb WHERE id = $1::uuid`, rejected, "["+issue+"]"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE submission_intents SET external_task_id = '42', submission_receipt = '{"batch_id":"batch","item_count":1,"task_id":42}'::jsonb WHERE id = $1::uuid`, accepted); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE submission_intents SET reconcile_claim_until = clock_timestamp() + interval '5 minutes' WHERE id = $1::uuid`, busy); err != nil {
		t.Fatal(err)
	}
	insertJob(t, ctx, pool, jobRow{id: uuid.NewString(), org: org, user: user, row: row,
		kind: "listing.submit.batch", lane: "listing.submit", state: "queued",
		payload: `{"intents":[{"intentId":"` + busy + `"}]}`})
	host := claimHost(pool, org, user)
	host.Now = time.Now
	router := chi.NewRouter()
	Mount(router, host)
	spec, err := testkit.LoadOpenAPI()
	if err != nil {
		t.Fatal(err)
	}
	call := func(t *testing.T, method, path, template, body string) map[string]json.RawMessage {
		t.Helper()
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(method, path, strings.NewReader(body)).WithContext(ctx)
		req.Header.Set("Content-Type", "application/json")
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s %s: %d %s", method, path, rec.Code, rec.Body.String())
		}
		if err := spec.CheckResponse(method, template, rec.Code, rec.Header(), rec.Body.Bytes()); err != nil {
			t.Error(err)
		}
		var envelope struct {
			Data map[string]json.RawMessage `json:"data"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
			t.Fatal(err)
		}
		return envelope.Data
	}
	get := func(t *testing.T, id string) map[string]json.RawMessage {
		t.Helper()
		return call(t, http.MethodGet, "/api/listing/intents/"+id, "/api/listing/intents/{id}", "")
	}

	t.Run("GET keeps absent and busy release facts distinct", func(t *testing.T) {
		clear := get(t, unknown)
		assertIntentJSONField(t, clear, "state", `"unknown"`)
		assertIntentJSONField(t, clear, "has_live_reconcile_claim", "false")
		assertIntentJSONField(t, clear, "has_unfinished_dispatch_job", "false")
		assertIntentJSONField(t, clear, "can_resume", "false")
		held := get(t, busy)
		assertIntentJSONField(t, held, "has_live_reconcile_claim", "true")
		assertIntentJSONField(t, held, "has_unfinished_dispatch_job", "true")
	})
	t.Run("list publishes its real cursor", func(t *testing.T) {
		data := call(t, http.MethodGet, "/api/listing/intents?storeId="+store+"&limit=1", "/api/listing/intents", "")
		var cursor string
		if json.Unmarshal(data["next_cursor"], &cursor) != nil || cursor == "" {
			t.Fatalf("page omitted next_cursor: %s", data)
		}
		var items []map[string]json.RawMessage
		if json.Unmarshal(data["items"], &items) != nil || len(items) != 1 {
			t.Fatalf("page items: %s", data["items"])
		}
		assertIntentJSONField(t, items[0], "store_id", `"`+store+`"`)
	})
	t.Run("stored issue is projected without rewriting storage", func(t *testing.T) {
		data := get(t, rejected)
		assertIntentJSONField(t, data, "can_resume", "true")
		var current map[string]json.RawMessage
		if err := json.Unmarshal(data["current_issue"], &current); err != nil {
			t.Fatal(err)
		}
		assertIntentJSONField(t, current, "allowed_actions", `["resume"]`)
		assertIntentJSONField(t, current, "trace_id", `"job"`)
		assertIntentJSONField(t, current, "futureDetails", `{"allowedActions":["keep-opaque"]}`)
		var stored bool
		if err := pool.QueryRow(ctx, `SELECT submission_issues = $2::jsonb FROM submission_intents WHERE id = $1::uuid`, rejected, "["+issue+"]").Scan(&stored); err != nil || !stored {
			t.Fatalf("read changed stored issues: %v, %v", stored, err)
		}
	})
	t.Run("accepted receipt and unreadable receipt", func(t *testing.T) {
		data := get(t, accepted)
		assertIntentJSONField(t, data, "state", `"accepted"`)
		assertIntentJSONField(t, data, "external_task_id", `"42"`)
		assertIntentJSONField(t, data, "submission_receipt_status", `"valid"`)
		if _, err := pool.Exec(ctx, `UPDATE submission_intents SET submission_receipt = '{}'::jsonb WHERE id = $1::uuid`, accepted); err != nil {
			t.Fatal(err)
		}
		unreadable := get(t, accepted)
		assertIntentJSONField(t, unreadable, "submission_receipt_status", `"unreadable"`)
		if _, present := unreadable["submission_receipt"]; present {
			t.Fatal("unreadable receipt was emitted as valid data")
		}
		assertIntentJSONField(t, unreadable, "state", `"accepted"`)
		assertIntentJSONField(t, unreadable, "external_task_id", `"42"`)
	})
	t.Run("cancel response does not synthesize release facts", func(t *testing.T) {
		data := call(t, http.MethodPost, "/api/listing/intents/"+queued+"/cancel", "/api/listing/intents/{id}/cancel", "")
		assertIntentJSONField(t, data, "state", `"cancelled"`)
		if len(data["cancel_requested_at_ms"]) == 0 {
			t.Fatal("cancel receipt missing timestamp")
		}
		assertNoIntentReleaseFacts(t, data)
		var state string
		if err := pool.QueryRow(ctx, `SELECT state FROM submission_intents WHERE id = $1::uuid`, queued).Scan(&state); err != nil || state != "cancelled" {
			t.Fatalf("cancel state %s: %v", state, err)
		}
	})
	t.Run("probe response keeps unknown and no synthetic permission", func(t *testing.T) {
		data := call(t, http.MethodPost, "/api/listing/intents/"+unknown+"/probe", "/api/listing/intents/{id}/probe", "")
		assertIntentJSONField(t, data, "state", `"unknown"`)
		assertIntentJSONField(t, data, "can_resume", "false")
		assertNoIntentReleaseFacts(t, data)
	})
	t.Run("release keeps busy intent and requires later GET facts", func(t *testing.T) {
		data := call(t, http.MethodPost, "/api/listing/intents/release-unknown", "/api/listing/intents/release-unknown", `{"intentIds":["`+unknown+`","`+busy+`"]}`)
		assertIntentJSONField(t, data, "released_intent_ids", `["`+unknown+`"]`)
		var views []map[string]json.RawMessage
		if err := json.Unmarshal(data["intents"], &views); err != nil || len(views) != 2 {
			t.Fatalf("release intents %s: %v", data["intents"], err)
		}
		for _, view := range views {
			assertNoIntentReleaseFacts(t, view)
		}
		assertIntentJSONField(t, get(t, unknown), "state", `"superseded"`)
		assertIntentJSONField(t, get(t, busy), "state", `"unknown"`)
		repeated := call(t, http.MethodPost, "/api/listing/intents/release-unknown", "/api/listing/intents/release-unknown", `{"intentIds":["`+unknown+`"]}`)
		assertIntentJSONField(t, repeated, "released_intent_ids", `[]`)
	})
}

func assertIntentJSONField(t *testing.T, object map[string]json.RawMessage, key, want string) {
	t.Helper()
	got, ok := object[key]
	if !ok {
		t.Fatalf("missing %s", key)
	}
	var left, right any
	if json.Unmarshal(got, &left) != nil || json.Unmarshal([]byte(want), &right) != nil {
		t.Fatalf("invalid JSON field %s: %s / %s", key, got, want)
	}
	canonicalGot, _ := json.Marshal(left)
	canonicalWant, _ := json.Marshal(right)
	if string(canonicalGot) != string(canonicalWant) {
		t.Fatalf("%s = %s, want %s", key, got, want)
	}
}

func assertNoIntentReleaseFacts(t *testing.T, view map[string]json.RawMessage) {
	t.Helper()
	for _, key := range []string{"has_live_reconcile_claim", "has_unfinished_dispatch_job"} {
		if _, exists := view[key]; exists {
			t.Errorf("write response synthesized %s", key)
		}
	}
}
