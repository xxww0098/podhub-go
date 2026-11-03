package integration

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httptrace"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"

	"github.com/xxww0098/podhub-go/internal/app"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	telemetrydomain "github.com/xxww0098/podhub-go/internal/telemetry/domain"
)

type telemetryRoleFixture struct {
	ctx       context.Context
	pool, api *pgxpool.Pool
	server    *httptest.Server
	user, org int64
	cookie    string
}

func newTelemetryRoleFixture(t *testing.T) telemetryRoleFixture {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	t.Cleanup(cancel)
	t.Setenv("PODHUB_PARITY_DSN", "")
	dsn := securityDSN(t, ctx)
	t.Setenv("PODHUB_PARITY_DSN", dsn)
	t.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "1")
	t.Setenv("CLOUD_CLIENT_LOG_COLLECT", "1")
	t.Setenv("CLOUD_COOKIE_SECURE", "0")
	pool := migratedPool(t, ctx)
	seedMatchingLease(t, ctx, pool, "telemetry", "production role telemetry")
	owner, org := insertWorkspace(t, ctx, pool, "telemetry-owner@example.invalid", "Telemetry production")
	seedCompanyMember(t, ctx, pool, org, owner, "owner", 1)
	var user int64
	if err := pool.QueryRow(ctx, `INSERT INTO account_users(public_id,email,password_hash,name,created_at,updated_at) VALUES($1,'telemetry-production@example.invalid','x','Telemetry member',clock_timestamp(),clock_timestamp()) RETURNING id`, uuid.NewString()).Scan(&user); err != nil {
		t.Fatal(err)
	}
	seedCompanyMember(t, ctx, pool, org, user, "member", 2)
	hash, err := bcrypt.GenerateFromPassword([]byte("telemetry-password"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE account_users SET password_hash=$2 WHERE id=$1`, user, string(hash)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE organizations SET store_limit_override=1 WHERE id=$1`, org); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `ALTER ROLE podhub_login_api PASSWORD 'isolated-telemetry-login'`); err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(swapUser(dsn, "podhub_login_api", "isolated-telemetry-login"))
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	query.Set("pool_max_conns", "1")
	parsed.RawQuery = query.Encode()
	t.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "")
	api, err := db.Connect(ctx, config.Config{DatabaseURL: parsed.String()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(api.Close)
	server := httptest.NewServer(app.Handler(api))
	t.Cleanup(server.Close)
	f := telemetryRoleFixture{ctx: ctx, pool: pool, api: api, server: server, user: user, org: org}
	f.cookie = f.login(t, "telemetry-production@example.invalid")
	f.assertRole(t)
	return f
}

func (f telemetryRoleFixture) login(t *testing.T, email string) string {
	t.Helper()
	status, body, headers := f.post(t, "/api/auth/login", "", "", `{"email":"`+email+`","password":"telemetry-password"}`)
	if status != http.StatusOK {
		t.Fatalf("production login: %d %s", status, body)
	}
	response := &http.Response{Header: headers}
	for _, cookie := range response.Cookies() {
		if cookie.Name == "sid" {
			return cookie.Name + "=" + cookie.Value
		}
	}
	t.Fatal("production login did not issue a session")
	return ""
}

func (f telemetryRoleFixture) post(t *testing.T, path, cookie, device, body string) (int, string, http.Header) {
	t.Helper()
	r, err := http.NewRequestWithContext(f.ctx, http.MethodPost, f.server.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Idempotency-Key", uuid.NewString())
	if cookie != "" {
		r.Header.Set("Cookie", cookie)
	}
	if device != "" {
		r.Header.Set("X-Podhub-Device-Id", device)
	}
	response, err := f.server.Client().Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, string(raw), response.Header
}

func (f telemetryRoleFixture) assertRole(t *testing.T) {
	t.Helper()
	var current, session, org, staff string
	var super, inherit, bypass bool
	if err := f.api.QueryRow(f.ctx, `SELECT current_user,session_user,rolsuper,rolinherit,rolbypassrls,COALESCE(current_setting('app.current_org_id',true),''),COALESCE(current_setting('app.staff_access',true),'') FROM pg_roles WHERE rolname=current_user`).Scan(&current, &session, &super, &inherit, &bypass, &org, &staff); err != nil {
		t.Fatal(err)
	}
	if current != "podhub_login_api" || session != current || super || inherit || bypass || org != "" || staff != "" {
		t.Fatalf("unsafe database role: current=%s session=%s super=%v inherit=%v bypass=%v org=%q staff=%q", current, session, super, inherit, bypass, org, staff)
	}
}

func telemetryUploadBody(t *testing.T, id string, bytes int64) string {
	t.Helper()
	payload, err := json.Marshal(map[string]any{"schemaVersion": 1, "bytes": bytes, "occurredAt": time.Now().UTC().Format(time.RFC3339), "objectKey": "fixture-key", "contentHash": "fixture-hash", "outcome": "uploaded"})
	if err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(map[string]any{"events": []any{map[string]any{"id": id, "kind": "billing.object-upload-usage.v1", "payload_json": string(payload), "schema_version": 1}}})
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

func telemetryLogBody(t *testing.T, id string) string {
	t.Helper()
	body, err := json.Marshal(map[string]any{"records": []any{map[string]any{"id": id, "ts": time.Now().UTC().Format(time.RFC3339), "level": "info", "module": "upload", "event": "upload.end", "sessionId": "11111111-2222-4333-8444-555555555555", "version": "1.0.0"}}})
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

func TestTelemetryProductionRoleHTTP(t *testing.T) {
	f := newTelemetryRoleFixture(t)
	t.Run("inbox replay persists once", func(t *testing.T) {
		body := telemetryUploadBody(t, "upload-once", 10)
		for i := 0; i < 2; i++ {
			status, raw, _ := f.post(t, "/api/events/inbox", f.cookie, "telemetry-production", body)
			if status != http.StatusOK || !strings.Contains(raw, `"accepted":["upload-once"]`) {
				t.Fatalf("inbox: %d %s", status, raw)
			}
		}
		var inbox, usage int
		var total int64
		if err := f.pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM event_inbox_events WHERE device_uid='telemetry-production' AND id='upload-once'),(SELECT count(*) FROM billable_usage_events WHERE org_id=$1 AND event_id='telemetry-production:upload-once'),(SELECT COALESCE(sum(total),0) FROM billable_usage_rollups WHERE org_id=$1 AND metric='traffic.user_to_s3_bytes')`, f.org).Scan(&inbox, &usage, &total); err != nil || inbox != 1 || usage != 1 || total != 10 {
			t.Fatalf("inbox=%d usage=%d total=%d err=%v", inbox, usage, total, err)
		}
	})
	t.Run("cross workspace inbox identity conflict", func(t *testing.T) {
		otherUser, otherOrg := insertWorkspace(t, f.ctx, f.pool, "telemetry-other-actor@example.invalid", "Other actor")
		seedCompanyMember(t, f.ctx, f.pool, otherOrg, otherUser, "owner", 1)
		if _, err := f.pool.Exec(f.ctx, `UPDATE account_users SET password_hash=(SELECT password_hash FROM account_users WHERE id=$2) WHERE id=$1`, otherUser, f.user); err != nil {
			t.Fatal(err)
		}
		if _, err := f.pool.Exec(f.ctx, `UPDATE organizations SET store_limit_override=1 WHERE id=$1`, otherOrg); err != nil {
			t.Fatal(err)
		}
		cookie := f.login(t, "telemetry-other-actor@example.invalid")
		status, raw, _ := f.post(t, "/api/events/inbox", cookie, "telemetry-production", telemetryUploadBody(t, "upload-once", 10))
		if status != http.StatusOK || !strings.Contains(raw, "同 id 异身份冲突") || !strings.Contains(raw, `"accepted":[]`) {
			t.Fatalf("cross workspace replay: %d %s", status, raw)
		}
		var org, user int64
		if err := f.pool.QueryRow(f.ctx, `SELECT org_id,user_id FROM event_inbox_events WHERE device_uid='telemetry-production' AND id='upload-once'`).Scan(&org, &user); err != nil || org != f.org || user != f.user {
			t.Fatalf("cross workspace took event: org=%d user=%d err=%v", org, user, err)
		}
		var count int
		if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FROM billable_usage_events WHERE org_id=$1`, otherOrg).Scan(&count); err != nil || count != 0 {
			t.Fatalf("rejected other workspace was billed: rows=%d err=%v", count, err)
		}
	})
	t.Run("client log replay and tenant isolation", func(t *testing.T) {
		id := uuid.NewString()
		body := telemetryLogBody(t, id)
		for i := 0; i < 2; i++ {
			status, raw, _ := f.post(t, "/api/listing/client-logs", f.cookie, "", body)
			if status != http.StatusOK || !strings.Contains(raw, `"accepted":1`) {
				t.Fatalf("client logs: %d %s", status, raw)
			}
		}
		var count int
		if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FROM client_listing_logs WHERE org_id=$1 AND user_id=$2 AND client_id=$3`, f.org, f.user, id).Scan(&count); err != nil || count != 1 {
			t.Fatalf("client log rows=%d err=%v", count, err)
		}
		_, otherOrg := insertWorkspace(t, f.ctx, f.pool, "telemetry-other@example.invalid", "Other")
		if err := db.InTx(f.ctx, f.api, db.App(otherOrg), func(tx pgx.Tx) error {
			return tx.QueryRow(f.ctx, `SELECT count(*) FROM client_listing_logs WHERE client_id=$1`, id).Scan(&count)
		}); err != nil || count != 0 {
			t.Fatalf("cross tenant logs=%d err=%v", count, err)
		}
	})
	t.Run("quota rejection persists no event", func(t *testing.T) {
		period := time.Now().UTC().Format("2006-01")
		if _, err := f.pool.Exec(f.ctx, `INSERT INTO billable_usage_rollups(org_id,user_id,billing_period,metric,unit,verification,total) VALUES($1,$2,$3,'traffic.user_to_s3_bytes','byte','reported',$4) ON CONFLICT(org_id,user_id,billing_period,metric,unit,verification) DO UPDATE SET total=excluded.total`, f.org, f.user, period, telemetrydomain.S3BytesForStores(1)); err != nil {
			t.Fatal(err)
		}
		status, raw, _ := f.post(t, "/api/events/inbox", f.cookie, "telemetry-production", telemetryUploadBody(t, "over-quota", 1))
		if status != http.StatusOK || !strings.Contains(raw, "工作空间上行流量已用尽") {
			t.Fatalf("quota: %d %s", status, raw)
		}
		var count int
		if err := f.pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM event_inbox_events WHERE device_uid='telemetry-production' AND id='over-quota')+(SELECT count(*) FROM billable_usage_events WHERE event_id='telemetry-production:over-quota')`).Scan(&count); err != nil || count != 0 {
			t.Fatalf("quota persisted rows=%d err=%v", count, err)
		}
	})
	t.Run("disabled account cannot write", func(t *testing.T) {
		if _, err := f.pool.Exec(f.ctx, `UPDATE account_users SET disabled_at=clock_timestamp() WHERE id=$1`, f.user); err != nil {
			t.Fatal(err)
		}
		for _, path := range []string{"/api/events/inbox", "/api/listing/client-logs"} {
			status, raw, _ := f.post(t, path, f.cookie, "telemetry-production", `{}`)
			if status != http.StatusUnauthorized {
				t.Errorf("disabled %s: %d %s", path, status, raw)
			}
		}
	})
	f.assertRole(t)
}

func TestTelemetryRechecksAuthorityAfterReadingBody(t *testing.T) {
	f := newTelemetryRoleFixture(t)
	for _, route := range []string{"inbox", "client logs"} {
		for _, change := range []string{"account disabled", "membership disabled", "quota suspended", "workspace dissolved", "unchanged"} {
			t.Run(route+"/"+change, func(t *testing.T) {
				defer func() {
					_, _ = f.pool.Exec(f.ctx, `UPDATE account_users SET disabled_at=NULL WHERE id=$1`, f.user)
					_, _ = f.pool.Exec(f.ctx, `UPDATE organization_members SET manual_disabled=false,quota_suspended=false WHERE org_id=$1 AND user_id=$2`, f.org, f.user)
					_, _ = f.pool.Exec(f.ctx, `UPDATE organizations SET dissolved_at=NULL WHERE id=$1`, f.org)
				}()
				var auditsBefore, usageBefore int64
				if err := f.pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM audit_logs WHERE org_id=$1 AND module='telemetry'),(SELECT COALESCE(sum(total),0) FROM billable_usage_rollups WHERE org_id=$1)`, f.org).Scan(&auditsBefore, &usageBefore); err != nil {
					t.Fatal(err)
				}
				id := uuid.NewString()
				path := "/api/events/inbox"
				body := telemetryUploadBody(t, id, 1)
				if route == "client logs" {
					path = "/api/listing/client-logs"
					body = telemetryLogBody(t, id)
				}
				reader, writer := io.Pipe()
				defer reader.Close()
				defer writer.Close()
				request, err := http.NewRequestWithContext(f.ctx, http.MethodPost, f.server.URL+path, reader)
				if err != nil {
					t.Fatal(err)
				}
				request.Header.Set("Content-Type", "application/json")
				request.Header.Set("Cookie", f.cookie)
				request.Header.Set("X-Podhub-Device-Id", "telemetry-authority")
				request.Header.Set("Expect", "100-continue")
				// net/http sends 100 Continue on the first body read, after the route authenticated.
				reading := make(chan struct{}, 1)
				request = request.WithContext(httptrace.WithClientTrace(request.Context(), &httptrace.ClientTrace{Got100Continue: func() { reading <- struct{}{} }}))
				type response struct {
					status int
					body   string
					err    error
				}
				done := make(chan response, 1)
				go func() {
					res, err := f.server.Client().Do(request)
					if err != nil {
						done <- response{err: err}
						return
					}
					defer res.Body.Close()
					raw, err := io.ReadAll(res.Body)
					done <- response{status: res.StatusCode, body: string(raw), err: err}
				}()
				select {
				case <-reading:
				case result := <-done:
					t.Fatalf("request finished before authenticated body read: %+v", result)
				case <-time.After(5 * time.Second):
					t.Fatal("request did not reach body read after authentication")
				}
				switch change {
				case "account disabled":
					_, err = f.pool.Exec(f.ctx, `UPDATE account_users SET disabled_at=clock_timestamp() WHERE id=$1`, f.user)
				case "membership disabled":
					_, err = f.pool.Exec(f.ctx, `UPDATE organization_members SET manual_disabled=true WHERE org_id=$1 AND user_id=$2`, f.org, f.user)
				case "quota suspended":
					_, err = f.pool.Exec(f.ctx, `UPDATE organization_members SET quota_suspended=true WHERE org_id=$1 AND user_id=$2`, f.org, f.user)
				case "workspace dissolved":
					_, err = f.pool.Exec(f.ctx, `UPDATE organizations SET dissolved_at=clock_timestamp() WHERE id=$1`, f.org)
				}
				if err != nil {
					t.Fatal(err)
				}
				if _, err := io.WriteString(writer, body); err != nil {
					t.Fatal(err)
				}
				if err := writer.Close(); err != nil {
					t.Fatal(err)
				}
				var result response
				select {
				case result = <-done:
				case <-f.ctx.Done():
					t.Fatal(f.ctx.Err())
				}
				wantStatus, wantRows := http.StatusForbidden, 0
				if change == "unchanged" {
					wantStatus = http.StatusOK
					wantRows = 1
				}
				if result.err != nil || result.status != wantStatus {
					t.Errorf("stale authority: status=%d want=%d body=%s err=%v", result.status, wantStatus, result.body, result.err)
				}
				var inbox, usage, logs int
				if err := f.pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM event_inbox_events WHERE device_uid='telemetry-authority' AND id=$1),(SELECT count(*) FROM billable_usage_events WHERE event_id='telemetry-authority:'||$1),(SELECT count(*) FROM client_listing_logs WHERE user_id=$2 AND client_id=$1)`, id, f.user).Scan(&inbox, &usage, &logs); err != nil {
					t.Fatal(err)
				}
				if route == "inbox" {
					if inbox != wantRows || usage != wantRows || logs != 0 {
						t.Errorf("inbox=%d usage=%d logs=%d want=%d", inbox, usage, logs, wantRows)
					}
				} else if inbox != 0 || usage != 0 || logs != wantRows {
					t.Errorf("inbox=%d usage=%d logs=%d want=%d", inbox, usage, logs, wantRows)
				}
				var auditsAfter, usageAfter int64
				if err := f.pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM audit_logs WHERE org_id=$1 AND module='telemetry'),(SELECT COALESCE(sum(total),0) FROM billable_usage_rollups WHERE org_id=$1)`, f.org).Scan(&auditsAfter, &usageAfter); err != nil {
					t.Fatal(err)
				}
				var delta int64
				if route == "inbox" && change == "unchanged" {
					delta = 1
				}
				if auditsAfter-auditsBefore != delta || usageAfter-usageBefore != delta {
					t.Errorf("authority transaction leaked side effects: audits=%d usage=%d want=%d", auditsAfter-auditsBefore, usageAfter-usageBefore, delta)
				}
			})
		}
	}
	f.assertRole(t)
}
