package integration

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/ai"
	billingrepo "github.com/xxww0098/podhub-go/internal/billing/repo"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/llm"
	"github.com/xxww0098/podhub-go/internal/platform/writer"
)

func TestAIConsumeLogAPI(t *testing.T) {
	ctx := context.Background()
	pool := migratedPool(t, ctx)
	user, org := insertWorkspace(t, ctx, pool, "logs-owner@example.invalid", "Owner")
	other, otherOrg := insertWorkspace(t, ctx, pool, "logs-other@example.invalid", "Other")
	t.Cleanup(func() {
		cleanupLogFixture(t, context.Background(), pool, []int64{org, otherOrg}, []int64{user, other})
	})

	now := time.Now().Unix()
	otherJSON := `{"admin_info":{"quota_saturation":true},"root_info":1,"audit_info":{},"channel_id":3,"channel_name":"hidden","channel_type":1,"reject_reason":"no","model_ratio":1.5}`
	if _, err := pool.Exec(ctx, `
		INSERT INTO ai_consume_logs
		    (org_id, user_id, created_at, type, content, username, token_name, model_name, quota,
		     prompt_tokens, completion_tokens, channel, "group", ip, request_id, other)
		VALUES
		    ($1, $2, $3, 2, '=1+1', 'alice', 'tok', 'qwen', 100, 10, 10, 7, 'default', '203.0.113.9', 'req-old', $4::jsonb),
		    ($1, $2, $5, 2, 'ok', 'bob', 'tok', 'qwen', 5, 3, 4, 7, 'default', '203.0.113.9', 'req-new', '{"model_ratio":1}'::jsonb),
		    ($1, $2, $5, 1, 'topup', 'alice', '', 'qwen', 9, 0, 0, 0, 'default', '', 'req-type', '{}'::jsonb),
		    ($6, $7, $5, 2, 'foreign', 'alice', '', 'qwen', 50, 1, 1, 1, 'default', '1.2.3.4', 'req-foreign', '{}'::jsonb)`,
		org, user, now-120, otherJSON, now, otherOrg, other); err != nil {
		t.Fatal(err)
	}

	member := logRouter(pool, user, org, "member")
	owner := logRouter(pool, user, org, "owner")
	foreign := logRouter(pool, other, otherOrg, "owner")

	t.Run("member strips admin fields and ignores admin filters", func(t *testing.T) {
		status, raw := getAI(t, member, "/api/ai/logs?username=alice&channel=7")
		if status != 200 {
			t.Fatalf("%d %s", status, raw)
		}
		var payload struct {
			Total int `json:"total"`
			Items []struct {
				Username  string          `json:"username"`
				Channel   int             `json:"channel"`
				IP        string          `json:"ip"`
				Other     json.RawMessage `json:"other"`
				RequestID string          `json:"request_id"`
			} `json:"items"`
		}
		if err := json.Unmarshal(raw, &payload); err != nil {
			t.Fatal(err)
		}
		if payload.Total != 3 {
			t.Fatalf("total %d %s", payload.Total, raw)
		}
		for _, item := range payload.Items {
			if item.Channel != 0 || item.IP != "" {
				t.Fatalf("member saw channel %d ip %s", item.Channel, item.IP)
			}
			var obj map[string]json.RawMessage
			if err := json.Unmarshal(item.Other, &obj); err != nil {
				t.Fatal(err)
			}
			if _, ok := obj["admin_info"]; ok {
				t.Fatalf("admin_info %s", item.Other)
			}
		}
	})

	t.Run("manager filters username and sees admin info", func(t *testing.T) {
		status, raw := getAI(t, owner, "/api/ai/logs?username=alice&type=2")
		if status != 200 || !bytes.Contains(raw, []byte(`"total":1`)) || !bytes.Contains(raw, []byte(`"admin_info"`)) {
			t.Fatalf("%d %s", status, raw)
		}
		if !bytes.Contains(raw, []byte(`"channel":7`)) || !bytes.Contains(raw, []byte(`203.0.113.9`)) {
			t.Fatalf("%s", raw)
		}
	})

	t.Run("other org sees only its row", func(t *testing.T) {
		status, raw := getAI(t, foreign, "/api/ai/logs")
		if status != 200 || !bytes.Contains(raw, []byte(`"total":1`)) || bytes.Contains(raw, []byte("req-new")) {
			t.Fatalf("%d %s", status, raw)
		}
	})

	t.Run("page size caps at 100", func(t *testing.T) {
		status, raw := getAI(t, owner, "/api/ai/logs?page_size=1000&p=1")
		if status != 200 || !bytes.Contains(raw, []byte(`"page_size":100`)) {
			t.Fatalf("%d %s", status, raw)
		}
		status, raw = getAI(t, owner, "/api/ai/logs?p=100001")
		if status != 400 {
			t.Fatalf("%d %s", status, raw)
		}
	})

	t.Run("stat quota follows the window and rpm does not", func(t *testing.T) {
		status, raw := getAI(t, owner, fmt.Sprintf("/api/ai/logs/stat?start_timestamp=%d", now-30))
		if status != 200 {
			t.Fatalf("%d %s", status, raw)
		}
		var payload struct {
			Quota int64 `json:"quota"`
			RPM   int64 `json:"rpm"`
			TPM   int64 `json:"tpm"`
		}
		if err := json.Unmarshal(raw, &payload); err != nil {
			t.Fatal(err)
		}
		// The old consume row is outside the filter and outside the last minute.
		// Type 1 is inside the filter but is not consume, so quota is the new row only.
		if payload.Quota != 5 || payload.RPM != 1 || payload.TPM != 7 {
			t.Fatalf("%+v %s", payload, raw)
		}
		status, raw = getAI(t, owner, "/api/ai/logs/stat?type=1")
		if err := json.Unmarshal(raw, &payload); err != nil || status != 200 {
			t.Fatalf("%d %v %s", status, err, raw)
		}
		if payload.Quota != 0 || payload.RPM != 1 {
			t.Fatalf("type filter %+v", payload)
		}
	})

	t.Run("csv escapes formulas and blanks member fields", func(t *testing.T) {
		status, raw := getAI(t, member, "/api/ai/logs/export")
		if status != 200 || !bytes.HasPrefix(raw, []byte("id,")) {
			t.Fatalf("%d %s", status, raw)
		}
		rows, err := csv.NewReader(bytes.NewReader(raw)).ReadAll()
		if err != nil {
			t.Fatal(err)
		}
		if len(rows) != 4 {
			t.Fatalf("rows %d %q", len(rows), raw)
		}
		var content, channel, ip, other int
		for i, name := range rows[0] {
			switch name {
			case "content":
				content = i
			case "channel":
				channel = i
			case "ip":
				ip = i
			case "other":
				other = i
			}
		}
		sawFormula := false
		for _, row := range rows[1:] {
			if row[content] == "'=1+1" {
				sawFormula = true
			}
			if strings.HasPrefix(row[content], "=") || strings.HasPrefix(row[content], "+") || strings.HasPrefix(row[content], "-") || strings.HasPrefix(row[content], "@") {
				t.Fatalf("unescaped %q", row[content])
			}
			if row[channel] != "0" || row[ip] != "" {
				t.Fatalf("member csv %q", row)
			}
			if strings.Contains(row[other], "admin_info") {
				t.Fatalf("member other %s", row[other])
			}
		}
		if !sawFormula {
			t.Fatalf("missing formula row %q", raw)
		}
		status, raw = getAI(t, owner, "/api/ai/logs/export")
		if status != 200 || !bytes.Contains(raw, []byte("admin_info")) {
			t.Fatalf("manager export %d %s", status, raw)
		}
	})

	t.Run("second export waits on the user lock", func(t *testing.T) {
		lock, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer lock.Rollback(ctx)
		var locked bool
		if err := lock.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0))`,
			fmt.Sprintf("ai-consume-log-export:%d", user)).Scan(&locked); err != nil || !locked {
			t.Fatalf("lock %v %v", locked, err)
		}
		status, raw := getAI(t, owner, "/api/ai/logs/export")
		if status != 429 || !bytes.Contains(raw, []byte("已有导出正在进行")) {
			t.Fatalf("%d %s", status, raw)
		}
	})

	t.Run("export refuses more than 10000 rows", func(t *testing.T) {
		if _, err := pool.Exec(ctx, `
			INSERT INTO ai_consume_logs (org_id, user_id, created_at, type, quota)
			SELECT $1, $2, 1, 2, 1 FROM generate_series(1, 10001)`, otherOrg, other); err != nil {
			t.Fatal(err)
		}
		status, raw := getAI(t, foreign, "/api/ai/logs/export")
		if status != 400 || !bytes.Contains(raw, []byte("10000")) {
			t.Fatalf("%d %s", status, raw)
		}
	})
}

func TestChatWalletRaceAndLease(t *testing.T) {
	ctx := context.Background()
	pool := migratedPool(t, ctx)
	if err := purgeAIFixtures(ctx, pool); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := purgeAIFixtures(context.Background(), pool); err != nil {
			t.Errorf("purge: %v", err)
		}
		_, _ = pool.Exec(context.Background(), `DELETE FROM ai_price_schedules WHERE model = 'race-model'`)
	})
	seedMatchingLease(t, ctx, pool, "billing", "ai wallet race")
	org, user := seedAITenant(t, ctx, pool, 96031)
	var org2 int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO organizations (owner_user_id, name, plan, created_at, updated_at)
		VALUES ($1, 'org-shared', 'lite', clock_timestamp(), clock_timestamp()) RETURNING id`, user).Scan(&org2); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO organization_members (org_id, user_id, role, status, display_name, created_at, updated_at, join_order)
		VALUES ($1, $2, 'owner', 'active', 'AI', clock_timestamp(), clock_timestamp(), 1)`, org2, user); err != nil {
		t.Fatal(err)
	}
	priceID := insertPrice(t, ctx, pool, "race-model")
	if _, err := billingrepo.Adjust(ctx, pool, org, "seed:96031", 1000, "seed"); err != nil {
		t.Fatal(err)
	}

	t.Run("two orgs one wallet", func(t *testing.T) {
		var calls int
		var mu sync.Mutex
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			mu.Lock()
			calls++
			mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":"cmpl_race","choices":[{"message":{"role":"assistant","content":"ok"}}],"usage":{"prompt_tokens":1000,"completion_tokens":0}}`))
		}))
		defer upstream.Close()
		body := `{"model":"race-model","messages":[{"role":"user","content":"` + strings.Repeat("x", 3997) + `"}]}`
		limits := ai.Limits{}
		deps := ai.Deps{Pool: pool, BaseURL: upstream.URL, Limits: &limits, Converter: llm.Default(), Upstream: ai.HTTPUpstream{Client: upstream.Client()}}
		raceCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		var wg sync.WaitGroup
		type result struct {
			org  int64
			resp ai.Response
		}
		out := make(chan result, 2)
		for i, id := range []int64{org, org2} {
			wg.Add(1)
			go func(i int, id int64) {
				defer wg.Done()
				out <- result{id, ai.Chat(raceCtx, deps, id, user, fmt.Sprintf("race-%d", i), []byte(body))}
			}(i, id)
		}
		wg.Wait()
		close(out)
		ok, denied := 0, 0
		for item := range out {
			raw, _ := json.Marshal(item.resp.JSON)
			if bytes.Contains(raw, []byte("40P01")) {
				t.Fatalf("deadlock %s", raw)
			}
			switch item.resp.Status {
			case 200:
				ok++
				var payload struct {
					Billing struct {
						Charged int64 `json:"charged_microfen"`
						Total   int64 `json:"total_microfen"`
					} `json:"billing"`
				}
				if err := json.Unmarshal(raw, &payload); err != nil || payload.Billing.Charged != 1000 || payload.Billing.Total != 1000 {
					t.Fatalf("%s", raw)
				}
			case 402:
				denied++
			default:
				t.Fatalf("org %d status %d %s", item.org, item.resp.Status, raw)
			}
		}
		if ok != 1 || denied != 1 || calls != 1 {
			t.Fatalf("ok %d denied %d calls %d", ok, denied, calls)
		}
		if walletBalance(t, ctx, pool, user) != 0 {
			t.Fatalf("balance %d", walletBalance(t, ctx, pool, user))
		}
		var held, holds int64
		if err := pool.QueryRow(ctx, `SELECT held_microfen FROM user_wallets WHERE user_id = $1`, user).Scan(&held); err != nil || held != 0 {
			t.Fatalf("held %d %v", held, err)
		}
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM wallet_ledger WHERE user_id = $1 AND entry_type = 'hold'`, user).Scan(&holds); err != nil || holds != 1 {
			t.Fatalf("holds %d %v", holds, err)
		}
		mismatches, err := billingrepo.CheckInvariant(ctx, pool)
		if err != nil {
			t.Fatal(err)
		}
		for _, row := range mismatches {
			if row.UserID == user {
				t.Fatalf("invariant %+v", row)
			}
		}
	})

	t.Run("provider cache above prompt is stored", func(t *testing.T) {
		if _, err := pool.Exec(ctx, `
			INSERT INTO ai_requests
			    (public_id, org_id, user_id, idempotency_key, operation, model, upstream_account_id,
			     status, price_schedule_id, billing_mode, per_request_microfen,
			     input_microfen_per_million, cached_input_microfen_per_million,
			     output_microfen_per_million, reasoning_microfen_per_million, held_microfen,
			     prompt_tokens, cached_prompt_tokens, completion_tokens, reasoning_completion_tokens,
			     api_format)
			VALUES ('air_subset', $1, $2, 'subset-1', 'ai_token', 'race-model', 'loopback',
			        'settled', $3, 'token', 0, 1000000, 0, 1000000, 0, 0,
			        1, 2, 1, 2, 'chat_completions')`, org, user, priceID); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("foreign billing lease refuses before a row", func(t *testing.T) {
		id := writer.ProcessIdentity()
		now := time.Now().UnixMilli()
		if _, err := pool.Exec(ctx, `DELETE FROM writer_leases WHERE domain = 'billing'`); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO writer_leases
			    (domain, holder, holder_instance, fence_token, granted_at_ms, expires_at_ms, heartbeat_at_ms, grant_reason)
			VALUES ('billing', 'axum', $1, 1, $2::bigint, $2::bigint + 120000, $2::bigint, 'test')`, id.InstanceID+"-other", now); err != nil {
			t.Fatal(err)
		}
		limits := ai.Limits{}
		deps := ai.Deps{Pool: pool, BaseURL: "http://127.0.0.1:9", Limits: &limits, Converter: llm.Default(), Upstream: hitUpstream{hit: new(bool)}}
		resp := ai.Chat(ctx, deps, org, user, "lease-foreign", []byte(`{"model":"race-model","messages":[{"role":"user","content":"hi"}]}`))
		raw, _ := json.Marshal(resp.JSON)
		if resp.Status != 503 || !bytes.Contains(raw, []byte("WRITES_DISABLED")) || !bytes.Contains(raw, []byte("计费写入未启用")) {
			t.Fatalf("%d %s", resp.Status, raw)
		}
		var n int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM ai_requests WHERE idempotency_key = 'lease-foreign'`).Scan(&n); err != nil || n != 0 {
			t.Fatalf("rows %d %v", n, err)
		}
		if _, err := billingrepo.Adjust(ctx, pool, org, "seed:96031:lease", 1000, "seed"); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `
			UPDATE writer_leases SET holder_instance = $1, heartbeat_at_ms = $2::bigint, expires_at_ms = $2::bigint + 120000
			 WHERE domain = 'billing' AND revoked_at_ms IS NULL`, id.InstanceID, now); err != nil {
			t.Fatal(err)
		}
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(`{"id":"cmpl_lease","choices":[{"message":{"role":"assistant","content":"ok"}}],"usage":{"prompt_tokens":1,"completion_tokens":0}}`))
		}))
		defer upstream.Close()
		deps.BaseURL = upstream.URL
		deps.Upstream = ai.HTTPUpstream{Client: upstream.Client()}
		resp = ai.Chat(ctx, deps, org, user, "lease-match", []byte(`{"model":"race-model","messages":[{"role":"user","content":"hi"}]}`))
		if resp.Status != 200 {
			raw, _ = json.Marshal(resp.JSON)
			t.Fatalf("%d %s", resp.Status, raw)
		}
		var beat, exp int64
		if err := pool.QueryRow(ctx, `
			SELECT heartbeat_at_ms, expires_at_ms FROM writer_leases WHERE domain = 'billing' AND revoked_at_ms IS NULL`).Scan(&beat, &exp); err != nil {
			t.Fatal(err)
		}
		if beat < now || exp != beat+writer.LeaseTTLMS {
			t.Fatalf("heartbeat %d expires %d now %d", beat, exp, now)
		}
	})
}

func logRouter(pool *pgxpool.Pool, user, org int64, role string) http.Handler {
	router := chi.NewRouter()
	ai.Register(router, ai.HTTPDeps{
		Deps:   ai.Deps{Pool: pool},
		Access: access.FixedResolver{Principal: &access.Principal{UserID: user, OrgID: org, WorkspaceRole: role}},
	})
	return router
}

func getAI(t *testing.T, handler http.Handler, path string) (int, []byte) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.RemoteAddr = "198.51.100.10:443"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	raw, _ := io.ReadAll(rec.Body)
	return rec.Code, raw
}

func cleanupLogFixture(t *testing.T, ctx context.Context, pool *pgxpool.Pool, orgs, users []int64) {
	t.Helper()
	if _, err := pool.Exec(ctx, `DELETE FROM ai_consume_logs WHERE org_id = ANY($1)`, orgs); err != nil {
		t.Errorf("logs: %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM organization_members WHERE org_id = ANY($1)`, orgs); err != nil {
		t.Errorf("members: %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM organizations WHERE id = ANY($1)`, orgs); err != nil {
		t.Errorf("orgs: %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM account_users WHERE id = ANY($1)`, users); err != nil {
		t.Errorf("users: %v", err)
	}
}
