package integration

import (
	"bytes"
	"compress/gzip"
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	listing "github.com/xxww0098/podhub-go/internal/listing/core/contract"
)

func TestListingIntentsCatalog(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	engine, err := listing.OpenEmbedded(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = engine.Close(context.Background()) })

	owner, orgA := insertWorkspace(t, ctx, pool, "intents-a@example.com", "Intents A")
	other, orgB := insertWorkspace(t, ctx, pool, "intents-b@example.com", "Intents B")
	memberA := insertMember(t, ctx, pool, orgA, owner, "owner", 1)
	insertMember(t, ctx, pool, orgB, other, "owner", 1)
	const (
		storeA = "11111111-1111-4111-8111-111111111111"
		storeB = "22222222-2222-4222-8222-222222222222"
		rowA   = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
		cardA  = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
		queued = "d1111111-1111-4111-8111-111111111111"
		held   = "d2222222-2222-4222-8222-222222222222"
		otherI = "d3333333-3333-4333-8333-333333333333"
		jobA   = "e1111111-1111-4111-8111-111111111111"
		jobB   = "e2222222-2222-4222-8222-222222222222"
	)
	insertNamedStore(t, ctx, pool, orgA, storeA, memberA)
	insertNamedStore(t, ctx, pool, orgB, storeB, 0)
	insertCard(t, ctx, pool, cardA, orgA, "卡", "2026-08-21 17:30:00+00", `{}`)
	insertListingRow(t, ctx, pool, rowA, orgA, cardA)
	if _, err := pool.Exec(ctx, `UPDATE listing_rows SET submission_state = 'queued', revision = 4 WHERE id = $1::uuid`, rowA); err != nil {
		t.Fatal(err)
	}
	// guard_submission_offer rejects queued/submitting rows whose offer_id is
	// null or already fenced by another unresolved effect on the same store.
	insertIntent(t, ctx, pool, queued, orgA, storeA, rowA, "queued", "op-q", nil, strPtr("offer-q"))
	insertIntent(t, ctx, pool, held, orgA, storeA, rowA, "unknown", "op-u", strPtr("OZON_RECONCILE_STILL_UNKNOWN"), strPtr("offer-1"))
	insertIntent(t, ctx, pool, otherI, orgB, storeB, rowA, "queued", "op-b", nil, strPtr("offer-b"))
	insertDeadJob(t, ctx, pool, jobA, orgA, owner, "store.product_sync", "product_sync_failed", `{}`)
	insertDeadJob(t, ctx, pool, jobB, orgB, other, "listing.submit", "listing_submit_failed", `{}`)

	clock := func() time.Time { return time.UnixMilli(1_787_333_400_000).UTC() }
	ownerH := surfaceHandler(pool, engine, access.Principal{UserID: owner, OrgID: orgA, WorkspaceRole: "owner", PlatformRole: "super_admin"}, clock)
	otherH := surfaceHandler(pool, engine, access.Principal{UserID: other, OrgID: orgB, WorkspaceRole: "owner", PlatformRole: "user"}, clock)
	reviewerH := surfaceHandler(pool, engine, access.Principal{UserID: owner, OrgID: orgA, WorkspaceRole: "reviewer", PlatformRole: "user"}, clock)

	list := callJSON(ownerH, http.MethodGet, "/api/listing/intents?limit=10", "")
	if list.Code != http.StatusOK || !strings.Contains(list.Body.String(), queued) || strings.Contains(list.Body.String(), otherI) {
		t.Fatalf("list %d %s", list.Code, list.Body.String())
	}
	if !strings.Contains(list.Body.String(), `"hasLiveReconcileClaim":false`) || !strings.Contains(list.Body.String(), `"submissionIssues":[]`) {
		t.Fatalf("facts %s", list.Body.String())
	}
	hidden := callJSON(ownerH, http.MethodGet, "/api/listing/intents/"+otherI, "")
	if hidden.Code != http.StatusNotFound || !strings.Contains(hidden.Body.String(), "提交意图不存在") {
		t.Fatalf("cross get %d %s", hidden.Code, hidden.Body.String())
	}
	bad := callJSON(ownerH, http.MethodGet, "/api/listing/intents/not-a-uuid", "")
	if bad.Code != http.StatusNotFound {
		t.Fatalf("bad id %d %s", bad.Code, bad.Body.String())
	}

	cancelled := callJSON(ownerH, http.MethodPost, "/api/listing/intents/"+queued+"/cancel", "")
	if cancelled.Code != http.StatusOK || !strings.Contains(cancelled.Body.String(), `"state":"cancelled"`) {
		t.Fatalf("cancel %d %s", cancelled.Code, cancelled.Body.String())
	}
	if strings.Contains(cancelled.Body.String(), "hasLiveReconcileClaim") {
		t.Fatalf("cancel must omit release facts %s", cancelled.Body.String())
	}
	var rowState string
	if err := pool.QueryRow(ctx, `SELECT submission_state FROM listing_rows WHERE id = $1::uuid`, rowA).Scan(&rowState); err != nil || rowState != "cancelled" {
		t.Fatalf("row state %s %v", rowState, err)
	}
	again := callJSON(ownerH, http.MethodPost, "/api/listing/intents/"+queued+"/cancel", "")
	if again.Code != http.StatusOK || !strings.Contains(again.Body.String(), `"state":"cancelled"`) {
		t.Fatalf("repeat cancel %d %s", again.Code, again.Body.String())
	}

	recover := callJSON(reviewerH, http.MethodPost, "/api/listing/intents/"+held+"/recover", "")
	if recover.Code != http.StatusForbidden {
		t.Fatalf("reviewer recover %d %s", recover.Code, recover.Body.String())
	}
	gone := callJSON(ownerH, http.MethodPost, "/api/listing/intents/ignored/recover", "")
	if gone.Code != http.StatusGone || !strings.Contains(gone.Body.String(), "未取得响应的发送不会重放") {
		t.Fatalf("recover %d %s", gone.Code, gone.Body.String())
	}

	notStopped := callJSON(ownerH, http.MethodPost, "/api/listing/intents/"+queued+"/probe", "")
	if notStopped.Code != http.StatusConflict || !strings.Contains(notStopped.Body.String(), "只有自动核对停止后才能按货号再核对") {
		t.Fatalf("probe stopped %d %s", notStopped.Code, notStopped.Body.String())
	}
	live := callJSON(ownerH, http.MethodPost, "/api/listing/intents/"+held+"/probe", "")
	if live.Code != http.StatusOK || !strings.Contains(live.Body.String(), `"state":"unknown"`) {
		t.Fatalf("probe live %d %s", live.Code, live.Body.String())
	}
	var claimUntil *time.Time
	if err := pool.QueryRow(ctx, `SELECT reconcile_claim_until FROM submission_intents WHERE id = $1::uuid`, held).Scan(&claimUntil); err != nil || claimUntil != nil {
		t.Fatalf("claim stamped %v %v", claimUntil, err)
	}

	released := callJSON(ownerH, http.MethodPost, "/api/listing/intents/release-unknown", `{"intentIds":["`+held+`","`+otherI+`"]}`)
	if released.Code != http.StatusOK || !strings.Contains(released.Body.String(), held) || strings.Contains(released.Body.String(), otherI) {
		t.Fatalf("release %d %s", released.Code, released.Body.String())
	}
	var state string
	if err := pool.QueryRow(ctx, `SELECT state FROM submission_intents WHERE id = $1::uuid`, held).Scan(&state); err != nil || state != "superseded" {
		t.Fatalf("released state %s %v", state, err)
	}
	repeat := callJSON(ownerH, http.MethodPost, "/api/listing/intents/release-unknown", `{"intentIds":["`+held+`"]}`)
	if repeat.Code != http.StatusOK || !strings.Contains(repeat.Body.String(), `"releasedIntentIds":[]`) {
		t.Fatalf("repeat release %d %s", repeat.Code, repeat.Body.String())
	}

	letters := callJSON(ownerH, http.MethodGet, "/api/listing/dead-letters", "")
	if letters.Code != http.StatusOK || !strings.Contains(letters.Body.String(), jobA) || strings.Contains(letters.Body.String(), jobB) || !strings.Contains(letters.Body.String(), `"replayable":true`) {
		t.Fatalf("letters %d %s", letters.Code, letters.Body.String())
	}
	requeued := callJSON(ownerH, http.MethodPost, "/api/listing/dead-letters/"+jobA+"/requeue", "")
	if requeued.Code != http.StatusOK || !strings.Contains(requeued.Body.String(), `"state":"queued"`) || !strings.Contains(requeued.Body.String(), `"attempt":0`) {
		t.Fatalf("requeue %d %s", requeued.Code, requeued.Body.String())
	}
	second := callJSON(ownerH, http.MethodPost, "/api/listing/dead-letters/"+jobA+"/requeue", "")
	if second.Code != http.StatusConflict {
		t.Fatalf("second requeue %d %s", second.Code, second.Body.String())
	}
	cross := callJSON(ownerH, http.MethodPost, "/api/listing/dead-letters/"+jobB+"/requeue", "")
	if cross.Code != http.StatusConflict {
		t.Fatalf("cross requeue %d %s", cross.Code, cross.Body.String())
	}
	var otherState string
	if err := pool.QueryRow(ctx, `SELECT state FROM jobs WHERE id = $1::uuid`, jobB).Scan(&otherState); err != nil || otherState != "failed" {
		t.Fatalf("other job %s %v", otherState, err)
	}
	refused := callJSON(otherH, http.MethodPost, "/api/listing/dead-letters/"+jobB+"/requeue", "")
	if refused.Code != http.StatusConflict || !strings.Contains(refused.Body.String(), "not_replayable_seller_write") {
		t.Fatalf("refusal %d %s", refused.Code, refused.Body.String())
	}

	claimRec := callJSON(reviewerH, http.MethodPost, "/api/listing/jobs/"+jobA+"/claim", "")
	if claimRec.Code != http.StatusOK || !strings.Contains(claimRec.Body.String(), `"data":null`) {
		t.Fatalf("claim %d %s", claimRec.Code, claimRec.Body.String())
	}
	if callJSON(ownerH, http.MethodPost, "/api/listing/jobs/claim-window", `{}`).Code != http.StatusBadRequest {
		t.Fatal("claim window")
	}
	beat := callJSON(ownerH, http.MethodPost, "/api/listing/jobs/"+jobA+"/heartbeat", `{"owner":"x","epoch":1}`)
	if beat.Code != http.StatusOK || !strings.Contains(beat.Body.String(), `"data":false`) {
		t.Fatalf("heartbeat %d %s", beat.Code, beat.Body.String())
	}

	expect(t, ownerH, http.MethodGet, "/api/catalog/fetch-config", http.StatusOK,
		`{"enabled":false,"schedule_mode":"fixed","at_minute":180,"window_start_minute":120,"window_end_minute":240,"utc_offset_minutes":480,"language":"zh_hans","keys":[],"wb_credential":{"configured":false,"credential_revision":0,"last_verified_at_ms":null},"next_run_at_ms":null,"last_run_at_ms":null,"last_status":null,"last_error":"","last_duration_ms":null,"last_root_nodes":null,"last_key_client_id":null,"last_key_attempts":0,"failure_streak":0,"running":false,"coordinate_freshness":{"total":0,"fresh":0,"stale":0,"expired":0,"missing":0},"updated_at_ms":0}`)
	expect(t, otherH, http.MethodGet, "/api/catalog/fetch-config", http.StatusForbidden, `{"error":"需要超级管理员权限","code":"forbidden"}`)

	insertSchemaCache(t, ctx, pool, clock().UnixMilli())
	schema := callJSON(ownerH, http.MethodGet, "/api/catalog/schema?description_category_id=9&type_id=8&language=zh_hans&store_id="+storeA, "")
	if schema.Code != http.StatusOK || !strings.Contains(schema.Body.String(), `"collection":true`) || !strings.Contains(schema.Body.String(), `"native_material"`) {
		t.Fatalf("schema %d %s", schema.Code, schema.Body.String())
	}
	expect(t, ownerH, http.MethodGet, "/api/catalog/schema?description_category_id=1&type_id=1&language=zh_hans", http.StatusOK, `null`)

	insertTree(t, ctx, pool, clock().UnixMilli())
	expect(t, ownerH, http.MethodGet, "/api/catalog/tree?language=zh_hans&store_id="+storeA, http.StatusOK,
		`{"language":"zh_hans","fetched_at_ms":1787333400000,"items":[{"description_category_id":1,"category_name":"a","type_id":2,"type_name":"b","disabled":false,"parent_id":null}]}`)

	wb := callJSON(ownerH, http.MethodGet, "/api/catalog/wb/subjects/15?language=ru", "")
	if wb.Code != http.StatusOK || !strings.Contains(wb.Body.String(), `"code":"catalog_unavailable"`) || !strings.Contains(wb.Body.String(), `"catalog":null`) {
		t.Fatalf("wb %d %s", wb.Code, wb.Body.String())
	}
	if callJSON(ownerH, http.MethodGet, "/api/catalog/wb/subjects/0?language=ru", "").Code != http.StatusBadRequest {
		t.Fatal("wb subject")
	}

	bare, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer bare.Release()
	tx, err := bare.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
		t.Fatal(err)
	}
	var n int64
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM submission_intents`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("missing GUC sees %d %v", n, err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO submission_intents (id, org_id, store_id, listing_row_id, row_revision, client_operation_id, request_hash, state) VALUES ('ffffffff-ffff-4fff-8fff-ffffffffffff'::uuid, $1, $2::uuid, $3::uuid, 1, 'x', 'h', 'queued')`, orgA, storeA, rowA); err == nil {
		t.Fatal("missing GUC inserted an intent")
	}
}

