package integration

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"

	admindomain "github.com/xxww0098/podhub-go/internal/admin/domain"
	"github.com/xxww0098/podhub-go/internal/ai/jobs/reaper"
	billingdomain "github.com/xxww0098/podhub-go/internal/billing/domain"
	billinghttp "github.com/xxww0098/podhub-go/internal/billing/http"
	billingrepo "github.com/xxww0098/podhub-go/internal/billing/repo"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/platform/writer"
	supplydomain "github.com/xxww0098/podhub-go/internal/supply/domain"
	supplyrepo "github.com/xxww0098/podhub-go/internal/supply/repo"
	"github.com/xxww0098/podhub-go/internal/telemetry"
	telemetrydomain "github.com/xxww0098/podhub-go/internal/telemetry/domain"
	telemetryrepo "github.com/xxww0098/podhub-go/internal/telemetry/repo"
	"github.com/xxww0098/podhub-go/tests/testkit"
)

// TestSecurityCutover is the S1 contrast: the API login is podhub_login_api,
// not the postgres superuser. FORCE RLS hides the other org, and the four
// named flows still settle the same rows.
func TestSecurityCutover(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	t.Cleanup(func() { _ = os.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "1") })

	dsn := securityDSN(t, ctx)
	_ = os.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "1")
	super, err := db.Connect(ctx, config.Config{DatabaseURL: dsn})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(super.Close)
	if err := db.Migrate(ctx, super); err != nil {
		t.Fatal(err)
	}
	if _, err := super.Exec(ctx, `ALTER ROLE podhub_login_api PASSWORD 'podhub-login-test'`); err != nil {
		t.Fatal(err)
	}

	_ = os.Unsetenv("PODHUB_ALLOW_SUPERUSER_DB")
	refused, err := db.Connect(ctx, config.Config{DatabaseURL: dsn})
	if err == nil {
		refused.Close()
		t.Fatal("superuser login was accepted without PODHUB_ALLOW_SUPERUSER_DB=1")
	}
	if !strings.Contains(err.Error(), "superuser or BYPASSRLS") {
		t.Fatal(err)
	}
	login, err := db.Connect(ctx, config.Config{DatabaseURL: swapUser(dsn, "podhub_login_api", "podhub-login-test")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(login.Close)
	_ = os.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "1")

	var role string
	var superuser, bypass bool
	if err := login.QueryRow(ctx, `
		SELECT r.rolname, r.rolsuper, r.rolbypassrls
		  FROM pg_roles r WHERE r.rolname = current_user`).Scan(&role, &superuser, &bypass); err != nil {
		t.Fatal(err)
	}
	if role != "podhub_login_api" || superuser || bypass {
		t.Fatalf("login role %s super %v bypass %v", role, superuser, bypass)
	}
	if _, err := login.Exec(ctx, `SELECT set_config('role', 'podhub_worker', true)`); err == nil {
		t.Fatal("podhub_login_api set role podhub_worker")
	}

	for _, table := range []string{
		"payment_orders", "workspace_wallets", "wallet_ledger",
		"redeem_codes", "ai_requests", "sc_orders", "sc_order_lines",
	} {
		var enabled, forced bool
		if err := super.QueryRow(ctx, `
			SELECT c.relrowsecurity, c.relforcerowsecurity
			  FROM pg_class c
			  JOIN pg_namespace n ON n.oid = c.relnamespace
			 WHERE n.nspname = 'public' AND c.relname = $1`, table).Scan(&enabled, &forced); err != nil {
			t.Fatal(table, err)
		}
		if !enabled || !forced {
			t.Fatalf("%s rls enabled %v forced %v", table, enabled, forced)
		}
	}

	userA, orgA, uuidA := securityOrg(t, ctx, super, "sec-a")
	userB, orgB, _ := securityOrg(t, ctx, super, "sec-b")
	t.Cleanup(func() { securityCleanup(super, orgA, orgB, userA, userB) })

	payA := "sec-pay-a-" + uuid.NewString()
	payB := "sec-pay-b-" + uuid.NewString()
	securityPay(t, ctx, super, payA, orgA, userA)
	securityPay(t, ctx, super, payB, orgB, userB)
	securityAI(t, ctx, super, orgA, userA, "sec-ai-a")
	securityAI(t, ctx, super, orgB, userB, "sec-ai-b")
	code := "SEC" + strings.ToUpper(strings.ReplaceAll(uuid.NewString(), "-", ""))[:20]
	if _, err := super.Exec(ctx, `
		INSERT INTO redeem_codes
		    (code, used, created_at, updated_at, wallet_cents)
		VALUES ($1, false, clock_timestamp(), clock_timestamp(), 100)`, code); err != nil {
		t.Fatal(err)
	}

	securityRLS(t, ctx, login, orgA, orgB, payA, payB, "sec-ai-a", "sec-ai-b", code)
	var redeemID int64
	if err := login.QueryRow(ctx, `SELECT id FROM public.billing_lock_redeem_code($1)`, code).Scan(&redeemID); err != nil || redeemID == 0 {
		t.Fatalf("lookup %d %v", redeemID, err)
	}
	tx, err := login.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('role', 'podhub_app', true), set_config('app.current_org_id', $1, true)`, fmt.Sprint(orgA)); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `SELECT public.billing_consume_redeem_code($1, $2, $3, $4)`, redeemID, userA, orgB, time.Now().UnixMilli()); err == nil {
		t.Fatal("consume accepted another org")
	}
	_ = tx.Rollback(ctx)

	securityRecipeLease(t, ctx, super, login)

	instance := fmt.Sprintf("axum-%d", os.Getpid())
	if _, err := writer.Bootstrap(ctx, login.Begin, "entitlement", instance, "cutover bootstrap", time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = super.Exec(context.Background(), `DELETE FROM writer_lease_events WHERE domain IN ('entitlement', 'recipe') AND reason = 'cutover bootstrap'`)
		_, _ = super.Exec(context.Background(), `DELETE FROM writer_leases WHERE grant_reason = 'cutover bootstrap'`)
		_, _ = super.Exec(context.Background(), `DELETE FROM writer_leases WHERE domain = 'entitlement' AND holder_instance = 'other-cutover'`)
	})

	orderPublic := securitySellerConfirm(t, ctx, super, login, orgA, userA)
	admin := entitlementWithBilling(login)
	body, err := admin.ConfirmOrder(ctx, admindomain.Actor{UserID: userA}, orderPublic)
	if err != nil || !strings.Contains(string(body), `"status":"paid"`) {
		t.Fatalf("platform confirm %s %v", body, err)
	}
	var sellerStatus string
	if err := super.QueryRow(ctx, `SELECT status FROM sc_orders WHERE payment_order_public_id = $1`, orderPublic).Scan(&sellerStatus); err != nil || sellerStatus != "awaiting_procurement" {
		t.Fatalf("sc_orders %s %v", sellerStatus, err)
	}
	var lines int
	if err := appCount(ctx, login, orgB, `SELECT count(*) FROM sc_order_lines WHERE order_id IN (SELECT order_id FROM sc_orders WHERE payment_order_public_id = $1)`, orderPublic).Scan(&lines); err != nil || lines != 0 {
		t.Fatalf("cross line %d %v", lines, err)
	}

	securityWebhook(t, ctx, login, payB)
	var paid string
	var balance int64
	if err := super.QueryRow(ctx, `SELECT status FROM payment_orders WHERE public_id = $1`, payB).Scan(&paid); err != nil || paid != "paid" {
		t.Fatalf("webhook status %s %v", paid, err)
	}
	if err := super.QueryRow(ctx, `SELECT balance_microfen FROM workspace_wallets WHERE org_id = $1`, orgB).Scan(&balance); err != nil || balance != 1_000_000 {
		t.Fatalf("webhook balance %d %v", balance, err)
	}
	if err := super.QueryRow(ctx, `SELECT status FROM payment_orders WHERE public_id = $1`, payA).Scan(&paid); err != nil || paid != "pending" {
		t.Fatalf("org A order changed %s %v", paid, err)
	}

	redeemed, err := billingrepo.Redeem(ctx, login, orgA, userA, code, uuidA)
	if err != nil || redeemed.WalletCents != 100 {
		t.Fatalf("redeem %+v %v", redeemed, err)
	}
	var used bool
	var usedOrg int64
	if err := super.QueryRow(ctx, `SELECT used, used_by_org_id FROM redeem_codes WHERE code = $1`, code).Scan(&used, &usedOrg); err != nil || !used || usedOrg != orgA {
		t.Fatalf("used %v org %d %v", used, usedOrg, err)
	}
	if err := super.QueryRow(ctx, `SELECT balance_microfen FROM workspace_wallets WHERE org_id = $1`, orgA).Scan(&balance); err != nil || balance != 100_000_000 {
		t.Fatalf("redeem balance %d %v", balance, err)
	}

	if _, err := admin.ConfirmOrder(ctx, admindomain.Actor{UserID: userA}, "missing-"+uuid.NewString()); err == nil || !strings.Contains(err.Error(), "订单不存在") {
		t.Fatalf("missing order %v", err)
	}
	if _, err := super.Exec(ctx, `DELETE FROM writer_leases WHERE domain = 'entitlement' AND revoked_at_ms IS NULL`); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.ConfirmOrder(ctx, admindomain.Actor{UserID: userA}, payA); err == nil || !strings.Contains(err.Error(), "权益域写入未启用") {
		t.Fatalf("empty lease %v", err)
	}
	if _, err := super.Exec(ctx, `
		INSERT INTO writer_leases (
		    domain, holder, holder_instance, fence_token, granted_at_ms,
		    expires_at_ms, heartbeat_at_ms, grant_reason)
		VALUES ('entitlement', 'axum', 'other-cutover', 1,
		        (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint,
		        (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint + 600000,
		        (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint,
		        'other')`); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.ConfirmOrder(ctx, admindomain.Actor{UserID: userA}, payA); err == nil || !strings.Contains(err.Error(), "权益域写入未启用") {
		t.Fatalf("foreign lease %v", err)
	}
	if _, err := super.Exec(ctx, `DELETE FROM writer_leases WHERE domain = 'entitlement' AND holder_instance = 'other-cutover'`); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Bootstrap(ctx, login.Begin, "entitlement", instance, "cutover bootstrap", time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	body, err = admin.ConfirmOrder(ctx, admindomain.Actor{UserID: userA}, payA)
	if err != nil || !strings.Contains(string(body), `"status":"paid"`) {
		t.Fatalf("same instance confirm %s %v", body, err)
	}

	securityMaintenanceSweeps(t, ctx, dsn, super, login, orgA, userA)
}

// securityMaintenanceSweeps is the 00368 contrast: every background sweep that
// crosses tenants must run on podhub_login_api, which is neither superuser nor
// BYPASSRLS. Before 00368 each of them was "permission denied" and the error
// was logged once per tick, so a held row was never released.
func securityMaintenanceSweeps(t *testing.T, ctx context.Context, dsn string, super, login *pgxpool.Pool, orgID, userID int64) {
	t.Helper()
	seedMatchingLease(t, ctx, super, "billing", "maintenance sweep")
	if _, err := super.Exec(ctx, `
		INSERT INTO workspace_wallets (org_id, balance_microfen, held_microfen)
		VALUES ($1, 1000, 0)
		ON CONFLICT (org_id) DO UPDATE SET balance_microfen = 1000, held_microfen = 0`, orgID); err != nil {
		t.Fatal(err)
	}

	// A stranded held row with its hold already recorded, aged past the
	// 900 second window. Closing it releases the wallet and marks the row.
	stranded := "sec-stranded-" + uuid.NewString()
	if _, err := super.Exec(ctx, `
		INSERT INTO ai_requests
		    (public_id, org_id, user_id, idempotency_key, operation, model,
		     upstream_account_id, status, billing_mode, held_microfen, updated_at)
		VALUES ($1, $2, $3, $1, 'ai_token', 'sec-model', 'loopback', 'held',
		        'per_request', 100, clock_timestamp() - interval '1 hour')`,
		stranded, orgID, userID); err != nil {
		t.Fatal(err)
	}
	var strandedID int64
	if err := super.QueryRow(ctx, `
		SELECT id FROM ai_requests WHERE public_id = $1`, stranded).Scan(&strandedID); err != nil {
		t.Fatal(err)
	}
	if err := securityHold(ctx, login, orgID, stranded, &strandedID); err != nil {
		t.Fatal(err)
	}
	closed, err := reaper.SweepStranded(ctx, login, billingrepo.ReleaseTx)
	if err != nil {
		t.Fatalf("SweepStranded: %v", err)
	}
	if closed != 1 {
		t.Fatalf("SweepStranded closed %d", closed)
	}
	var status, class string
	if err := super.QueryRow(ctx, `
		SELECT status, error_class FROM ai_requests WHERE public_id = $1`, stranded).Scan(&status, &class); err != nil {
		t.Fatal(err)
	}
	if status != "unbilled_unknown" || class != "stranded_request" {
		t.Fatalf("stranded row %s %s", status, class)
	}
	var held int64
	if err := super.QueryRow(ctx, `
		SELECT held_microfen FROM workspace_wallets WHERE org_id = $1`, orgID).Scan(&held); err != nil {
		t.Fatal(err)
	}
	if held != 0 {
		t.Fatalf("wallet still holds %d", held)
	}

	// PruneBodies may blank only a settled body, and only that column.
	settled := "sec-settled-" + uuid.NewString()
	if _, err := super.Exec(ctx, `
		INSERT INTO ai_requests
		    (public_id, org_id, user_id, idempotency_key, operation, model,
		     upstream_account_id, status, billing_mode, held_microfen,
		     response_body, settled_at, updated_at)
		VALUES ($1, $2, $3, $1, 'ai_token', 'sec-model', 'loopback', 'settled',
		        'per_request', 100, '{"kept":true}'::jsonb,
		        clock_timestamp() - interval '9 days',
		        clock_timestamp() - interval '9 days')`,
		settled, orgID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := reaper.PruneBodies(ctx, login); err != nil {
		t.Fatalf("PruneBodies: %v", err)
	}
	var body *string
	if err := super.QueryRow(ctx, `
		SELECT response_body::text FROM ai_requests WHERE public_id = $1`, settled).Scan(&body); err != nil {
		t.Fatal(err)
	}
	if body != nil {
		t.Fatalf("settled body kept %s", *body)
	}
	var unsettled *string
	if err := super.QueryRow(ctx, `
		SELECT response_body::text FROM ai_requests WHERE public_id = $1`, stranded).Scan(&unsettled); err != nil {
		t.Fatal(err)
	}

	// The reservation reaper reads and locks a cross-tenant row, then releases
	// it under the org's app session.
	reserved := "sec-reserved-" + uuid.NewString()
	if _, err := super.Exec(ctx, `
		INSERT INTO billing_operations
		    (org_id, idempotency_key, price_snapshot_version,
		     expected_upper_bound_microfen, state, updated_at)
		VALUES ($1, $2, 1, 100, 'reserved', clock_timestamp() - interval '2 hours')`,
		orgID, reserved); err != nil {
		t.Fatal(err)
	}
	if err := securityHold(ctx, login, orgID, reserved, nil); err != nil {
		t.Fatal(err)
	}
	released, err := billingrepo.ReapReservations(ctx, login, time.Hour, 10)
	if err != nil {
		t.Fatalf("ReapReservations: %v", err)
	}
	if released < 1 {
		t.Fatalf("ReapReservations released %d", released)
	}
	var state string
	if err := super.QueryRow(ctx, `
		SELECT state FROM billing_operations WHERE idempotency_key = $1`, reserved).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "released" {
		t.Fatalf("reservation state %s", state)
	}

	// The aged client log delete scans through a SELECT arm and deletes.
	aged := time.Now().AddDate(0, 0, -90)
	if _, err := super.Exec(ctx, `
		INSERT INTO client_listing_logs
		    (org_id, user_id, client_id, session_id, version, logged_at,
		     level, module, event, received_at)
		VALUES ($1, $2, 'c', 's', 'v', $3, 'info', 'm', 'e', $3)`,
		orgID, userID, aged); err != nil {
		t.Fatal(err)
	}
	if _, err := telemetry.PruneErrorLogs(ctx, login, 30*24*time.Hour); err != nil {
		t.Fatalf("PruneErrorLogs: %v", err)
	}
	var logs int64
	if err := super.QueryRow(ctx, `
		SELECT count(*) FROM client_listing_logs WHERE org_id = $1`, orgID).Scan(&logs); err != nil {
		t.Fatal(err)
	}
	if logs != 0 {
		t.Fatalf("client logs left %d", logs)
	}

	// The digest reads the inbox as a queue worker login, which is where the
	// podhub.error_digest job runs. It is not the API login.
	if _, err := super.Exec(ctx, `ALTER ROLE podhub_login_reconciler PASSWORD 'podhub-reconciler-test'`); err != nil {
		t.Fatal(err)
	}
	worker, err := db.Connect(ctx, config.Config{DatabaseURL: swapUser(dsn, "podhub_login_reconciler", "podhub-reconciler-test")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(worker.Close)
	if _, err := telemetryrepo.New(worker).ErrorWindow(ctx, time.Now().Add(-time.Hour), time.Now()); err != nil {
		t.Fatalf("ErrorWindow: %v", err)
	}
	if err := telemetryrepo.New(worker).SaveDigest(ctx, []telemetrydomain.DigestRow{{
		Platform:      true,
		Fingerprint:   strings.Repeat("ab", 32),
		RouteTemplate: "/sec",
		StatusCode:    500,
		Count:         1,
		FirstAt:       time.Now().Add(-time.Hour),
		LastAt:        time.Now(),
		Summary:       "sec",
		WindowStart:   time.Now().Truncate(time.Hour).Add(-time.Hour),
	}}); err != nil {
		t.Fatalf("SaveDigest: %v", err)
	}
}

// securityHold records one wallet reservation for a key the reaper will see.
func securityHold(ctx context.Context, pool *pgxpool.Pool, orgID int64, key string, aiID *int64) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := tenantx.EnterApp(ctx, tx, orgID); err != nil {
		return err
	}
	if _, err := billingrepo.HoldTx(ctx, tx, orgID, key, aiID, 100); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// securityDSN starts a private cluster. The test changes podhub_login_api's
// password, and roles are cluster-wide, so it must not use the shared template.
// It also raises max_locks_per_transaction.
func securityDSN(t *testing.T, ctx context.Context) string {
	t.Helper()
	dsn := os.Getenv("PODHUB_PARITY_DSN")
	if dsn != "" {
		if err := (config.Config{DatabaseURL: dsn}).CheckDatabase(); err != nil {
			t.Fatal(err)
		}
		return dsn
	}
	if !testkit.DockerAvailable() {
		t.Skip("docker daemon is not available")
	}
	container, err := postgres.Run(ctx, "postgres:16-alpine",
		postgres.WithDatabase("podhub"),
		postgres.WithUsername("postgres"),
		postgres.WithPassword("postgres"),
		postgres.BasicWaitStrategies(),
		testcontainers.WithCmdArgs("-c", "max_locks_per_transaction=256"),
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = container.Terminate(context.Background()) })
	dsn, err = container.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	return dsn
}

func swapUser(dsn, user, password string) string {
	parsed, err := url.Parse(dsn)
	if err != nil {
		return dsn
	}
	parsed.User = url.UserPassword(user, password)
	return parsed.String()
}

func securityOrg(t *testing.T, ctx context.Context, pool *pgxpool.Pool, tag string) (int64, int64, string) {
	t.Helper()
	var userID, orgID int64
	var orgUUID string
	email := tag + "-" + uuid.NewString() + "@example.invalid"
	if err := pool.QueryRow(ctx, `
		INSERT INTO account_users (public_id, email, password_hash, role, name, target, supplier_id, plan, created_at, updated_at)
		VALUES ($1, $2, 'x', 'user', 'Owner', '/workspace', '', 'free', clock_timestamp(), clock_timestamp())
		RETURNING id`, "u-"+tag+"-"+uuid.NewString(), email).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO organizations (owner_user_id, name, plan, created_at, updated_at)
		VALUES ($1, $2, 'free', clock_timestamp(), clock_timestamp())
		RETURNING id, uuid::text`, userID, tag).Scan(&orgID, &orgUUID); err != nil {
		t.Fatal(err)
	}
	return userID, orgID, orgUUID
}

func securityPay(t *testing.T, ctx context.Context, pool *pgxpool.Pool, publicID string, orgID, userID int64) {
	t.Helper()
	if _, err := pool.Exec(ctx, `
		INSERT INTO payment_orders
		       (public_id, org_id, plan, months, amount_cents, currency, provider, status,
		        created_by_user_id, created_at, updated_at, product, topup_microfen)
		VALUES ($1, $2, 'free', 1, 100, 'CNY', 'easypay', 'pending',
		        $3, clock_timestamp(), clock_timestamp(), 'wallet_topup', 1000000)`,
		publicID, orgID, userID); err != nil {
		t.Fatal(err)
	}
}

func securityAI(t *testing.T, ctx context.Context, pool *pgxpool.Pool, orgID, userID int64, publicID string) {
	t.Helper()
	if _, err := pool.Exec(ctx, `
		INSERT INTO ai_requests
		    (public_id, org_id, user_id, idempotency_key, operation, model, upstream_account_id, status, billing_mode)
		VALUES ($1, $2, $3, $1, 'ai_token', 'sec-model', 'loopback', 'held', 'per_request')`, publicID, orgID, userID); err != nil {
		t.Fatal(err)
	}
}

func securityRLS(t *testing.T, ctx context.Context, pool *pgxpool.Pool, orgA, orgB int64, payA, payB, aiA, aiB, code string) {
	t.Helper()
	var n int
	if err := appCount(ctx, pool, 0, `SELECT count(*) FROM payment_orders WHERE public_id IN ($1, $2)`, payA, payB).Scan(&n); err != nil || n != 0 {
		t.Fatalf("missing guc payment %d %v", n, err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO ai_requests
		    (public_id, org_id, user_id, idempotency_key, operation, model, upstream_account_id, status, billing_mode)
		VALUES ('sec-ai-missing', $1, 1, 'sec-ai-missing', 'ai_token', 'sec-model', 'loopback', 'held', 'per_request')`, orgA); err == nil {
		t.Fatal("ai insert without guc")
	}
	_ = tx.Rollback(ctx)

	if err := appCount(ctx, pool, orgA, `SELECT count(*) FROM payment_orders WHERE public_id IN ($1, $2)`, payA, payB).Scan(&n); err != nil || n != 1 {
		t.Fatalf("tenant payment %d %v", n, err)
	}
	tag, err := appExec(ctx, pool, orgA, `UPDATE payment_orders SET amount_cents = amount_cents WHERE public_id = $1`, payB)
	if err != nil || tag != 0 {
		t.Fatalf("cross payment update %d %v", tag, err)
	}
	if err := appCount(ctx, pool, orgA, `SELECT count(*) FROM ai_requests WHERE public_id IN ($1, $2)`, aiA, aiB).Scan(&n); err != nil || n != 1 {
		t.Fatalf("ai %d %v", n, err)
	}
	if err := appCount(ctx, pool, orgA, `SELECT count(*) FROM redeem_codes WHERE code = $1`, code).Scan(&n); err != nil || n != 0 {
		t.Fatalf("redeem visible %d %v", n, err)
	}
}

func securityRecipeLease(t *testing.T, ctx context.Context, super, pool *pgxpool.Pool) {
	t.Helper()
	if _, err := super.Exec(ctx, `DELETE FROM writer_lease_events WHERE domain = 'recipe'`); err != nil {
		t.Fatal(err)
	}
	if _, err := super.Exec(ctx, `DELETE FROM writer_leases WHERE domain = 'recipe'`); err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
		t.Fatal(err)
	}
	_, err = writer.Assert(ctx, tx, "recipe", writer.ProcessIdentity(), time.Now().UnixMilli(), "配方域写入未启用")
	if !writer.IsDisabled(err) {
		t.Fatalf("empty recipe %v", err)
	}
	_ = tx.Rollback(ctx)

	same := "cutover-same"
	other := "cutover-other"
	now := time.Now().UnixMilli()
	id, err := writer.Bootstrap(ctx, pool.Begin, "recipe", same, "cutover bootstrap", now)
	if err != nil || id == 0 {
		t.Fatal(err)
	}
	again, err := writer.Bootstrap(ctx, pool.Begin, "recipe", same, "cutover bootstrap", now)
	if err != nil || again != id {
		t.Fatalf("replay %d %v", again, err)
	}
	if _, err := writer.Bootstrap(ctx, pool.Begin, "recipe", other, "cutover bootstrap", now); !errors.Is(err, writer.ErrLeaseHeld) {
		t.Fatalf("steal %v", err)
	}
	tx, err = pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
		t.Fatal(err)
	}
	held, err := writer.Assert(ctx, tx, "recipe", writer.Identity{Holder: writer.HolderAxum, InstanceID: same}, now, "配方域写入未启用")
	if err != nil || held.ID == nil {
		t.Fatalf("same id %+v %v", held, err)
	}
	held, err = writer.Assert(ctx, tx, "recipe", writer.Identity{Holder: writer.HolderAxum, InstanceID: same}, now, "配方域写入未启用")
	if err != nil || held.ID == nil {
		t.Fatalf("same id again %+v %v", held, err)
	}
	_, err = writer.Assert(ctx, tx, "recipe", writer.Identity{Holder: writer.HolderAxum, InstanceID: other}, now, "配方域写入未启用")
	if !writer.IsDisabled(err) {
		t.Fatalf("different id %v", err)
	}
	_ = tx.Rollback(ctx)
}

func securitySellerConfirm(t *testing.T, ctx context.Context, super, login *pgxpool.Pool, orgID, userID int64) string {
	t.Helper()
	row := uuid.NewString()
	store := uuid.NewString()
	sku := "sku-sec-" + uuid.NewString()
	product := "prod-" + sku
	if _, err := super.Exec(ctx, `INSERT INTO listing_rows (id, org_id, card_id, store_id) VALUES ($1, $2, $3, $4)`, row, orgID, uuid.NewString(), store); err != nil {
		t.Fatal(err)
	}
	if _, err := super.Exec(ctx, `INSERT INTO organization_stores (org_id, uuid, create_order, name) VALUES ($1, $2, 1, 'shop')`, orgID, store); err != nil {
		t.Fatal(err)
	}
	if _, err := super.Exec(ctx, `
		INSERT INTO sc_products (product_id, title, description, created_at_ms, updated_at_ms, created_by_account_uuid, published)
		VALUES ($1, '公开短袖', '卖家可见描述', 1, 1, 'test', true)`, product); err != nil {
		t.Fatal(err)
	}
	if _, err := super.Exec(ctx, `
		INSERT INTO sc_skus (sku_id, product_id, platform_code, title, lead_time, created_at_ms, updated_at_ms, created_by_account_uuid, published)
		VALUES ($1, $2, $3, '短袖', '3-5 天', 2, 2, 'test', true)`, sku, product, "code-"+sku); err != nil {
		t.Fatal(err)
	}
	if _, err := super.Exec(ctx, `
		INSERT INTO sc_price_versions (sku_id, price_cents, created_at_ms, created_by_account_uuid)
		VALUES ($1, 1250, 3, 'test')`, sku); err != nil {
		t.Fatal(err)
	}
	repo := supplyrepo.New(login, tenantx.BeginApp)
	now := time.Now().UnixMilli()
	hash := "sha256:" + strings.Repeat("ab", 32)
	file := "11111111-1111-4111-8111-111111111111"
	if _, err := repo.PutBinding(ctx, orgID, userID, row, []supplydomain.ProductionFile{{
		MediaAssetID: file, ContentHash: hash, HasHash: true,
	}}, sku, 2, now); err != nil {
		t.Fatal(err)
	}
	quote, err := repo.CreateQuote(ctx, orgID, userID, row, 2, "sec-quote-"+sku, now)
	if err != nil || quote.AmountCents != 2500 {
		t.Fatalf("quote %+v %v", quote, err)
	}
	order, err := repo.ConfirmOrder(ctx, orgID, userID, quote.QuoteID, "sec-order-"+sku, now)
	if err != nil || order.Status != "awaiting_payment" || order.AmountCents != 2500 || !strings.HasPrefix(order.PaymentOrderPublicID, "pg_") {
		t.Fatalf("seller %+v %v", order, err)
	}
	return order.PaymentOrderPublicID
}

func securityWebhook(t *testing.T, ctx context.Context, pool *pgxpool.Pool, publicID string) {
	t.Helper()
	fields := map[string]string{
		"pid": "1000", "money": "1.00", "out_trade_no": publicID,
		"trade_no": "sec-trade", "trade_status": "TRADE_SUCCESS",
	}
	fields["sign"] = billingdomain.EasyPayMD5(fields, "secret")
	body := url.Values{}
	for key, value := range fields {
		body.Set(key, value)
	}
	router := chi.NewRouter()
	billinghttp.Register(router, billinghttp.Deps{
		Billing:  billingHTTPPort(),
		Pool:     pool,
		Payments: billinghttp.Payments{EasyPayPID: "1000", EasyPayKey: "secret"},
	})
	req := httptest.NewRequest(http.MethodPost, "/api/billing/webhooks/easypay", strings.NewReader(body.Encode())).WithContext(ctx)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || rec.Body.String() != "success" {
		t.Fatalf("webhook %d %s", rec.Code, rec.Body.String())
	}
}

func appCount(ctx context.Context, pool *pgxpool.Pool, org int64, sql string, args ...any) pgx.Row {
	return &appRow{ctx: ctx, pool: pool, org: org, sql: sql, args: args}
}

type appRow struct {
	ctx  context.Context
	pool *pgxpool.Pool
	org  int64
	sql  string
	args []any
}

func (r *appRow) Scan(dest ...any) error {
	tx, err := r.pool.Begin(r.ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(r.ctx)
	if r.org == 0 {
		_, err = tx.Exec(r.ctx, `SELECT set_config('role', 'podhub_app', true)`)
	} else {
		_, err = tx.Exec(r.ctx, `SELECT set_config('role', 'podhub_app', true), set_config('app.current_org_id', $1, true)`, fmt.Sprint(r.org))
	}
	if err != nil {
		return err
	}
	return tx.QueryRow(r.ctx, r.sql, r.args...).Scan(dest...)
}

func appExec(ctx context.Context, pool *pgxpool.Pool, org int64, sql string, args ...any) (int64, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('role', 'podhub_app', true), set_config('app.current_org_id', $1, true)`, fmt.Sprint(org)); err != nil {
		return 0, err
	}
	tag, err := tx.Exec(ctx, sql, args...)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

func securityCleanup(pool *pgxpool.Pool, orgA, orgB, userA, userB int64) {
	ctx := context.Background()
	_, _ = pool.Exec(ctx, `DELETE FROM wallet_ledger WHERE org_id IN ($1, $2)`, orgA, orgB)
	_, _ = pool.Exec(ctx, `DELETE FROM workspace_wallets WHERE org_id IN ($1, $2)`, orgA, orgB)
	for _, org := range []int64{orgA, orgB} {
		_, _ = pool.Exec(ctx, `DELETE FROM sc_order_lines WHERE org_id = $1`, org)
		_, _ = pool.Exec(ctx, `DELETE FROM sc_orders WHERE org_id = $1`, org)
		_, _ = pool.Exec(ctx, `DELETE FROM sc_order_quotes WHERE org_id = $1`, org)
		_, _ = pool.Exec(ctx, `DELETE FROM sc_listing_bindings WHERE org_id = $1`, org)
		_, _ = pool.Exec(ctx, `DELETE FROM ai_requests WHERE org_id = $1`, org)
		_, _ = pool.Exec(ctx, `DELETE FROM audit_logs WHERE org_id = $1`, org)
		_, _ = pool.Exec(ctx, `DELETE FROM payment_orders WHERE org_id = $1`, org)
		_, _ = pool.Exec(ctx, `DELETE FROM listing_rows WHERE org_id = $1`, org)
		_, _ = pool.Exec(ctx, `DELETE FROM organization_stores WHERE org_id = $1`, org)
	}
	_, _ = pool.Exec(ctx, `DELETE FROM redeem_codes WHERE code LIKE 'SEC%'`)
	_, _ = pool.Exec(ctx, `DELETE FROM organizations WHERE id IN ($1, $2)`, orgA, orgB)
	_, _ = pool.Exec(ctx, `DELETE FROM account_users WHERE id IN ($1, $2)`, userA, userB)
	_, _ = pool.Exec(ctx, `DELETE FROM sc_price_versions WHERE sku_id LIKE 'sku-sec-%'`)
	_, _ = pool.Exec(ctx, `DELETE FROM sc_skus WHERE sku_id LIKE 'sku-sec-%'`)
	_, _ = pool.Exec(ctx, `DELETE FROM sc_products WHERE product_id LIKE 'prod-sku-sec-%'`)
}
