package integration

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	httpapi "github.com/xxww0098/podhub-go/internal/app/api"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	platform "github.com/xxww0098/podhub-go/internal/listing/rules"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/tests/parity"
	"github.com/xxww0098/podhub-go/tests/testkit"
)

func TestReadOnlySurface(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	platform.InvalidateBannedTags()

	owner, orgA := insertWorkspace(t, ctx, pool, "owner-a@example.com", "Owner A")
	other, orgB := insertWorkspace(t, ctx, pool, "owner-b@example.com", "Owner B")
	const (
		jobA = "11111111-1111-4111-8111-111111111111"
		jobB = "22222222-2222-4222-8222-222222222222"
		jobC = "33333333-3333-4333-8333-333333333333"
		aggA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
		aggB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
		aggC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
		card = "44444444-4444-4444-8444-444444444444"
	)
	insertJob(t, ctx, pool, jobA, orgA, owner, aggA, "prep-a", "2026-08-21 17:30:00+00", `{"b":1,"a":"x&y"}`)
	insertJob(t, ctx, pool, jobB, orgA, owner, aggB, "prep-b", "2026-08-21 17:29:00+00", `{"executor":"worker"}`)
	insertJob(t, ctx, pool, jobC, orgB, other, aggC, "prep-c", "2026-08-21 17:31:00+00", `{"executor":"worker"}`)
	insertRow(t, ctx, pool, aggA, orgA, card)
	insertRollup(t, ctx, pool, orgA, owner, "2026-08", "ai.input_tokens", 10)
	insertRollup(t, ctx, pool, orgA, other, "2026-08", "ai.input_tokens", 5)
	insertRollup(t, ctx, pool, orgA, owner, "2026-08", "ai.output_tokens", 3)
	insertRollup(t, ctx, pool, orgB, other, "2026-08", "ai.input_tokens", 999)

	before := tableCounts(t, ctx, pool)
	clock := func() time.Time { return time.UnixMilli(1787333400000).UTC() }
	ownerH := handlerFor(pool, access.Principal{UserID: owner, OrgID: orgA, WorkspaceRole: "owner", PlatformRole: "user"}, clock)
	memberH := handlerFor(pool, access.Principal{UserID: owner, OrgID: orgA, WorkspaceRole: "member", PlatformRole: "user"}, clock)
	viewerH := handlerFor(pool, access.Principal{UserID: owner, OrgID: orgA, WorkspaceRole: "viewer", PlatformRole: "user"}, clock)
	staffH := handlerFor(pool, access.Principal{UserID: owner, OrgID: orgA, WorkspaceRole: "owner", PlatformRole: "admin"}, clock)
	superH := handlerFor(pool, access.Principal{UserID: owner, OrgID: orgA, WorkspaceRole: "owner", PlatformRole: "super_admin"}, clock)

	expect(t, ownerH, http.MethodGet, "/api/me/catalog/banned-tags", http.StatusOK,
		`{"data":{"rules":[{"term":"сигарета","matchMode":"stem"},{"term":"табак","matchMode":"stem"},{"term":"вейп","matchMode":"stem"},{"term":"никотин","matchMode":"stem"},{"term":"электронная_сигарета","matchMode":"stem"},{"term":"испаритель","matchMode":"stem"}]}}`)

	adminBody := adminBannedGolden(t, ctx, pool)
	expect(t, superH, http.MethodGet, "/api/admin/banned-tags", http.StatusOK, adminBody)
	expect(t, staffH, http.MethodGet, "/api/admin/banned-tags", http.StatusForbidden, `{"error":"需要超级管理员权限","code":"FORBIDDEN"}`)

	expect(t, ownerH, http.MethodGet, "/api/billing/usage-stats?rollup=1&from=2026-08-01&to=2026-08-31", http.StatusOK,
		`{"data":{"days":31,"from":"2026-08-01","to":"2026-08-31","total_tokens":0,"input_tokens":0,"output_tokens":0,"cached_input_tokens":0,"message_count":0,"cache_hit_rate_bps":0,"total_microfen":0,"charged_microfen":0,"absorbed_microfen":0,"page":1,"page_size":25,"total_pages":1,"requests":[],"organization":[{"metric":"ai.input_tokens","unit":"token","verification":"reported","total":15},{"metric":"ai.output_tokens","unit":"token","verification":"reported","total":3}],"member":[{"metric":"ai.input_tokens","unit":"token","verification":"reported","total":10},{"metric":"ai.output_tokens","unit":"token","verification":"reported","total":3}],"generated_at_ms":1787333400000}}`)
	expect(t, memberH, http.MethodGet, "/api/billing/usage-stats?rollup=1", http.StatusForbidden, `{"error":"需要主管权限","code":"FORBIDDEN"}`)
	expect(t, ownerH, http.MethodGet, "/api/billing/usage-stats?rollup=1&from=2026-09-01&to=2026-09-30", http.StatusOK,
		`{"data":{"days":30,"from":"2026-09-01","to":"2026-09-30","total_tokens":0,"input_tokens":0,"output_tokens":0,"cached_input_tokens":0,"message_count":0,"cache_hit_rate_bps":0,"total_microfen":0,"charged_microfen":0,"absorbed_microfen":0,"page":1,"page_size":25,"total_pages":1,"requests":[],"generated_at_ms":1787333400000}}`)
	expect(t, ownerH, http.MethodGet, "/api/billing/usage-stats?rollup=1&from=2026-99-01&to=2026-99-30", http.StatusBadRequest, `{"error":"from 必须是 YYYY-MM-DD","code":"VALIDATION"}`)

	expect(t, memberH, http.MethodGet, "/api/billing/usage-stats", http.StatusOK,
		`{"data":{"days":30,"from":"2026-07-23","to":"2026-08-21","total_tokens":0,"input_tokens":0,"output_tokens":0,"cached_input_tokens":0,"message_count":0,"cache_hit_rate_bps":0,"total_microfen":0,"charged_microfen":0,"absorbed_microfen":0,"page":1,"page_size":25,"total_pages":1,"requests":[],"generated_at_ms":1787333400000}}`)
	expect(t, memberH, http.MethodGet, "/api/billing/usage-stats?summary=1&page=5", http.StatusOK,
		`{"data":{"days":30,"from":"2026-07-23","to":"2026-08-21","total_tokens":0,"input_tokens":0,"output_tokens":0,"cached_input_tokens":0,"message_count":0,"cache_hit_rate_bps":0,"total_microfen":0,"charged_microfen":0,"absorbed_microfen":0,"page":1,"page_size":0,"total_pages":1,"requests":[],"generated_at_ms":1787333400000}}`)
	expect(t, memberH, http.MethodGet, "/api/billing/usage-stats?page=5", http.StatusOK,
		`{"data":{"days":30,"from":"2026-07-23","to":"2026-08-21","total_tokens":0,"input_tokens":0,"output_tokens":0,"cached_input_tokens":0,"message_count":0,"cache_hit_rate_bps":0,"total_microfen":0,"charged_microfen":0,"absorbed_microfen":0,"page":1,"page_size":25,"total_pages":1,"requests":[],"generated_at_ms":1787333400000}}`)
	expect(t, memberH, http.MethodGet, "/api/billing/usage-stats?days=90", http.StatusBadRequest, `{"error":"days 必须是 7 或 30","code":"VALIDATION"}`)
	expect(t, memberH, http.MethodGet, "/api/billing/usage-stats?from=2026-08-01", http.StatusBadRequest, `{"error":"from 与 to 必须同时提供","code":"VALIDATION"}`)

	expect(t, ownerH, http.MethodGet, "/api/listing/jobs/"+jobA, http.StatusOK,
		`{"data":{"id":"11111111-1111-4111-8111-111111111111","kind":"ai.recognize","aggregateType":"listing_row","aggregateId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","inputRevision":3,"state":"succeeded","attempt":1,"idempotencyKey":"prep-a","payload":{"a":"x&y","b":1},"updatedAtMs":1787333400000}}`)
	expect(t, ownerH, http.MethodGet, "/api/listing/jobs/"+jobC, http.StatusNotFound, `{"error":"准备作业不存在","code":"not_found"}`)
	expect(t, ownerH, http.MethodGet, "/api/listing/jobs/not-a-uuid", http.StatusBadRequest, `{"error":"作业编号无效","code":"validation"}`)
	expect(t, viewerH, http.MethodGet, "/api/listing/jobs/"+jobA, http.StatusForbidden, `{"error":"当前角色无权执行此操作","code":"forbidden"}`)

	expect(t, memberH, http.MethodGet, "/api/listing/jobs?limit=1", http.StatusOK,
		`{"data":{"items":[{"id":"11111111-1111-4111-8111-111111111111","kind":"ai.recognize","aggregateType":"listing_row","aggregateId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","inputRevision":3,"state":"succeeded","attempt":1,"idempotencyKey":"prep-a","payload":{"a":"x&y","b":1},"updatedAtMs":1787333400000}],"nextCursor":"1787333400000000:11111111-1111-4111-8111-111111111111"}}`)
	expect(t, memberH, http.MethodGet, "/api/listing/jobs?limit=1&cursor=1787333400000000:11111111-1111-4111-8111-111111111111", http.StatusOK,
		`{"data":{"items":[{"id":"22222222-2222-4222-8222-222222222222","kind":"ai.recognize","aggregateType":"listing_row","aggregateId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","inputRevision":3,"state":"succeeded","attempt":1,"idempotencyKey":"prep-b","payload":{"executor":"worker"},"updatedAtMs":1787333340000}]}}`)
	expect(t, memberH, http.MethodGet, "/api/listing/jobs?cardId="+card, http.StatusOK,
		`{"data":{"items":[{"id":"11111111-1111-4111-8111-111111111111","kind":"ai.recognize","aggregateType":"listing_row","aggregateId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","inputRevision":3,"state":"succeeded","attempt":1,"idempotencyKey":"prep-a","payload":{"a":"x&y","b":1},"updatedAtMs":1787333400000}]}}`)
	expect(t, memberH, http.MethodGet, "/api/listing/jobs?cardId=nope", http.StatusBadRequest, `{"error":"cardId 无效","code":"validation"}`)
	expect(t, memberH, http.MethodGet, "/api/listing/jobs?limit=abc", http.StatusBadRequest, `{"error":"limit 无效","code":"validation"}`)

	if err := parity.DiffCounts(before, tableCounts(t, ctx, pool)); err != nil {
		t.Fatal(err)
	}
}