func insertMember(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org, user int64, role string, order int64) int64 {
	t.Helper()
	var id int64
	err := pool.QueryRow(ctx, `
		INSERT INTO organization_members (org_id, user_id, role, display_name, join_order, created_at, updated_at)
		VALUES ($1, $2, $3, 'n', $4, clock_timestamp(), clock_timestamp())
		RETURNING id`, org, user, role, order).Scan(&id)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func insertNamedStore(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org int64, id string, assignee int64) {
	t.Helper()
	var assigneeArg any
	if assignee > 0 {
		assigneeArg = assignee
	}
	_, err := pool.Exec(ctx, `
		INSERT INTO organization_stores (org_id, uuid, create_order, name, assignee_membership_id)
		VALUES ($1, $2::uuid, 1, 'shop', $3)`, org, id, assigneeArg)
	if err != nil {
		t.Fatal(err)
	}
}

func insertIntent(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id string, org int64, store, row, state, op string, last, offer *string) {
	t.Helper()
	_, err := pool.Exec(ctx, `
		INSERT INTO submission_intents (
			id, org_id, store_id, listing_row_id, row_revision, client_operation_id, request_hash, state, last_error_code, offer_id
		) VALUES ($1::uuid, $2, $3::uuid, $4::uuid, 4, $5, 'hash', $6, $7, $8)`,
		id, org, store, row, op, state, last, offer)
	if err != nil {
		t.Fatal(err)
	}
}

func insertDeadJob(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id string, org, user int64, kind, code, payload string) {
	t.Helper()
	_, err := pool.Exec(ctx, `
		INSERT INTO jobs (
			id, org_id, kind, aggregate_type, aggregate_id, input_revision, idempotency_key,
			state, attempt, max_attempts, lane, submitter_user_id, payload, last_error_code
		) VALUES (
			$1::uuid, $2, $3, 'listing_row', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 1, $1,
			'failed', 8, 8, 'listing', $4, $5::jsonb, $6
		)`, id, org, kind, user, payload, code)
	if err != nil {
		t.Fatal(err)
	}
}

func insertSchemaCache(t *testing.T, ctx context.Context, pool *pgxpool.Pool, fetched int64) {
	t.Helper()
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write([]byte(`[{"key":"a","collection":true}]`)); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	_, err := pool.Exec(ctx, `
		INSERT INTO ozon_catalog_schema_cache (description_category_id, type_id, language, payload, fetched_at_ms, byte_size)
		VALUES (9, 8, 'zh_hans', $1, $2, $3)`, buf.Bytes(), fetched, buf.Len())
	if err != nil {
		t.Fatal(err)
	}
}

func strPtr(s string) *string { return &s }
