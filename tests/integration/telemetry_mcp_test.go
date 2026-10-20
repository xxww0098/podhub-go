package integration

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/podhub-go/internal/mcp/domain"
	mcphttp "github.com/xxww0098/podhub-go/internal/mcp/http"
	mcprepo "github.com/xxww0098/podhub-go/internal/mcp/repo"
	mcpsvc "github.com/xxww0098/podhub-go/internal/mcp/service"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	telemetrydomain "github.com/xxww0098/podhub-go/internal/telemetry/domain"
	telemetryhttp "github.com/xxww0098/podhub-go/internal/telemetry/http"
	telemetryrepo "github.com/xxww0098/podhub-go/internal/telemetry/repo"
	telemetrysvc "github.com/xxww0098/podhub-go/internal/telemetry/service"
)

func TestTelemetryInboxAndClientLogs(t *testing.T) {
	ctx := context.Background()
	pool := migratedPool(t, ctx)
	seedMatchingLease(t, ctx, pool, "telemetry", "telemetry test")
	stamp := strconv.FormatInt(time.Now().UnixNano(), 36)
	user, org := insertWorkspace(t, ctx, pool, "tm-inbox-"+stamp+"@example.com", "Telemetry")
	// Override 0 is rejected by ck_organizations_store_limit_override. A legal
	// store count of 1 plus a rollup already at that month's byte limit makes
	// the next upload fail closed.
	if _, err := pool.Exec(ctx, `UPDATE organizations SET store_limit_override = 1 WHERE id = $1`, org); err != nil {
		t.Fatal(err)
	}
	insertRollup(t, ctx, pool, org, user, "2026-08", "traffic.user_to_s3_bytes", telemetrydomain.S3BytesForStores(1))
	if _, err := pool.Exec(ctx, `
		INSERT INTO organization_members (org_id, user_id, role, status, display_name, join_order, created_at, updated_at)
		VALUES ($1, $2, 'owner', 'active', 'Telemetry', 1, clock_timestamp(), clock_timestamp())`, org, user); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM audit_logs WHERE entity_id = 'dev-tm'`)
		_, _ = pool.Exec(context.Background(), `DELETE FROM billable_usage_events WHERE event_id LIKE 'dev-tm:%'`)
		_, _ = pool.Exec(context.Background(), `DELETE FROM billable_usage_rollups WHERE org_id = $1`, org)
		_, _ = pool.Exec(context.Background(), `DELETE FROM event_inbox_events WHERE device_uid = 'dev-tm'`)
		_, _ = pool.Exec(context.Background(), `DELETE FROM client_listing_logs WHERE user_id = $1`, user)
		_, _ = pool.Exec(context.Background(), `DELETE FROM writer_leases WHERE domain = 'telemetry' AND holder_instance = 'tm-test'`)
	})

	r := chi.NewRouter()
	telemetryhttp.Mount(r, telemetryhttp.Deps{
		Resolve: fixedTelemetry(user, org, "owner"),
		Actions: telemetrysvc.New(telemetryrepo.New(pool)),
		Collect: true,
		Now:     func() time.Time { return time.Date(2026, 10, 9, 3, 0, 1, 0, time.UTC) },
	})

	desktop := `{"events":[{"id":"evt_fixture_001","kind":"desktop_error_log.v1","payload_json":"{\"schemaVersion\":1,\"source\":\"host_uncaught\",\"code\":\"fixture:replay\",\"fingerprint\":\"0123456789abcdef\",\"message\":\"fixture replay\",\"appVersion\":\"0.9.4\",\"os\":\"darwin\",\"occurredAt\":\"2026-08-02T12:00:00Z\"}","schema_version":1}]}`
	rec := postTM(r, "/api/events/inbox", "dev-tm", desktop)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"accepted":["evt_fixture_001"]`) || !strings.Contains(rec.Body.String(), `"rejected":[]`) {
		t.Fatalf("accept %d %s", rec.Code, rec.Body.String())
	}
	rec = postTM(r, "/api/events/inbox", "dev-tm", desktop)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"accepted":["evt_fixture_001"]`) {
		t.Fatalf("replay %d %s", rec.Code, rec.Body.String())
	}
	var rows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM event_inbox_events WHERE device_uid = 'dev-tm' AND id = 'evt_fixture_001'`).Scan(&rows); err != nil || rows != 1 {
		t.Fatalf("inbox rows %d %v", rows, err)
	}

	other := chi.NewRouter()
	telemetryhttp.Mount(other, telemetryhttp.Deps{
		Resolve: fixedTelemetry(user+100000, org, "owner"),
		Actions: telemetrysvc.New(telemetryrepo.New(pool)),
		Collect: true,
		Now:     func() time.Time { return time.Date(2026, 10, 9, 3, 0, 1, 0, time.UTC) },
	})
	rec = postTM(other, "/api/events/inbox", "dev-tm", desktop)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "同 id 异身份冲突") {
		t.Fatalf("identity %d %s", rec.Code, rec.Body.String())
	}

	ai := `{"events":[{"id":"ai-1","kind":"billing.ai-token-usage.v1","payload_json":"{\"schemaVersion\":1,\"provider\":\"openai\",\"model\":\"gpt-fixture\",\"inputTokens\":12,\"outputTokens\":3,\"totalTokens\":15,\"occurredAt\":\"2026-08-09T17:15:41Z\",\"responseId\":\"resp-1\"}","schema_version":1}]}`
	rec = postTM(r, "/api/events/inbox", "dev-tm", ai)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"ai-1"`) || strings.Contains(rec.Body.String(), "上行流量") {
		t.Fatalf("ai %d %s", rec.Code, rec.Body.String())
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM billable_usage_events WHERE event_id = 'dev-tm:ai-1'`).Scan(&rows); err != nil || rows != 2 {
		t.Fatalf("ai rows %d %v", rows, err)
	}

	upload := `{"events":[{"id":"up-1","kind":"billing.object-upload-usage.v1","payload_json":"{\"schemaVersion\":1,\"bytes\":10,\"occurredAt\":\"2026-08-09T17:15:41Z\",\"objectKey\":\"k\",\"contentHash\":\"h\",\"outcome\":\"uploaded\"}","schema_version":1}]}`
	rec = postTM(r, "/api/events/inbox", "dev-tm", upload)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "工作空间上行流量已用尽") {
		t.Fatalf("quota %d %s", rec.Code, rec.Body.String())
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM billable_usage_events WHERE event_id = 'dev-tm:up-1'`).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("upload rows %d %v", rows, err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM event_inbox_events WHERE device_uid = 'dev-tm' AND id = 'up-1'`).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("upload inbox %d %v", rows, err)
	}

	logs := `{"records":[{"id":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","ts":"2026-10-09T03:00:00Z","level":"info","module":"upload","event":"upload.end","sessionId":"11111111-2222-4333-8444-555555555555","version":"0.0.99"}]}`
	rec = postTM(r, "/api/listing/client-logs", "", logs)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"accepted":1`) {
		t.Fatalf("logs %d %s", rec.Code, rec.Body.String())
	}
	userB, orgB := insertWorkspace(t, ctx, pool, "tm-other-"+stamp+"@example.com", "Other")
	txB, err := tenantx.BeginApp(ctx, pool.Begin, orgB)
	if err != nil {
		t.Fatal(err)
	}
	if err := txB.QueryRow(ctx, `SELECT count(*) FROM client_listing_logs WHERE user_id = $1`, user).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("cross org %d %v", rows, err)
	}
	_ = txB.Rollback(ctx)
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('role', $1, true)`, tenantx.RoleApp); err != nil {
		t.Fatal(err)
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO client_listing_logs (org_id, user_id, client_id, session_id, version, logged_at, level, module, event, fields)
		VALUES ($1, $2, 'missing-guc', '11111111-2222-4333-8444-555555555555', '0.0.1', clock_timestamp(), 'info', 'm', 'e', '{}'::jsonb)`, org, user)
	if err == nil {
		t.Fatal("missing GUC insert succeeded")
	}
	_ = tx.Rollback(ctx)
	_ = userB

	if _, err := pool.Exec(ctx, `DELETE FROM writer_leases WHERE domain = 'telemetry' AND revoked_at_ms IS NULL`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO writer_leases (domain, holder, holder_instance, fence_token, granted_at_ms, expires_at_ms, heartbeat_at_ms, grant_reason)
		VALUES ('telemetry', 'axum', 'tm-test', 1, 1, 9999999999999, 9999999999999, 'test')`); err != nil {
		t.Fatal(err)
	}
	before := rows
	_ = before
	rec = postTM(r, "/api/events/inbox", "dev-tm", `{"events":[{"id":"after-lease","kind":"desktop_error_log.v1","payload_json":"{\"schemaVersion\":1,\"source\":\"host_uncaught\",\"code\":\"c\",\"fingerprint\":\"0123456789abcdef\",\"message\":\"m\",\"appVersion\":\"v\",\"os\":\"darwin\",\"occurredAt\":\"2026-08-02T12:00:00Z\"}","schema_version":1}]}`)
	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), `"code":"WRITES_DISABLED"`) || !strings.Contains(rec.Body.String(), "遥测域写入未启用") {
		t.Fatalf("lease %d %s", rec.Code, rec.Body.String())
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM event_inbox_events WHERE device_uid = 'dev-tm' AND id = 'after-lease'`).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("lease wrote %d %v", rows, err)
	}
}

func TestMCPGrantContextAndReplay(t *testing.T) {
	ctx := context.Background()
	pool := migratedPool(t, ctx)
	stamp := strconv.FormatInt(time.Now().UnixNano(), 36)
	user, org := insertWorkspace(t, ctx, pool, "tm-mcp-"+stamp+"@example.com", "MCP Space")
	if _, err := pool.Exec(ctx, `
		INSERT INTO organization_members (org_id, user_id, role, status, display_name, join_order, created_at, updated_at)
		VALUES ($1, $2, 'owner', 'active', 'MCP', 1, clock_timestamp(), clock_timestamp())`, org, user); err != nil {
		t.Fatal(err)
	}
	token := "opa_tm_token_0123456789"
	grantID := "33333333-3333-4333-8333-333333333333"
	if _, err := pool.Exec(ctx, `
		INSERT INTO automation_grants (id, user_id, org_id, name, token_hash, token_prefix, actions)
		VALUES ($1::uuid, $2, $3, 'tm-mcp', $4, 'opa_tm', ARRAY['read']::text[])`,
		grantID, user, org, domain.HashToken(token)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM automation_call_receipts WHERE grant_id = $1::uuid`, grantID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM automation_executions WHERE grant_id = $1::uuid`, grantID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM automation_grants WHERE id = $1::uuid`, grantID)
	})

	r := chi.NewRouter()
	mcphttp.Mount(r, mcphttp.Deps{Handler: mcpsvc.New(mcprepo.New(pool))})
	version, err := domain.Version(domain.Grant{
		ID: grantID, UserID: user, OrgID: org, ScopeKind: "workspace",
		Actions: []string{"read"}, WorkspaceRole: "owner", PlatformRole: "user",
	})
	if err != nil {
		t.Fatal(err)
	}
	initReq := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`))
	initReq.Host = "localhost"
	initReq.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, initReq)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"protocolVersion":"2025-11-25"`) {
		t.Fatalf("init %d %s", rec.Code, rec.Body.String())
	}

	execID := "4c6e26ec-9e8f-46e1-bc45-0289951d5f16"
	body := `{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"execute","arguments":{"executionId":"` + execID + `","catalogVersion":"` + version + `","code":"return await sdk.workspace.getContext(input);","input":{}}}}`
	req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(body))
	req.Host = "127.0.0.1"
	req.Header.Set("Authorization", "Bearer "+token)
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"status":"completed"`) || !strings.Contains(rec.Body.String(), `"workspaceName":"MCP Space"`) {
		t.Fatalf("context %d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(body))
	req.Host = "127.0.0.1"
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || strings.Contains(rec.Body.String(), `"value"`) || !strings.Contains(rec.Body.String(), `"status":"completed"`) {
		t.Fatalf("replay %d %s", rec.Code, rec.Body.String())
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('role', $1, true), set_config('app.automation_grant_id', $2, true)`, tenantx.RoleApp, "44444444-4444-4444-8444-444444444444"); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM automation_executions WHERE grant_id = $1::uuid`, grantID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("other grant saw %d", n)
	}
}

func fixedTelemetry(user, org int64, role string) telemetryhttp.Resolve {
	return func(*http.Request) (*telemetryhttp.Session, *telemetryhttp.Refusal, error) {
		return &telemetryhttp.Session{UserID: user, OrgID: org, WorkspaceRole: role, PlatformRole: "user"}, nil, nil
	}
}

func postTM(r http.Handler, path, device, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if device != "" {
		req.Header.Set("X-Podhub-Device-Id", device)
	}
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}
