package integration

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/app"
	"github.com/xxww0098/podhub-go/internal/identity"
	"github.com/xxww0098/podhub-go/internal/platform/db/sqlc"
	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/tests/parity"
)

func TestIdentityAndTenantIsolation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	t.Setenv("CLOUD_SELLER_CREDENTIAL_KEY", "parity-test-key")
	t.Setenv("CLOUD_COOKIE_SECURE", "0")
	if _, err := pool.Exec(ctx, `
		INSERT INTO account_users
		    (public_id, email, password_hash, role, name, target, supplier_id, plan, created_at, updated_at)
		VALUES ('00000000-0000-4000-8000-000000000001', 'owner@pod.example', 'x', 'super_admin', 'owner', '/workspace', '', 'free', clock_timestamp(), clock_timestamp())`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		UPDATE platform_initialization
		SET owner_account_id = (SELECT id FROM account_users WHERE email = 'owner@pod.example'),
		    initialized_at = clock_timestamp()
		WHERE singleton`); err != nil {
		t.Fatal(err)
	}

	handler := app.Handler(pool)
	const idem = "register-idem-1"
	rec := postJSON(t, handler, "/api/auth/register", `{"email":"ada@pod.example","password":"correct-horse","name":"Ada"}`, idem, "")
	hash := passwordHash(t, ctx, pool, "ada@pod.example")
	token := identity.DeriveSessionToken(hash, idem)
	if err := parity.DiffHTTP(parity.Exchange{Status: rec.Code, Body: rec.Body.Bytes()}, parity.Exchange{
		Status: http.StatusOK,
		Body:   []byte(`{"data":{"token":"` + token + `","user":{"uuid":"` + publicID(t, ctx, pool, "ada@pod.example") + `","role":"user","email":"ada@pod.example","name":"Ada"},"target":"/workspace"}}`),
	}); err != nil {
		t.Fatal(err)
	}
	cookies := rec.Header().Values("Set-Cookie")
	if len(cookies) != 2 || !strings.Contains(cookies[0], "sid="+token) || !strings.Contains(cookies[0], "HttpOnly") || strings.Contains(cookies[0], "Secure") {
		t.Fatalf("cookies %#v", cookies)
	}
	var sessions, audits, orgs, members int64
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM account_sessions WHERE token_hash = $1 AND user_id = (SELECT id FROM account_users WHERE email = 'ada@pod.example')`, sha256Hex(token)).Scan(&sessions); err != nil || sessions != 1 {
		t.Fatalf("sessions %d %v", sessions, err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs WHERE action = 'account_registered' AND writer_lease_id IS NULL AND writer_fence_token IS NULL AND message LIKE '%开通免费工作空间%'`).Scan(&audits); err != nil || audits != 1 {
		t.Fatalf("audits %d %v", audits, err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM organizations o JOIN account_users u ON u.id = o.owner_user_id WHERE u.email = 'ada@pod.example' AND o.plan = 'free'`).Scan(&orgs); err != nil || orgs != 1 {
		t.Fatalf("orgs %d %v", orgs, err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM organization_members m JOIN account_users u ON u.id = m.user_id WHERE u.email = 'ada@pod.example' AND m.role = 'owner'`).Scan(&members); err != nil || members != 1 {
		t.Fatalf("members %d %v", members, err)
	}

	adaCookie := cookies[0]
	session := get(t, handler, "/api/auth/session", adaCookie)
	if session.Code != http.StatusOK || !bytes.Contains(session.Body.Bytes(), []byte(`"email":"ada@pod.example"`)) || !bytes.Contains(session.Body.Bytes(), []byte(`"email_verified":false`)) || !bytes.Contains(session.Body.Bytes(), []byte(`"account_mode":"owner"`)) {
		t.Fatalf("session %d %s", session.Code, session.Body.Bytes())
	}
	anon := get(t, handler, "/api/auth/session", "")
	if err := parity.DiffHTTP(parity.Exchange{Status: anon.Code, Body: anon.Body.Bytes()}, parity.Exchange{
		Status: http.StatusOK,
		Body:   []byte(`{"data":{"authenticated":false,"active_workspace":null,"workspaces":[],"unusable_workspaces":[],"accounts":[]}}`),
	}); err != nil {
		t.Fatal(err)
	}

	bob := postJSON(t, handler, "/api/auth/register", `{"email":"bob@pod.example","password":"correct-horse","name":"Bob"}`, "register-idem-2", "")
	if bob.Code != http.StatusOK {
		t.Fatalf("bob %d %s", bob.Code, bob.Body.Bytes())
	}
	var adaOrg, bobOrg int64
	if err := pool.QueryRow(ctx, `SELECT active_org_id FROM account_users WHERE email = 'ada@pod.example'`).Scan(&adaOrg); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT active_org_id FROM account_users WHERE email = 'bob@pod.example'`).Scan(&bobOrg); err != nil {
		t.Fatal(err)
	}
	if adaOrg == bobOrg || adaOrg == 0 || bobOrg == 0 {
		t.Fatalf("orgs %d %d", adaOrg, bobOrg)
	}
	denied := postJSON(t, handler, "/api/workspaces/switch", `{"id":`+strconv.FormatInt(bobOrg, 10)+`}`, "", adaCookie)
	if err := parity.DiffHTTP(parity.Exchange{Status: denied.Code, Body: denied.Body.Bytes()}, parity.Exchange{
		Status: http.StatusForbidden,
		Body:   []byte(`{"error":"无权切换到该 Workspace","code":"FORBIDDEN"}`),
	}); err != nil {
		t.Fatal(err)
	}
	var still int64
	if err := pool.QueryRow(ctx, `SELECT active_org_id FROM account_users WHERE email = 'ada@pod.example'`).Scan(&still); err != nil || still != adaOrg {
		t.Fatalf("active org changed %d -> %d", adaOrg, still)
	}
	roster := get(t, handler, "/api/workspaces/members", adaCookie)
	if roster.Code != http.StatusOK || bytes.Contains(roster.Body.Bytes(), []byte("bob@pod.example")) || !bytes.Contains(roster.Body.Bytes(), []byte("ada@pod.example")) {
		t.Fatalf("roster %d %s", roster.Code, roster.Body.Bytes())
	}
	if !bytes.Contains(roster.Body.Bytes(), []byte(`"inviteRoles":["manager","member"]`)) {
		t.Fatalf("owner invite roles %s", roster.Body.Bytes())
	}

	usage := get(t, handler, "/api/billing/usage-stats?rollup=1&from=2026-08-01&to=2026-08-31", adaCookie)
	var ledger struct {
		Data struct {
			From, To             string
			Organization, Member []json.RawMessage
			GeneratedAtMs        int64 `json:"generated_at_ms"`
		} `json:"data"`
	}
	if err := json.Unmarshal(usage.Body.Bytes(), &ledger); err != nil || usage.Code != http.StatusOK || ledger.Data.From != "2026-08-01" || ledger.Data.To != "2026-08-31" || ledger.Data.GeneratedAtMs <= 0 || len(ledger.Data.Organization) != 0 || len(ledger.Data.Member) != 0 {
		t.Fatalf("usage %d %s: %v", usage.Code, usage.Body.Bytes(), err)
	}
	adminTags := get(t, handler, "/api/admin/banned-tags", adaCookie)
	if err := parity.DiffHTTP(parity.Exchange{Status: adminTags.Code, Body: adminTags.Body.Bytes()}, parity.Exchange{
		Status: http.StatusForbidden,
		Body:   []byte(`{"error":"需要超级管理员权限","code":"FORBIDDEN"}`),
	}); err != nil {
		t.Fatal(err)
	}
	anonTags := get(t, handler, "/api/admin/banned-tags", "")
	if err := parity.DiffHTTP(parity.Exchange{Status: anonTags.Code, Body: anonTags.Body.Bytes()}, parity.Exchange{
		Status: http.StatusUnauthorized,
		Body:   []byte(`{"error":"未登录","code":"AUTH_INVALID"}`),
	}); err != nil {
		t.Fatal(err)
	}
	var bobID int64
	if err := pool.QueryRow(ctx, `SELECT id FROM account_users WHERE email = 'bob@pod.example'`).Scan(&bobID); err != nil {
		t.Fatal(err)
	}
	insertJob(t, ctx, pool, "55555555-5555-4555-8555-555555555555", bobOrg, bobID, "66666666-6666-4666-8666-666666666666", "bob-prep", "2026-08-21 17:30:00+00", `{"executor":"worker"}`)
	runs := get(t, handler, "/api/listing/jobs", adaCookie)
	if err := parity.DiffHTTP(parity.Exchange{Status: runs.Code, Body: runs.Body.Bytes()}, parity.Exchange{
		Status: http.StatusOK,
		Body:   []byte(`{"data":{"items":[]}}`),
	}); err != nil {
		t.Fatal(err)
	}
	hidden := get(t, handler, "/api/listing/jobs/55555555-5555-4555-8555-555555555555", adaCookie)
	if err := parity.DiffHTTP(parity.Exchange{Status: hidden.Code, Body: hidden.Body.Bytes()}, parity.Exchange{
		Status: http.StatusNotFound,
		Body:   []byte(`{"error":"准备作业不存在","code":"not_found"}`),
	}); err != nil {
		t.Fatal(err)
	}

	crossOrigin := httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
	crossOrigin.Header.Set("Cookie", adaCookie)
	crossOrigin.Header.Set("Sec-Fetch-Site", "cross-site")
	cross := httptest.NewRecorder()
	handler.ServeHTTP(cross, crossOrigin)
	if err := parity.DiffHTTP(parity.Exchange{Status: cross.Code, Body: cross.Body.Bytes()}, parity.Exchange{
		Status: http.StatusForbidden,
		Body:   []byte(`{"code":"csrf_rejected","message":"跨站请求已被拒绝"}`),
	}); err != nil {
		t.Fatal(err)
	}

	isolateTenants(t, ctx, pool, adaOrg, bobOrg)

	for i := 0; i < 6; i++ {
		bad := postJSON(t, handler, "/api/auth/login", `{"email":"missing@pod.example","password":"wrong-password"}`, "", "")
		if bad.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d status %d %s", i, bad.Code, bad.Body.Bytes())
		}
	}
	limited := postJSON(t, handler, "/api/auth/login", `{"email":"missing@pod.example","password":"wrong-password"}`, "", "")
	if err := parity.DiffHTTP(parity.Exchange{Status: limited.Code, Body: limited.Body.Bytes()}, parity.Exchange{
		Status: http.StatusTooManyRequests,
		Body:   []byte(`{"error":"登录失败次数过多，请稍后再试","code":"RATE_LIMITED"}`),
	}); err != nil {
		t.Fatal(err)
	}
	if limited.Header().Get("Retry-After") != "" {
		t.Fatal("throttle must not set Retry-After")
	}
}

