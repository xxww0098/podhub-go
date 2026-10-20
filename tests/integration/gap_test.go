package integration

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/app/scans"
	billingrepo "github.com/xxww0098/podhub-go/internal/billing/repo"
	"github.com/xxww0098/podhub-go/internal/catalog"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
	queuerepo "github.com/xxww0098/podhub-go/internal/queue/repo"
	queueservice "github.com/xxww0098/podhub-go/internal/queue/service"
	"github.com/xxww0098/podhub-go/internal/seller"
	storerepo "github.com/xxww0098/podhub-go/internal/store/repo"
	"github.com/xxww0098/podhub-go/internal/telemetry"
)

func TestReconcileGaps(t *testing.T) {
	ctx := context.Background()
	pool := migratedPool(t, ctx)
	cleanupGap(t, pool, 97021)
	org, storePK, storeUUID, user := seedGapTenant(t, ctx, pool, 97021)
	t.Cleanup(func() { cleanupGap(t, pool, user) })

	t.Run("grants and billing rls", func(t *testing.T) { testGrants(t, ctx, pool, org, user) })
	t.Run("listing charge and refund", func(t *testing.T) { testListingLedger(t, ctx, pool, org, user, storeUUID) })
	t.Run("stores", func(t *testing.T) { testStoreQuota(t, ctx, pool, org, storePK) })
	t.Run("payments", func(t *testing.T) { testPaymentReplay(t, ctx, pool, org, user) })
	t.Run("scans", func(t *testing.T) { testScans(t, ctx, pool, org, user, storePK, storeUUID) })
	t.Run("retention and catalog", func(t *testing.T) { testTimers(t, ctx, pool, org, user) })
}

func seedGapTenant(t *testing.T, ctx context.Context, pool *pgxpool.Pool, userID int64) (org, storePK int64, storeUUID uuid.UUID, user int64) {
	t.Helper()
	user = userID
	tag := "gap97021"
	if _, err := pool.Exec(ctx, `
		INSERT INTO account_users (id, public_id, email, password_hash, role, name, target, supplier_id, plan, created_at, updated_at)
		VALUES ($1, $2, $3, 'x', 'user', 'Gap', '/workspace', '', 'lite', clock_timestamp(), clock_timestamp())`,
		userID, tag, tag+"@example.invalid"); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO organizations (owner_user_id, name, plan, store_limit_override, created_at, updated_at)
		VALUES ($1, 'gap', 'lite', 1, clock_timestamp(), clock_timestamp()) RETURNING id`, userID).Scan(&org); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO organization_members (org_id, user_id, role, status, display_name, created_at, updated_at, join_order)
		VALUES ($1, $2, 'owner', 'active', 'Gap', clock_timestamp(), clock_timestamp(), 1)`, org, userID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO organization_stores (org_id, create_order, name)
		VALUES ($1, 1, 'first') RETURNING id, uuid`, org).Scan(&storePK, &storeUUID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO user_wallets (user_id, balance_microfen) VALUES ($1, 10000)`, userID); err != nil {
		t.Fatal(err)
	}
	return org, storePK, storeUUID, user
}

