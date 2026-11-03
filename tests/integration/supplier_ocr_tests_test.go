package integration

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/xxww0098/podhub-go/internal/ai"
	aicontract "github.com/xxww0098/podhub-go/internal/ai/contract"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
)

func runSupplierOcrTestCases(t *testing.T, f listingMediaTest, runtime *ai.OCRRuntime, calls, mode *atomic.Int64, resolver access.Resolver) {
	t.Helper()
	var user, otherUser int64
	var role, otherRole string
	if err := f.pool.QueryRow(f.ctx, `SELECT u.id,u.role FROM account_users u JOIN organizations o ON o.owner_user_id=u.id WHERE o.id=$1`, f.org).Scan(&user, &role); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("Cookie", f.other)
	other, _, err := resolver.Resolve(req)
	if err != nil || other == nil {
		t.Fatal("other principal unavailable")
	}
	if err = f.pool.QueryRow(f.ctx, `SELECT role FROM account_users WHERE id=$1`, other.UserID).Scan(&otherRole); err != nil {
		t.Fatal(err)
	}
	otherUser = other.UserID
	if _, err := f.pool.Exec(f.ctx, `UPDATE account_users SET role='admin' WHERE id=$1`, user); err != nil {
		t.Fatal(err)
	}
	defer f.pool.Exec(f.ctx, `UPDATE account_users SET role=$2 WHERE id=$1`, user, role)
	authorize := runtime.TestAuthorize
	defer func() { runtime.TestAuthorize = authorize }()
	runtime.TestAuthorize = func(_ context.Context, _ access.Principal, source, product string) error {
		if source != "ocr-test-source" || product != "ocr-test-product" {
			return errors.New("source denied")
		}
		return nil
	}
	body := func() map[string]any {
		return map[string]any{"input": map[string]any{"source_id": "ocr-test-source", "product_id": "ocr-test-product", "profile": map[string]any{"product_type_ru": "Кружка", "facts_ru": "керамическая 330 мл"}, "fixed_tags": []string{"#кружка"}, "image": map[string]any{"bytes": 14, "sha256": strings.Repeat("a", 64), "content_type": "image/png"}}, "upload_ticket": "verified-test-ticket"}
	}
	state := func(t *testing.T, id string, request map[string]any) map[string]any {
		t.Helper()
		rec := f.post("/api/admin/ai/ocr-tests/"+id, f.cookie, request)
		if rec.Code != 200 {
			t.Fatalf("test %d %s", rec.Code, rec.Body.String())
		}
		var out struct {
			Data map[string]any `json:"data"`
		}
		if json.Unmarshal(rec.Body.Bytes(), &out) != nil {
			t.Fatal("invalid result")
		}
		return out.Data
	}
	var receiptID string
	t.Run("supplier_ocr_test_retired_facts_keep_receipt_without_repurchase", func(t *testing.T) {
		id := uuid.NewString()
		before := calls.Load()
		first := state(t, id, body())
		if _, err := f.pool.Exec(f.ctx, `UPDATE ai_requests SET ocr_prompt=jsonb_set(ocr_prompt,'{profile,description_ru}','"Старая фиксированная часть."'::jsonb) WHERE org_id=$1 AND idempotency_key=$2`, f.org, "ocr-test:v1:"+id); err != nil {
			t.Fatal(err)
		}
		rec := get(t, f.handler, "/api/admin/ai/ocr-tests/"+id, f.cookie)
		var out struct {
			Data map[string]any `json:"data"`
		}
		if rec.Code != 200 || json.Unmarshal(rec.Body.Bytes(), &out) != nil || out.Data["state"] != "rejected" || !strings.Contains(rec.Body.String(), "商品事实格式已变化") || calls.Load() != before+1 {
			t.Fatalf("retired receipt was lost or repurchased: %d %s", rec.Code, rec.Body.String())
		}
		if out.Data["billing"].(map[string]any)["charged_microfen"] != first["billing"].(map[string]any)["charged_microfen"] {
			t.Fatal("historical charge changed")
		}
		var retained bool
		if err := f.pool.QueryRow(f.ctx, `SELECT ocr_prompt->'profile' ? 'description_ru' FROM ai_requests WHERE org_id=$1 AND idempotency_key=$2`, f.org, "ocr-test:v1:"+id).Scan(&retained); err != nil || !retained {
			t.Fatal("historical input changed", err)
		}
	})
	t.Run("supplier_ocr_test_rule_failure_never_purchases", func(t *testing.T) {
		validate := runtime.Validate
		defer func() { runtime.Validate = validate }()
		runtime.Validate = func(context.Context, aicontract.Pin, []byte) (json.RawMessage, error) {
			return nil, errors.New("private database failure details")
		}
		before := calls.Load()
		rec := f.post("/api/admin/ai/ocr-tests/"+uuid.NewString(), f.cookie, body())
		if rec.Code != http.StatusServiceUnavailable || strings.Contains(rec.Body.String(), "private database") || calls.Load() != before {
			t.Fatalf("rule failure purchased or exposed internal details: %d %s", rec.Code, rec.Body.String())
		}
	})
	t.Run("supplier_ocr_test_filters_combined_tags_and_rechecks_replay", func(t *testing.T) {
		if _, err := f.pool.Exec(f.ctx, `INSERT INTO banned_tags(term,match_mode,note,created_by) VALUES('кружка','stem','','test')`); err != nil {
			t.Fatal(err)
		}
		defer f.pool.Exec(f.ctx, `DELETE FROM banned_tags WHERE term='кружка'`)
		id := uuid.NewString()
		before := calls.Load()
		request := body()
		request["input"].(map[string]any)["fixed_tags"] = []string{"#кружка", "#подарок"}
		out := state(t, id, request)
		answer := out["answer"].(map[string]any)
		tags := answer["tags"].([]any)
		if out["state"] != "succeeded" || len(tags) != 1 || tags[0] != "#подарок" {
			t.Fatalf("unfiltered test tags: %+v", out)
		}
		if _, err := f.pool.Exec(f.ctx, `UPDATE banned_tags SET term='подарок',match_mode='exact' WHERE term='кружка'`); err != nil {
			t.Fatal(err)
		}
		defer f.pool.Exec(f.ctx, `DELETE FROM banned_tags WHERE term='подарок'`)
		out = state(t, id, request)
		tags = out["answer"].(map[string]any)["tags"].([]any)
		if len(tags) != 6 || tags[0] != "#кружка" || tags[1] != "#белая_кружка" || calls.Load() != before+1 {
			t.Fatalf("replay must apply current rules without another purchase: %+v", out)
		}
	})
	t.Run("supplier_ocr_test_single_purchase_and_immutable_input", func(t *testing.T) {
		id := uuid.NewString()
		receiptID = id
		before := calls.Load()
		request := body()
		first := state(t, id, request)
		if first["state"] != "succeeded" {
			t.Fatalf("result %+v", first)
		}
		if state(t, id, request)["state"] != "succeeded" || calls.Load() != before+1 {
			t.Fatal("POST replay repurchased")
		}
		rec := get(t, f.handler, "/api/admin/ai/ocr-tests/"+id, f.cookie)
		if rec.Code != 200 || calls.Load() != before+1 {
			t.Fatal("GET replay repurchased")
		}
		request["input"].(map[string]any)["profile"].(map[string]any)["facts_ru"] = "500 мл"
		if got := f.post("/api/admin/ai/ocr-tests/"+id, f.cookie, request); got.Code != 409 || calls.Load() != before+1 {
			t.Fatal("mutated input reused receipt", got.Code, got.Body.String())
		}
		var count int
		var settled int64
		if err := f.pool.QueryRow(f.ctx, `SELECT count(*),count(*) FILTER(WHERE status='settled') FROM ai_requests WHERE org_id=$1 AND idempotency_key=$2`, f.org, "ocr-test:v1:"+id).Scan(&count, &settled); err != nil || count != 1 || settled != 1 {
			t.Fatalf("receipt %d %d %v", count, settled, err)
		}
	})
	t.Run("supplier_ocr_test_concurrent_clicks_dispatch_once", func(t *testing.T) {
		previous := runtime.Resolve
		defer func() { runtime.Resolve = previous }()
		started, release := make(chan struct{}), make(chan struct{})
		runtime.Resolve = func(ctx context.Context, routing aicontract.Routing) (ai.OCRProvider, error) {
			provider, err := previous(ctx, routing)
			complete := provider.Complete
			provider.Complete = func(ctx context.Context, raw []byte) (int, []byte, error) {
				close(started)
				select {
				case <-release:
				case <-ctx.Done():
					return 0, nil, ctx.Err()
				}
				return complete(ctx, raw)
			}
			return provider, err
		}
		id := uuid.NewString()
		before := calls.Load()
		request := body()
		done := make(chan *httptest.ResponseRecorder, 1)
		go func() { done <- f.post("/api/admin/ai/ocr-tests/"+id, f.cookie, request) }()
		select {
		case <-started:
		case <-time.After(5 * time.Second):
			t.Fatal("provider did not start")
		}
		repeat := f.post("/api/admin/ai/ocr-tests/"+id, f.cookie, request)
		close(release)
		if repeat.Code != http.StatusOK || !strings.Contains(repeat.Body.String(), `"state":"running"`) {
			t.Fatal("duplicate did not recover running receipt", repeat.Code, repeat.Body.String())
		}
		select {
		case first := <-done:
			if first.Code != 200 || !strings.Contains(first.Body.String(), `"state":"succeeded"`) {
				t.Fatal("first request", first.Code, first.Body.String())
			}
		case <-time.After(5 * time.Second):
			t.Fatal("request did not settle")
		}
		if calls.Load() != before+1 {
			t.Fatal("concurrent requests repurchased")
		}
	})
	t.Run("supplier_ocr_test_unknown_does_not_repurchase", func(t *testing.T) {
		mode.Store(1)
		defer mode.Store(0)
		id := uuid.NewString()
		before := calls.Load()
		request := body()
		if state(t, id, request)["state"] != "unknown" {
			t.Fatal("unknown became success")
		}
		state(t, id, request)
		if calls.Load() != before+1 {
			t.Fatal("unknown repurchased")
		}
	})
	t.Run("supplier_ocr_test_rejected_answer_keeps_bill", func(t *testing.T) {
		mode.Store(3)
		defer mode.Store(0)
		id := uuid.NewString()
		before := calls.Load()
		out := state(t, id, body())
		if out["state"] != "rejected" || out["billing"].(map[string]any)["charged_microfen"].(float64) <= 0 {
			t.Fatalf("paid rejection %+v", out)
		}
		state(t, id, body())
		if calls.Load() != before+1 {
			t.Fatal("rejected answer repurchased")
		}
	})
	t.Run("supplier_ocr_test_denials_never_purchase", func(t *testing.T) {
		before := calls.Load()
		request := body()
		request["input"].(map[string]any)["source_id"] = "another-source"
		if rec := f.post("/api/admin/ai/ocr-tests/"+uuid.NewString(), f.cookie, request); rec.Code != 404 {
			t.Fatal(rec.Code)
		}
		request = body()
		request["system_prompt"] = "overwrite shared prompt"
		if rec := f.post("/api/admin/ai/ocr-tests/"+uuid.NewString(), f.cookie, request); rec.Code != 400 {
			t.Fatal(rec.Code)
		}
		request = body()
		request["upload_ticket"] = "missing"
		if rec := f.post("/api/admin/ai/ocr-tests/"+uuid.NewString(), f.cookie, request); rec.Code != 409 {
			t.Fatal(rec.Code)
		}
		if calls.Load() != before {
			t.Fatal("refused test dispatched provider")
		}
	})
	t.Run("supplier_ocr_test_foreign_receipt", func(t *testing.T) {
		if _, err := f.pool.Exec(f.ctx, `UPDATE account_users SET role='admin' WHERE id=$1`, otherUser); err != nil {
			t.Fatal(err)
		}
		defer f.pool.Exec(f.ctx, `UPDATE account_users SET role=$2 WHERE id=$1`, otherUser, otherRole)
		rec := get(t, f.handler, "/api/admin/ai/ocr-tests/"+receiptID, f.other)
		if rec.Code != 404 {
			t.Fatal("foreign receipt", rec.Code, rec.Body.String())
		}
	})
	t.Run("supplier_ocr_test_member_forbidden", func(t *testing.T) {
		if _, err := f.pool.Exec(f.ctx, `UPDATE account_users SET role='user' WHERE id=$1`, user); err != nil {
			t.Fatal(err)
		}
		defer f.pool.Exec(f.ctx, `UPDATE account_users SET role='admin' WHERE id=$1`, user)
		if rec := f.post("/api/admin/ai/ocr-tests/"+uuid.NewString(), f.cookie, body()); rec.Code != 403 {
			t.Fatal(rec.Code, rec.Body.String())
		}
	})
	t.Run("supplier_ocr_test_revocation_before_hold", func(t *testing.T) {
		previous := runtime.Read
		defer func() {
			runtime.Read = previous
			f.pool.Exec(f.ctx, `UPDATE account_users SET disabled_at=NULL WHERE id=$1`, user)
		}()
		runtime.Read = func(ctx context.Context, p access.Principal, c aicontract.Claim, b aicontract.Binding, ticket string) ([]byte, string, error) {
			raw, mime, err := previous(ctx, p, c, b, ticket)
			if _, failure := f.pool.Exec(f.ctx, `UPDATE account_users SET disabled_at=clock_timestamp() WHERE id=$1`, user); failure != nil {
				return nil, "", failure
			}
			return raw, mime, err
		}
		id := uuid.NewString()
		before := calls.Load()
		rec := f.post("/api/admin/ai/ocr-tests/"+id, f.cookie, body())
		if rec.Code != 403 || calls.Load() != before {
			t.Fatal("revoked account purchased", rec.Code, rec.Body.String())
		}
		var count int
		if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FROM ai_requests WHERE org_id=$1 AND idempotency_key=$2`, f.org, "ocr-test:v1:"+id).Scan(&count); err != nil || count != 0 {
			t.Fatal("revoked account opened bill", count, err)
		}
	})

	var held int64
	if err := f.pool.QueryRow(f.ctx, `SELECT held_microfen FROM workspace_wallets WHERE org_id=$1`, f.org).Scan(&held); err != nil || held != 0 {
		t.Fatalf("wallet hold leaked %d %v", held, err)
	}

}