func isolateTenants(t *testing.T, ctx context.Context, pool *pgxpool.Pool, orgA, orgB int64) {
	t.Helper()
	const cardA = "11111111-1111-4111-8111-111111111111"
	const cardB = "22222222-2222-4222-8222-222222222222"
	if _, err := pool.Exec(ctx, `INSERT INTO listing_card_cursors (org_id, card_id) VALUES ($1, $2), ($3, $4)`, orgA, cardA, orgB, cardB); err != nil {
		t.Fatal(err)
	}
	txA, err := tenant.BeginApp(ctx, pool.Begin, orgA)
	if err != nil {
		t.Fatal(err)
	}
	n, err := sqlc.New(txA).CountCardCursors(ctx)
	if err != nil || n != 1 {
		t.Fatalf("org A sees %d %v", n, err)
	}
	err = sqlc.New(txA).InsertCardCursor(ctx, sqlc.InsertCardCursorParams{OrgID: orgB, Column2: cardUUID(t, "33333333-3333-4333-8333-333333333333")})
	if err == nil {
		t.Fatal("org A inserted org B's card")
	}
	_ = txA.Rollback(ctx)

	txW, err := tenant.BeginWorker(ctx, pool.Begin)
	if err != nil {
		t.Fatal(err)
	}
	n, err = sqlc.New(txW).CountCardCursors(ctx)
	if err != nil || n != 2 {
		t.Fatalf("worker sees %d %v", n, err)
	}
	_ = txW.Rollback(ctx)

	bare, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := bare.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
		t.Fatal(err)
	}
	n, err = sqlc.New(bare).CountCardCursors(ctx)
	if err != nil || n != 0 {
		t.Fatalf("missing GUC sees %d %v", n, err)
	}
	err = sqlc.New(bare).InsertCardCursor(ctx, sqlc.InsertCardCursorParams{OrgID: orgA, Column2: cardUUID(t, "44444444-4444-4444-8444-444444444444")})
	if err == nil {
		t.Fatal("missing GUC inserted a card")
	}
	_ = bare.Rollback(ctx)
}

func postJSON(t *testing.T, handler http.Handler, path, body, idempotency, cookie string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if idempotency != "" {
		req.Header.Set("Idempotency-Key", idempotency)
	}
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func get(t *testing.T, handler http.Handler, path, cookie string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func passwordHash(t *testing.T, ctx context.Context, pool *pgxpool.Pool, email string) string {
	t.Helper()
	var hash string
	if err := pool.QueryRow(ctx, `SELECT c.password_hash FROM account_credentials c JOIN account_users u ON u.id = c.user_id WHERE u.email = $1`, email).Scan(&hash); err != nil {
		t.Fatal(err)
	}
	return hash
}

func publicID(t *testing.T, ctx context.Context, pool *pgxpool.Pool, email string) string {
	t.Helper()
	var id string
	if err := pool.QueryRow(ctx, `SELECT public_id FROM account_users WHERE email = $1`, email).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func sha256Hex(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func cardUUID(t *testing.T, raw string) pgtype.UUID {
	t.Helper()
	var id pgtype.UUID
	if err := id.Scan(raw); err != nil {
		t.Fatal(err)
	}
	return id
}