func cleanupGap(t *testing.T, pool *pgxpool.Pool, user int64) {
	t.Helper()
	ctx := context.Background()
	rows, err := pool.Query(ctx, `SELECT id FROM organizations WHERE owner_user_id = $1`, user)
	if err != nil {
		t.Errorf("cleanup: %v", err)
		return
	}
	var orgs []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			t.Errorf("cleanup: %v", err)
		}
		orgs = append(orgs, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Errorf("cleanup: %v", err)
	}
	if _, err := pool.Exec(ctx, `ALTER TABLE wallet_ledger DISABLE TRIGGER wallet_ledger_no_rewrite`); err != nil {
		t.Errorf("cleanup: %v", err)
	} else {
		defer pool.Exec(ctx, `ALTER TABLE wallet_ledger ENABLE TRIGGER wallet_ledger_no_rewrite`)
	}
	orgSQL := []string{
		`DELETE FROM store_product_pass_pages WHERE store_pk IN (SELECT id FROM organization_stores WHERE org_id = $1)`,
		`DELETE FROM store_product_sync WHERE org_id = $1`,
		`DELETE FROM store_seller_credentials WHERE org_id = $1`,
		`DELETE FROM seller_upstream_writes WHERE org_id = $1`,
		`DELETE FROM submission_intents WHERE org_id = $1`,
		`DELETE FROM delegate_orders WHERE org_id = $1`,
		`DELETE FROM execution_permits WHERE org_id = $1`,
		`DELETE FROM wallet_ledger WHERE org_id = $1`,
		`DELETE FROM ai_requests WHERE org_id = $1`,
		`DELETE FROM billing_operations WHERE org_id = $1`,
		`DELETE FROM payment_callback_ledger WHERE org_id = $1`,
		`DELETE FROM payment_orders WHERE org_id = $1`,
		`DELETE FROM jobs WHERE org_id = $1`,
		`DELETE FROM event_inbox_events WHERE org_id = $1`,
		`DELETE FROM client_listing_logs WHERE org_id = $1`,
		`DELETE FROM organization_stores WHERE org_id = $1`,
		`DELETE FROM organization_members WHERE org_id = $1`,
		`DELETE FROM organizations WHERE id = $1`,
	}
	for _, org := range orgs {
		for _, q := range orgSQL {
			if _, err := pool.Exec(ctx, q, org); err != nil {
				t.Errorf("cleanup: %v", err)
			}
		}
	}
	for _, q := range []string{
		`DELETE FROM jobs WHERE submitter_user_id = $1`,
		`DELETE FROM execution_permits WHERE user_id = $1`,
		`DELETE FROM execution_quota WHERE user_id = $1`,
		`DELETE FROM execution_fairness WHERE user_id = $1`,
		`DELETE FROM account_queue_head WHERE user_id = $1`,
		`DELETE FROM user_wallets WHERE user_id = $1`,
		`DELETE FROM account_credentials WHERE user_id = $1`,
		`DELETE FROM account_profiles WHERE user_id = $1`,
		`DELETE FROM organization_members WHERE user_id = $1`,
		`DELETE FROM account_users WHERE id = $1`,
	} {
		if _, err := pool.Exec(ctx, q, user); err != nil {
			t.Errorf("cleanup: %v", err)
		}
	}
	if _, err := pool.Exec(ctx, `DELETE FROM platform_catalog_fetch_config WHERE last_error = 'fetch_not_ported'`); err != nil {
		t.Errorf("cleanup: %v", err)
	}
}