func handlerFor(pool *pgxpool.Pool, p access.Principal, now func() time.Time) http.Handler {
	router := chi.NewRouter()
	srv := &httpapi.Server{
		Pool:   pool,
		Access: access.FixedResolver{Principal: &p},
		Now:    now,
	}
	httpapi.HandlerFromMux(srv, router)
	httpapi.MountDomains(router, srv)
	return specChecked(router)
}

func expect(t *testing.T, h http.Handler, method, path string, status int, body string) {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(method, path, nil))
	if err := parity.DiffHTTP(parity.Exchange{Status: rec.Code, Body: rec.Body.Bytes()}, parity.Exchange{
		Status: status, Body: []byte(body),
	}); err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
}

func adminBannedGolden(t *testing.T, ctx context.Context, pool *pgxpool.Pool) string {
	t.Helper()
	rows, err := pool.Query(ctx, `SELECT id, term, match_mode, note, created_by, created_at::text, enabled FROM public.banned_tags ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := `{"data":{"tags":[`
	first := true
	for rows.Next() {
		var id int64
		var term, mode, note, by, at string
		var enabled bool
		if err := rows.Scan(&id, &term, &mode, &note, &by, &at, &enabled); err != nil {
			t.Fatal(err)
		}
		if !first {
			out += ","
		}
		first = false
		out += fmt.Sprintf(`{"id":%d,"term":%s,"matchMode":%s,"note":%s,"createdBy":%s,"createdAt":%s,"enabled":%s}`,
			id, jsonString(t, term), jsonString(t, mode), jsonString(t, note), jsonString(t, by), jsonString(t, at), boolJSON(enabled))
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out + `]}}`
}

func jsonString(t *testing.T, s string) string {
	t.Helper()
	raw, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func boolJSON(v bool) string {
	if v {
		return "true"
	}
	return "false"
}

func insertWorkspace(t *testing.T, ctx context.Context, pool *pgxpool.Pool, email, name string) (userID, orgID int64) {
	t.Helper()
	err := pool.QueryRow(ctx, `
		INSERT INTO public.account_users (public_id, email, password_hash, name, created_at, updated_at)
		VALUES ($1, $2, 'x', $3, timestamptz '2026-08-21 17:30:00+00', timestamptz '2026-08-21 17:30:00+00')
		RETURNING id`, email, email, name).Scan(&userID)
	if err != nil {
		t.Fatal(err)
	}
	err = pool.QueryRow(ctx, `
		INSERT INTO public.organizations (owner_user_id, name, created_at, updated_at)
		VALUES ($1, $2, timestamptz '2026-08-21 17:30:00+00', timestamptz '2026-08-21 17:30:00+00')
		RETURNING id`, userID, name).Scan(&orgID)
	if err != nil {
		t.Fatal(err)
	}
	return userID, orgID
}

func insertJob(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id string, orgID, userID int64, aggregate, key, updated, payload string) {
	t.Helper()
	_, err := pool.Exec(ctx, `
		INSERT INTO public.jobs (
			id, org_id, kind, aggregate_type, aggregate_id, input_revision, idempotency_key,
			state, attempt, lane, submitter_user_id, payload, updated_at
		) VALUES (
			$1::uuid, $2, 'ai.recognize', 'listing_row', $3::uuid, 3, $4,
			'succeeded', 1, 'ai.recognize', $5, $6::jsonb, $7::timestamptz
		)`, id, orgID, aggregate, key, userID, payload, updated)
	if err != nil {
		t.Fatal(err)
	}
}

func insertRow(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id string, orgID int64, card string) {
	t.Helper()
	_, err := pool.Exec(ctx, `
		INSERT INTO public.listing_rows (id, org_id, card_id)
		VALUES ($1::uuid, $2, $3::uuid)`, id, orgID, card)
	if err != nil {
		t.Fatal(err)
	}
}

func insertRollup(t *testing.T, ctx context.Context, pool *pgxpool.Pool, orgID, userID int64, period, metric string, total int64) {
	t.Helper()
	_, err := pool.Exec(ctx, `
		INSERT INTO public.billable_usage_rollups (org_id, user_id, billing_period, metric, unit, verification, total)
		VALUES ($1, $2, $3, $4, 'token', 'reported', $5)`, orgID, userID, period, metric, total)
	if err != nil {
		t.Fatal(err)
	}
}

func migratedPool(t *testing.T, ctx context.Context) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("PODHUB_PARITY_DSN")
	var drop func() error
	if dsn != "" {
		if err := (config.Config{DatabaseURL: dsn}).CheckDatabase(); err != nil {
			t.Fatal(err)
		}
	} else {
		if !testkit.DockerAvailable() {
			t.Skip("docker daemon is not available")
		}
		var err error
		dsn, drop, err = testkit.CloneMigrated(ctx)
		if err != nil {
			t.Fatal(err)
		}
		// Registered first so it runs after the pool closes.
		t.Cleanup(func() {
			if err := drop(); err != nil {
				t.Errorf("drop cloned database: %v", err)
			}
		})
	}
	cfg := config.Config{DatabaseURL: dsn}
	if err := cfg.CheckDatabase(); err != nil {
		t.Fatal(err)
	}
	// Tests dial the postgres role. Production refuses that login.
	_ = os.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "1")
	pool, err := db.Connect(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if drop != nil {
		// The template was migrated by db.Migrate, allow-missing included.
		// A file copy of that database is the same catalog. Migrating again
		// would only re-read goose_db_version.
		return pool
	}
	if err := db.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	return pool
}
