package integration

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/podhub-go/internal/ai"
	billingrepo "github.com/xxww0098/podhub-go/internal/billing/repo"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/llm"
	"github.com/xxww0098/podhub-go/tests/testkit"
)

// TestAIResponsesMatchOpenAPI drives every /api/ai route through ai.Register
// and checks status, media type, and JSON body against api/openapi.yaml.
func TestAIResponsesMatchOpenAPI(t *testing.T) {
	spec, err := testkit.LoadOpenAPI()
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	pool := migratedPool(t, ctx)
	if err := purgeAIFixtures(ctx, pool); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := purgeAIFixtures(context.Background(), pool); err != nil {
			t.Errorf("purge ai fixtures: %v", err)
		}
	})
	seedMatchingLease(t, ctx, pool, "billing", "ai openapi test")
	org, user := seedAITenant(t, ctx, pool, 96041)
	priceID := insertPrice(t, ctx, pool, "parity-model")
	if _, err := billingrepo.Adjust(ctx, pool, org, "seed:96041", 300_000_000, "seed"); err != nil {
		t.Fatal(err)
	}
	poorOrg, _ := seedAITenant(t, ctx, pool, 96042)

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"cmpl_spec","model":"parity-model","choices":[{"message":{"role":"assistant","content":"ok"}}],"usage":{"prompt_tokens":10,"completion_tokens":2}}`))
	}))
	defer upstream.Close()
	limits := ai.Limits{}
	router := func(p *access.Principal) http.Handler {
		r := chi.NewRouter()
		ai.Register(r, ai.HTTPDeps{
			Deps: ai.Deps{
				Pool: pool, BaseURL: upstream.URL, Limits: &limits, Converter: llm.Default(),
				Upstream: ai.HTTPUpstream{Client: upstream.Client()},
			},
			Access: access.FixedResolver{Principal: p},
		})
		return r
	}
	owner := router(&access.Principal{UserID: user, OrgID: org, WorkspaceRole: "owner", PlatformRole: "user"})
	member := router(&access.Principal{UserID: user, OrgID: org, WorkspaceRole: "member", PlatformRole: "user"})
	poor := router(&access.Principal{UserID: 96042, OrgID: poorOrg, WorkspaceRole: "owner", PlatformRole: "user"})
	anonymous := router(nil)
	noOrg := router(&access.Principal{UserID: user, WorkspaceRole: "owner", PlatformRole: "user"})

	chatBody := `{"model":"parity-model","messages":[{"role":"user","content":"hi"}]}`
	type call struct {
		name    string
		handler http.Handler
		method  string
		path    string
		spec    string
		key     string
		body    string
		status  int
	}
	run := func(t *testing.T, c call) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(c.method, c.path, strings.NewReader(c.body))
		req.RemoteAddr = "198.51.100.10:443"
		if c.key != "" {
			req.Header.Set("Idempotency-Key", c.key)
		}
		if c.body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		rec := httptest.NewRecorder()
		c.handler.ServeHTTP(rec, req)
		if rec.Code != c.status {
			t.Fatalf("%s: status %d want %d body %s", c.name, rec.Code, c.status, rec.Body.Bytes())
		}
		path := c.spec
		if path == "" {
			path = c.path
		}
		if err := spec.CheckResponse(c.method, path, rec.Code, rec.Header(), rec.Body.Bytes()); err != nil {
			t.Fatalf("%s: %v\n%s", c.name, err, rec.Body.Bytes())
		}
		return rec
	}
	for _, c := range []call{
		{name: "chat settles", handler: owner, method: "POST", path: "/api/ai/chat/completions", key: "spec-chat-1", body: chatBody, status: 200},
		{name: "chat replays", handler: owner, method: "POST", path: "/api/ai/chat/completions", key: "spec-chat-1", body: chatBody, status: 200},
		{name: "chat without key", handler: owner, method: "POST", path: "/api/ai/chat/completions", body: chatBody, status: 400},
		{name: "chat unknown model", handler: owner, method: "POST", path: "/api/ai/chat/completions", key: "spec-chat-2", body: `{"model":"no-such-model","messages":[]}`, status: 503},
		{name: "chat stream refused upstream", handler: owner, method: "POST", path: "/api/ai/chat/completions", key: "spec-chat-3", body: `{"model":"parity-model","stream":true,"messages":[{"role":"user","content":"hi"}]}`, status: 502},
		{name: "chat empty wallet", handler: poor, method: "POST", path: "/api/ai/chat/completions", key: "spec-chat-4", body: chatBody, status: 402},
		{name: "chat signed out", handler: anonymous, method: "POST", path: "/api/ai/chat/completions", key: "spec-chat-5", body: chatBody, status: 401},
		{name: "chat without workspace", handler: noOrg, method: "POST", path: "/api/ai/chat/completions", key: "spec-chat-6", body: chatBody, status: 403},
		{name: "ocr post refused", handler: owner, method: "POST", path: "/api/ai/ocr/completions", body: `{}`, status: 400},
		{name: "ocr get without key", handler: owner, method: "GET", path: "/api/ai/ocr/completions", status: 400},
		{name: "ocr get unknown key", handler: owner, method: "GET", path: "/api/ai/ocr/completions", key: "spec-ocr-missing", status: 404},
		{name: "wallet", handler: owner, method: "GET", path: "/api/ai/wallet", status: 200},
		{name: "wallet signed out", handler: anonymous, method: "GET", path: "/api/ai/wallet", status: 401},
		{name: "usage", handler: owner, method: "GET", path: "/api/ai/usage", status: 200},
		{name: "prices", handler: member, method: "GET", path: "/api/ai/prices", status: 200},
		{name: "logs manager", handler: owner, method: "GET", path: "/api/ai/logs?page_size=1000", spec: "/api/ai/logs", status: 200},
		{name: "logs member", handler: member, method: "GET", path: "/api/ai/logs", status: 200},
		{name: "logs page limit", handler: owner, method: "GET", path: "/api/ai/logs?p=100001", spec: "/api/ai/logs", status: 400},
		{name: "logs stat", handler: owner, method: "GET", path: "/api/ai/logs/stat", status: 200},
		{name: "logs stat bad window", handler: owner, method: "GET", path: "/api/ai/logs/stat?start_timestamp=2&end_timestamp=1", spec: "/api/ai/logs/stat", status: 400},
		{name: "logs export", handler: member, method: "GET", path: "/api/ai/logs/export", status: 200},
		{name: "logs export bad type", handler: member, method: "GET", path: "/api/ai/logs/export?type=9", spec: "/api/ai/logs/export", status: 400},
	} {
		t.Run(c.name, func(t *testing.T) { run(t, c) })
	}

	t.Run("usage carries an error class", func(t *testing.T) {
		rec := run(t, call{name: "usage", handler: owner, method: "GET", path: "/api/ai/usage", status: 200})
		if !bytes.Contains(rec.Body.Bytes(), []byte(`"error_class":"`)) || !bytes.Contains(rec.Body.Bytes(), []byte(`"error_class":null`)) {
			t.Fatalf("want both a null and a set error_class: %s", rec.Body.Bytes())
		}
	})

	t.Run("ocr stored result", func(t *testing.T) {
		if _, err := pool.Exec(ctx, `
			INSERT INTO ai_requests
			    (public_id, org_id, user_id, idempotency_key, operation, model, upstream_account_id,
			     status, price_schedule_id, billing_mode, per_request_microfen,
			     input_microfen_per_million, cached_input_microfen_per_million,
			     output_microfen_per_million, reasoning_microfen_per_million, held_microfen,
			     prompt_tokens, cached_prompt_tokens, completion_tokens, reasoning_completion_tokens,
			     api_format, response_body)
			VALUES ('air_spec_ocr', $1, $2, 'spec-ocr-1', 'ocr', 'parity-model', 'loopback',
			        'settled', $3, 'token', 0, 1000000, 0, 1000000, 0, 0,
			        1, 0, 1, 0, 'chat_completions', '{"text":"ok"}')`, org, user, priceID); err != nil {
			t.Fatal(err)
		}
		run(t, call{name: "ocr get", handler: owner, method: "GET", path: "/api/ai/ocr/completions", key: "spec-ocr-1", status: 200})
	})

	t.Run("export busy", func(t *testing.T) {
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
		run(t, call{name: "export busy", handler: owner, method: "GET", path: "/api/ai/logs/export", status: 429})
	})

	t.Run("in flight replay sets Retry-After", func(t *testing.T) {
		if _, err := pool.Exec(ctx, `
			INSERT INTO ai_requests
			    (public_id, org_id, user_id, idempotency_key, operation, model, upstream_account_id,
			     status, price_schedule_id, billing_mode, per_request_microfen,
			     input_microfen_per_million, cached_input_microfen_per_million,
			     output_microfen_per_million, reasoning_microfen_per_million, held_microfen,
			     prompt_tokens, cached_prompt_tokens, completion_tokens, reasoning_completion_tokens,
			     api_format)
			VALUES ('air_spec_held', $1, $2, 'spec-held-1', 'ai_token', 'parity-model', 'loopback',
			        'held', $3, 'token', 0, 1000000, 0, 1000000, 0, 0,
			        0, 0, 0, 0, 'chat_completions')`, org, user, priceID); err != nil {
			t.Fatal(err)
		}
		rec := run(t, call{name: "held", handler: owner, method: "POST", path: "/api/ai/chat/completions", key: "spec-held-1", body: chatBody, status: 409})
		if rec.Header().Get("Retry-After") != "1" {
			t.Fatalf("Retry-After %q", rec.Header().Get("Retry-After"))
		}
	})
}