func testGrants(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org, user int64) {
	t.Helper()
	for _, table := range []string{"ai_requests", "payment_orders", "redeem_codes", "member_seat_lots"} {
		var ok bool
		if err := pool.QueryRow(ctx, `SELECT has_table_privilege('podhub_app', $1, 'INSERT, UPDATE')`, "public."+table).Scan(&ok); err != nil {
			t.Fatal(err)
		}
		if !ok {
			t.Fatalf("podhub_app cannot write %s", table)
		}
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO ai_requests
		    (public_id, org_id, user_id, idempotency_key, operation, model, upstream_account_id, status, billing_mode)
		VALUES ('gap-ai-97021', $1, $2, 'gap-ai', 'ai_token', 'gap-model', 'loopback', 'held', 'per_request')`, org, user); err == nil {
		t.Fatal("ai_requests insert without the org GUC succeeded")
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	tx, err = pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('role', 'podhub_app', true), set_config('app.current_org_id', $1, true)`, fmt.Sprint(org)); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO ai_requests
		    (public_id, org_id, user_id, idempotency_key, operation, model, upstream_account_id, status, billing_mode)
		VALUES ('gap-ai-97021', $1, $2, 'gap-ai', 'ai_token', 'gap-model', 'loopback', 'held', 'per_request')`, org, user); err != nil {
		t.Fatalf("ai_requests insert as podhub_app: %v", err)
	}
	var visible int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM ai_requests WHERE public_id = 'gap-ai-97021'`).Scan(&visible); err != nil {
		t.Fatal(err)
	}
	if visible != 1 {
		t.Fatalf("ai_requests tenant policy hid the writer's row, got %d", visible)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	tx, err = pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `
		INSERT INTO billing_operations (org_id, idempotency_key, price_snapshot_version, expected_upper_bound_microfen, state)
		VALUES ($1, 'gap-rls', 1, 1, 'created')`, org); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM billing_operations WHERE idempotency_key = 'gap-rls'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("missing tenant setting must hide billing_operations, saw %d", n)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO billing_operations (org_id, idempotency_key, price_snapshot_version, expected_upper_bound_microfen) VALUES ($1, 'gap-rls-2', 1, 1)`, org); err == nil {
		t.Fatal("missing tenant setting must reject a billing_operations insert")
	}
}

func testListingLedger(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org, user int64, store uuid.UUID) {
	t.Helper()
	t.Setenv("CLOUD_LISTING_SUBMIT_PRICE_MICROFEN", "100")
	intent := uuid.New()
	job := uuid.New()
	if _, err := pool.Exec(ctx, `
		INSERT INTO submission_intents
		    (id, org_id, store_id, listing_row_id, row_revision, client_operation_id, request_hash, state, external_task_id)
		VALUES ($1, $2, $3, gen_random_uuid(), 1, 'charge', 'hash', 'accepted', '42')`,
		intent, org, store); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO jobs (id, org_id, kind, aggregate_type, aggregate_id, input_revision, idempotency_key, state, payload, result_ref, lane, submitter_user_id)
		VALUES ($1, $2, 'listing.submit', 'listing_row', gen_random_uuid(), 1, $3, 'succeeded',
		        jsonb_build_object('intentId', $4::text), '{"outcome":"accepted"}'::jsonb, 'listing.submit', $5)`,
		job, org, "charge-"+job.String(), intent.String(), user); err != nil {
		t.Fatal(err)
	}
	if err := billingrepo.SettleListingJob(ctx, pool, org, job.String()); err != nil {
		t.Fatal(err)
	}
	if err := billingrepo.SettleListingJob(ctx, pool, org, job.String()); err != nil {
		t.Fatal(err)
	}
	var task string
	if err := pool.QueryRow(ctx, `SELECT result_ref->>'taskId' FROM jobs WHERE id = $1`, job).Scan(&task); err != nil {
		t.Fatal(err)
	}
	if task != "42" {
		t.Fatalf("taskId %q", task)
	}
	var holds, settles int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE entry_type = 'hold'),
		       count(*) FILTER (WHERE entry_type = 'settle')
		  FROM wallet_ledger WHERE org_id = $1 AND idempotency_key = $2`, org, job.String()).Scan(&holds, &settles); err != nil {
		t.Fatal(err)
	}
	if holds != 1 || settles != 1 {
		t.Fatalf("ledger hold %d settle %d", holds, settles)
	}

	refundJob := uuid.New()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := billingrepo.HoldTx(ctx, tx, org, refundJob.String(), nil, 100); err != nil {
		tx.Rollback(ctx)
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
		tx.Rollback(ctx)
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO billing_operations (org_id, idempotency_key, price_snapshot_version, expected_upper_bound_microfen, state)
		VALUES ($1, $2, 1, 100, 'reserved')`, org, refundJob.String()); err != nil {
		tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO jobs (id, org_id, kind, aggregate_type, aggregate_id, input_revision, idempotency_key, state, payload, lane, submitter_user_id)
		VALUES ($1, $2, 'listing.submit', 'listing_row', gen_random_uuid(), 1, $3, 'failed', '{}'::jsonb, 'listing.submit', $4)`,
		refundJob, org, "refund-"+refundJob.String(), user); err != nil {
		t.Fatal(err)
	}
	if err := billingrepo.SettleListingJob(ctx, pool, org, refundJob.String()); err != nil {
		t.Fatal(err)
	}
	var state string
	var held int64
	if err := pool.QueryRow(ctx, `SELECT state FROM billing_operations WHERE idempotency_key = $1`, refundJob.String()).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "released" {
		t.Fatalf("operation %s", state)
	}
	if err := pool.QueryRow(ctx, `SELECT held_microfen FROM user_wallets WHERE user_id = $1`, user).Scan(&held); err != nil {
		t.Fatal(err)
	}
	if held != 0 {
		t.Fatalf("held %d", held)
	}
}

func testStoreQuota(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org, first int64) {
	t.Helper()
	var second, manual, deleted int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO organization_stores (org_id, create_order, name) VALUES ($1, 2, 'second') RETURNING id`, org).Scan(&second); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO organization_stores (org_id, create_order, name, manual_disabled) VALUES ($1, 3, 'manual', true) RETURNING id`, org).Scan(&manual); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO organization_stores (org_id, create_order, name, deleted_at_ms) VALUES ($1, 4, 'gone', 1) RETURNING id`, org).Scan(&deleted); err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := billingrepo.ReconcileStores(ctx, tx, org); err != nil {
		tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	got := map[int64]bool{}
	rows, err := pool.Query(ctx, `SELECT id, quota_suspended FROM organization_stores WHERE org_id = $1`, org)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var suspended bool
		if err := rows.Scan(&id, &suspended); err != nil {
			t.Fatal(err)
		}
		got[id] = suspended
	}
	if got[first] || !got[second] || got[manual] || got[deleted] {
		t.Fatalf("suspension %+v first %d second %d manual %d deleted %d", got, first, second, manual, deleted)
	}
}

