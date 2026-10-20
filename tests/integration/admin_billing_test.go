package integration

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgconn"

	adminbillingrepo "github.com/xxww0098/podhub-go/internal/admin/billing/repo"
	"github.com/xxww0098/podhub-go/internal/admin/domain"
	adminhttp "github.com/xxww0098/podhub-go/internal/admin/http"
	observerepo "github.com/xxww0098/podhub-go/internal/admin/observe/repo"
	adminrepo "github.com/xxww0098/podhub-go/internal/admin/repo"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

func TestAdminBillingOps(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	const ownerID int64 = 88021
	const adminID int64 = 88022
	if _, err := pool.Exec(ctx, `
		INSERT INTO account_users (id, public_id, email, password_hash, role, name, target, supplier_id, plan, created_at, updated_at)
		VALUES ($1, 'own88021', 'own88021@example.invalid', 'x', 'user', 'Owner', '/workspace', '', 'free', clock_timestamp(), clock_timestamp()),
		       ($2, 'adm88022', 'adm88022@example.invalid', 'x', 'super_admin', 'Admin', '/workspace', '', 'free', clock_timestamp(), clock_timestamp())`,
		ownerID, adminID); err != nil {
		t.Fatal(err)
	}
	var orgID int64
	var orgUUID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO organizations (owner_user_id, name, plan, created_at, updated_at)
		VALUES ($1, 'org-88021', 'free', clock_timestamp(), clock_timestamp())
		RETURNING id, uuid::text`, ownerID).Scan(&orgID, &orgUUID); err != nil {
		t.Fatal(err)
	}
	token := "admin-b-session-token"
	hash := domain.SessionHash(token)
	if _, err := pool.Exec(ctx, `
		INSERT INTO account_sessions (token_hash, user_id, expires_at, admin_step_up_until)
		VALUES ($1, $2, clock_timestamp() + interval '1 day', clock_timestamp() + interval '10 minutes')`, hash, adminID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO account_admin_totp (user_id, secret_nonce, secret_ciphertext, confirmed_at)
		VALUES ($1, decode('00112233445566778899aabb', 'hex'), decode('00112233445566778899aabbccddeeff00', 'hex'), clock_timestamp())`, adminID); err != nil {
		t.Fatal(err)
	}
	seedMatchingLease(t, ctx, pool, "entitlement", "admin billing test")
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM writer_leases WHERE domain = 'entitlement' AND grant_reason = 'admin billing test'`)
	})
	if _, err := pool.Exec(ctx, `
		INSERT INTO payment_orders
		       (public_id, org_id, plan, months, amount_cents, currency, provider, status,
		        created_by_user_id, created_at, updated_at, product, topup_microfen, credit_cents)
		VALUES ('ord-88021', $1, 'free', 1, 100, 'CNY', 'manual', 'pending',
		        $2, clock_timestamp(), clock_timestamp(), 'wallet_topup', 1000000, 0)`, orgID, ownerID); err != nil {
		t.Fatal(err)
	}

	repo := struct {
		*adminrepo.Repo
		*adminbillingrepo.Entitlement
		*observerepo.Observe
	}{adminrepo.NewBilling(pool, "integration-test-key-0123456789abcdef"), adminbillingrepo.NewEntitlement(pool), observerepo.NewObserve(pool, func(context.Context, string) (int, []byte, error) {
		t.Fatal("thumbnail dial")
		return 0, nil, nil
	})}
	router := chi.NewRouter()
	adminhttp.Mount(router, adminhttp.Deps{
		AdminB: repo,
		Resolve: func(r *http.Request) (*adminhttp.Session, *adminhttp.Refusal, error) {
			if r.Header.Get("Authorization") == "" {
				return nil, nil, nil
			}
			return &adminhttp.Session{UserID: adminID, OrgID: orgID, PlatformRole: "super_admin"}, nil, nil
		},
	})
	status, body := adminDo(router, http.MethodGet, "/api/admin/plans", token, "")
	if status != 200 || !strings.Contains(body, `"key":"lite"`) {
		t.Fatalf("plans %d %s", status, body)
	}
	var audits int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs WHERE action = 'plans_listed'`).Scan(&audits); err != nil || audits != 1 {
		t.Fatal(audits, err)
	}
	status, body = adminDo(router, http.MethodPut, "/api/admin/orders/ord-88021/confirm", token, "")
	if status != 200 || !strings.Contains(body, `"status":"paid"`) {
		t.Fatalf("confirm %d %s", status, body)
	}
	status, body = adminDo(router, http.MethodPut, "/api/admin/orders/ord-88021/confirm", token, "")
	if status != 409 || !strings.Contains(body, "订单已处理") {
		t.Fatalf("second confirm %d %s", status, body)
	}
	t.Run("retired seat orders are rejected", func(t *testing.T) {
		_, err := pool.Exec(ctx, `
			INSERT INTO payment_orders
			    (public_id, org_id, plan, months, amount_cents, currency, provider, status,
			     created_by_user_id, created_at, updated_at, product, member_seats,
			     list_unit_month_cents, unit_month_cents, duration_days)
			VALUES ('ord-retired-seats', $1, 'pro', 1, 100, 'CNY', 'manual', 'pending',
			        $2, clock_timestamp(), clock_timestamp(), 'member_seats', 1, 100, 100, 30)`, orgID, ownerID)
		var constraint *pgconn.PgError
		if !errors.As(err, &constraint) || constraint.Code != "23514" || constraint.ConstraintName != "payment_orders_product_shape" {
			t.Fatalf("retired seat order: %v", err)
		}
	})
	var ledger int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM wallet_ledger WHERE payment_order_id IS NOT NULL AND entry_type = 'topup'`).Scan(&ledger); err != nil || ledger != 1 {
		t.Fatal(ledger, err)
	}

	status, body = adminDo(router, http.MethodPost, "/api/admin/workspaces/"+orgUUID+"/wallet/topups", token,
		`{"operation_id":"grant-1","amount_cents":100,"note":"试用"}`)
	if status != 200 || !strings.Contains(body, `"id":"grant-1"`) {
		t.Fatalf("grant %d %s", status, body)
	}
	status, _ = adminDo(router, http.MethodPost, "/api/admin/workspaces/"+orgUUID+"/wallet/topups", token,
		`{"operation_id":"grant-1","amount_cents":100,"note":"试用"}`)
	if status != 200 {
		t.Fatal(status)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM wallet_ledger WHERE idempotency_key = 'manual:grant-1'`).Scan(&ledger); err != nil || ledger != 1 {
		t.Fatal("replay", ledger, err)
	}
	status, body = adminDo(router, http.MethodPost, "/api/admin/workspaces/"+orgUUID+"/wallet/topups/grant-1/revoke", token, "")
	if status != 200 || strings.Contains(body, `"id":"grant-1"`) {
		t.Fatalf("revoke %d %s", status, body)
	}

	seedMatchingLease(t, ctx, pool, "admin", "admin billing redeem")
	status, body = adminDo(router, http.MethodPost, "/api/admin/redeem-codes", token,
		`{"product":"wallet_credits","member_seats":0,"quantity":1,"duration_days":30,"wallet_cents":100}`)
	if status != 201 || !strings.Contains(body, "POD-WALLET-") {
		t.Fatalf("redeem %d %s", status, body)
	}
	var created struct {
		Data struct {
			Codes []struct {
				ID int64 `json:"id"`
			} `json:"codes"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(body), &created); err != nil || len(created.Data.Codes) != 1 {
		t.Fatal(err, body)
	}
	status, body = adminDo(router, http.MethodGet, "/api/admin/payment/config", token, "")
	if status != 200 || strings.Contains(body, "privateKey") && strings.Contains(body, "BEGIN") {
		t.Fatalf("payment %d %s", status, body)
	}
	if !strings.Contains(body, `"revision":0`) {
		t.Fatal(body)
	}

	const ownerB int64 = 88023
	if _, err := pool.Exec(ctx, `
		INSERT INTO account_users (id, public_id, email, password_hash, role, name, target, supplier_id, plan, created_at, updated_at)
		VALUES ($1, 'own88023', 'own88023@example.invalid', 'x', 'user', 'Other', '/workspace', '', 'free', clock_timestamp(), clock_timestamp())`, ownerB); err != nil {
		t.Fatal(err)
	}
	var orgB int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO organizations (owner_user_id, name, plan, created_at, updated_at)
		VALUES ($1, 'org-88023', 'free', clock_timestamp(), clock_timestamp()) RETURNING id`, ownerB).Scan(&orgB); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO user_wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, ownerB); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO store_product_sync (org_id, store_id, refresh_generation)
		VALUES ($1, gen_random_uuid(), 1)`, orgID); err != nil {
		t.Fatal(err)
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('role', $1, true)`, tenantx.RoleApp); err != nil {
		t.Fatal(err)
	}
	var seen int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM user_wallets`).Scan(&seen); err != nil {
		t.Fatal(err)
	}
	if seen != 0 {
		t.Fatalf("missing wallet guc saw %d rows", seen)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.current_wallet_user_id', $1, true), set_config($2, $3, true)`,
		"88021", tenantx.GUCCurrentOrgID, "1"); err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM user_wallets WHERE user_id = $1`, ownerB).Scan(&seen); err != nil {
		t.Fatal(err)
	}
	if seen != 0 {
		t.Fatalf("cross-owner wallet saw %d rows", seen)
	}
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM user_wallets WHERE user_id = $1`, ownerID).Scan(&seen); err != nil || seen != 1 {
		t.Fatalf("own wallet %d %v", seen, err)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.current_wallet_user_id', '', true), set_config('app.platform_observer_id', '', true), set_config($1, '', true)`, tenantx.GUCCurrentOrgID); err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM store_product_sync`).Scan(&seen); err != nil {
		t.Fatal(err)
	}
	if seen != 0 {
		t.Fatalf("observation without observer saw %d", seen)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.platform_observer_id', $1, true)`, "88022"); err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM store_product_sync`).Scan(&seen); err != nil || seen != 1 {
		t.Fatalf("observer sync %d %v", seen, err)
	}
	_ = orgB

	status, body = adminDo(router, http.MethodGet, "/api/admin/ops/scopes", token, "")
	if status != 200 || !strings.Contains(body, orgUUID) {
		t.Fatalf("scopes %d %s", status, body)
	}
	status, body = adminDo(router, http.MethodGet, "/api/admin/error-logs", token, "")
	if status != 200 || !strings.Contains(body, `"rows"`) {
		t.Fatalf("errors %d %s", status, body)
	}
}

func adminDo(handler http.Handler, method, path, token, body string) (int, string) {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec.Code, rec.Body.String()
}

func itoa(id int64) string {
	return strings.TrimPrefix(strings.ReplaceAll(strings.Replace(jsonNumber(id), "", "", 1), " ", ""), "+")
}

func jsonNumber(id int64) string {
	raw, _ := json.Marshal(id)
	return string(raw)
}