func testPaymentReplay(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org, user int64) {
	t.Helper()
	if _, err := pool.Exec(ctx, `
		INSERT INTO payment_orders
		    (public_id, org_id, plan, months, amount_cents, currency, provider, status,
		     created_by_user_id, created_at, updated_at, product, topup_microfen)
		VALUES ('gap-topup-97021', $1, 'lite', 1, 100, 'CNY', 'alipay', 'pending',
		        $2, clock_timestamp() - interval '1 hour', clock_timestamp(), 'wallet_topup', 5000)`, org, user); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO payment_callback_ledger (payment_reference, org_id, plan, status, applied_at_ms, created_at)
		VALUES ('gap-topup-97021', $1, 'lite', 'paid', 1, clock_timestamp())`, org); err != nil {
		t.Fatal(err)
	}
	var before int64
	if err := pool.QueryRow(ctx, `SELECT balance_microfen FROM user_wallets WHERE user_id = $1`, user).Scan(&before); err != nil {
		t.Fatal(err)
	}
	n, err := billingrepo.ReconcilePayments(ctx, pool, 0)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("applied %d", n)
	}
	var topup string
	var balance int64
	if err := pool.QueryRow(ctx, `SELECT status FROM payment_orders WHERE public_id = 'gap-topup-97021'`).Scan(&topup); err != nil {
		t.Fatal(err)
	}
	if topup != "paid" {
		t.Fatalf("topup %s", topup)
	}
	if err := pool.QueryRow(ctx, `SELECT balance_microfen FROM user_wallets WHERE user_id = $1`, user).Scan(&balance); err != nil {
		t.Fatal(err)
	}
	if balance != before+5000 {
		t.Fatalf("balance %d before %d", balance, before)
	}
}

func testScans(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org, user, storePK int64, store uuid.UUID) {
	t.Helper()
	if _, err := pool.Exec(ctx, `
		INSERT INTO seller_upstream_writes (org_id, store_id, idempotency_key, request_hash, state, reconcile_after)
		VALUES ($1, $2, 'unknown-1', 'hash', 'result_unknown', clock_timestamp() - interval '1 second')`, org, storePK); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO seller_upstream_writes
		    (org_id, store_id, idempotency_key, request_hash, observation_state, observation_next_at)
		VALUES ($1, $2, 'group-1', 'hash', 'pending', clock_timestamp() - interval '1 second')`, org, storePK); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO store_product_sync (org_id, store_id, refresh_generation, next_due_at_ms)
		VALUES ($1, $2, 2, 1)`, org, store); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO store_product_pass_pages (store_pk, generation, page_no, archived, product_ids)
		VALUES ($1, 1, 1, false, '{}'), ($1, 2, 1, false, '{}')`, storePK); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO delegate_orders (org_id, store_id, posting_number, state, created_at_ms, updated_at_ms)
		VALUES ($1, $2, 'P1', 'ready', 1, 1)`, org, store); err != nil {
		t.Fatal(err)
	}
	kek := seal.DeriveKEK("gap-test-key")
	sealed, err := seal.SealV1(kek, "k1", "client-97021", "api-97021")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO store_seller_credentials
		    (store_id, org_id, credential_revision, client_id, key_id, nonce, ciphertext,
		     key_fingerprint, registered_by_user_id, registered_at_ms, envelope_version)
		VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, 1)`,
		storePK, org, sealed.ClientID, sealed.KeyID, sealed.Nonce, sealed.Ciphertext,
		sealed.Fingerprint, user, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO submission_intents
		    (id, org_id, store_id, listing_row_id, row_revision, client_operation_id, request_hash,
		     state, offer_id, reconcile_after)
		VALUES ($1, $2, $3, gen_random_uuid(), 1, 'accepted-probe', 'hash', 'accepted', 'OFFER1',
		        clock_timestamp() - interval '1 minute')`, uuid.New(), org, store); err != nil {
		t.Fatal(err)
	}

	var headerClient, headerKey string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		headerClient = r.Header.Get("Client-Id")
		headerKey = r.Header.Get("Api-Key")
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"items":[{"id":7,"offer_id":"OFFER1","sources":[{"sku":8}]}]}`)
	}))
	defer srv.Close()
	t.Setenv("CLOUD_SELLER_BASE_URL", srv.URL+"/")

	list := queueservice.Schedules(config.Load())
	eg := seller.New(config.Load()).WithPool(pool)
	scans.Attach(list, pool, eg, seal.Ring{Primary: kek}, config.Load().ProductSyncDisabled())
	for _, scan := range list {
		if scan.Name == "UnknownImportsScan" || scan.Name == "ProductSyncScan" {
			continue
		}
		if _, err := scan.Tick(ctx); err != nil {
			t.Fatalf("%s: %v", scan.Name, err)
		}
	}
	var writeState string
	var writeAfter time.Time
	if err := pool.QueryRow(ctx, `
		SELECT state, reconcile_after FROM seller_upstream_writes WHERE idempotency_key = 'unknown-1'`).Scan(&writeState, &writeAfter); err != nil {
		t.Fatal(err)
	}
	if writeState != "result_unknown" || !writeAfter.After(time.Now()) {
		t.Fatalf("unknown write state %s after %s", writeState, writeAfter)
	}
	var obs string
	var lease *time.Time
	if err := pool.QueryRow(ctx, `
		SELECT observation_state, observation_lease_until FROM seller_upstream_writes WHERE idempotency_key = 'group-1'`).Scan(&obs, &lease); err != nil {
		t.Fatal(err)
	}
	if obs != "pending" || lease == nil {
		t.Fatalf("grouping state %s lease %v", obs, lease)
	}
	var pages int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM store_product_pass_pages WHERE store_pk = $1 AND generation = 1`, storePK).Scan(&pages); err != nil {
		t.Fatal(err)
	}
	if pages != 0 {
		t.Fatalf("stale pages %d", pages)
	}
	var syncJobs int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM jobs WHERE org_id = $1 AND kind = 'store.product_sync'`, org).Scan(&syncJobs); err != nil {
		t.Fatal(err)
	}
	if syncJobs != 0 {
		t.Fatal("product sync must not enqueue while the locked batch is 0")
	}
	if n, err := storerepo.SweepDueProductSync(ctx, pool, 2, false); err != nil || n != 1 {
		t.Fatalf("explicit product sync enqueue %d %v", n, err)
	}
	var delegateState, orderState string
	if err := pool.QueryRow(ctx, `
		SELECT state FROM jobs WHERE org_id = $1 AND kind = 'delegate.posting_sync'`, org).Scan(&delegateState); err != nil {
		t.Fatal(err)
	}
	claimed, err := queuerepo.Claim(ctx, pool, "delegate.posting_sync", "gap-test", 1)
	if err != nil || len(claimed) != 1 {
		t.Fatalf("claim %+v %v", claimed, err)
	}
	if err := scans.CancelDelegate(ctx, pool, claimed[0]); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT state FROM jobs WHERE id = $1`, claimed[0].ID).Scan(&delegateState); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT state FROM delegate_orders WHERE org_id = $1`, org).Scan(&orderState); err != nil {
		t.Fatal(err)
	}
	if delegateState != "cancelled" || orderState != "ready" {
		t.Fatalf("job %s order %s", delegateState, orderState)
	}
	var again int
	if _, err := scans.EnqueueDelegateSync(ctx, pool, 16, time.Minute); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM jobs WHERE org_id = $1 AND kind = 'delegate.posting_sync'`, org).Scan(&again); err != nil {
		t.Fatal(err)
	}
	if again != 1 {
		t.Fatalf("bucket inserted %d jobs", again)
	}
	var accepted string
	var after *time.Time
	if err := pool.QueryRow(ctx, `
		SELECT state, reconcile_after FROM submission_intents WHERE client_operation_id = 'accepted-probe'`).Scan(&accepted, &after); err != nil {
		t.Fatal(err)
	}
	if accepted != "accepted" || after != nil {
		t.Fatalf("accepted %s after %v", accepted, after)
	}
	if headerClient != "client-97021" || headerKey != "api-97021" {
		t.Fatalf("headers client %q key %q", headerClient, headerKey)
	}
}

func testTimers(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org, user int64) {
	t.Helper()
	if _, err := pool.Exec(ctx, `
		INSERT INTO event_inbox_events
		    (device_uid, id, org_id, user_id, kind, payload_json, client_created_at, received_at)
		VALUES ('dev', 'old', $1, $2, 'desktop_error_log.v1', '{}', 'then', clock_timestamp() - interval '2 hours'),
		       ('dev', 'new', $1, $2, 'desktop_error_log.v1', '{}', 'now', clock_timestamp()),
		       ('dev', 'bill', $1, $2, 'billing.ai-token-usage.v1', '{}', 'then', clock_timestamp() - interval '2 hours')`, org, user); err != nil {
		t.Fatal(err)
	}
	if _, err := telemetry.PruneErrorLogs(ctx, pool, time.Hour); err != nil {
		t.Fatal(err)
	}
	var oldLeft, newLeft, billLeft int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE id = 'old'),
		       count(*) FILTER (WHERE id = 'new'),
		       count(*) FILTER (WHERE id = 'bill')
		  FROM event_inbox_events WHERE org_id = $1`, org).Scan(&oldLeft, &newLeft, &billLeft); err != nil {
		t.Fatal(err)
	}
	if oldLeft != 0 || newLeft != 1 || billLeft != 0 {
		t.Fatalf("old %d new %d bill %d", oldLeft, newLeft, billLeft)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO platform_catalog_fetch_config (singleton, enabled, schedule_mode, at_minute, utc_offset_minutes)
		VALUES (true, true, 'fixed', 180, 480)`); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 16, 4, 0, 0, 0, time.FixedZone("catalog", 8*3600))
	ok, err := catalog.TickFetch(ctx, pool, now)
	if err != nil || !ok {
		t.Fatalf("tick %v %v", ok, err)
	}
	var lastErr string
	var status *string
	var streak int
	if err := pool.QueryRow(ctx, `
		SELECT last_error, last_status, failure_streak FROM platform_catalog_fetch_config`).Scan(&lastErr, &status, &streak); err != nil {
		t.Fatal(err)
	}
	if lastErr != "fetch_not_ported" || status != nil || streak != 0 {
		t.Fatalf("catalog error %q status %v streak %d", lastErr, status, streak)
	}
}
