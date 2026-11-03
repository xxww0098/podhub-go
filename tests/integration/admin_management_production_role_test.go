package integration

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/platform/db"
)

func TestAdminManagementProductionRole(t *testing.T) {
	t.Setenv("CLOUD_INTEGRATION_CONFIG_KEY", "management-test-key-at-least-thirty-two-bytes")
	f := newAdminContentFixture(t)
	assertClean := func() {
		t.Helper()
		f.assertClean(t)
		var observer string
		if err := f.runtime.QueryRow(f.ctx, `SELECT COALESCE(current_setting('app.platform_observer_id',true),'')`).Scan(&observer); err != nil || observer != "" {
			t.Fatalf("leaked platform observer=%q err=%v", observer, err)
		}
	}
	var publicID string
	if err := f.fixture.QueryRow(f.ctx, `SELECT u.public_id FROM account_users u WHERE u.id=96312`).Scan(&publicID); err != nil {
		t.Fatal(err)
	}
	f.want(t, http.MethodPost, "/api/admin/users/"+publicID+"/seats", `{"seats":null}`, f.admin, http.StatusOK)
	assertClean()
	for _, user := range []int64{96311, 96312} {
		var org int64
		if err := f.fixture.QueryRow(f.ctx, `SELECT id FROM organizations WHERE owner_user_id=$1`, user).Scan(&org); err != nil {
			t.Fatal(err)
		}
		if _, err := f.fixture.Exec(f.ctx, `INSERT INTO ai_requests(public_id,org_id,user_id,idempotency_key,model,upstream_account_id,status) VALUES($1,$2,$3,$1,'management-model','fixture','failed')`, fmt.Sprintf("management-ai-%d", user), org, user); err != nil {
			t.Fatal(err)
		}
		if _, err := f.fixture.Exec(f.ctx, `INSERT INTO payment_orders(public_id,org_id,plan,months,amount_cents,currency,provider,status,created_by_user_id,created_at,updated_at,product,topup_microfen) VALUES($1,$2,'free',1,100,'CNY','manual','pending',$3,clock_timestamp(),clock_timestamp(),'wallet_topup',1000000)`, fmt.Sprintf("management-order-%d", user), org, user); err != nil {
			t.Fatal(err)
		}
	}
	for _, path := range []string{"/api/admin/redeem-codes", "/api/admin/plans", "/api/admin/orders", "/api/admin/ai-requests", "/api/admin/ai-requests/summary", "/api/admin/error-logs", "/api/admin/payment/config"} {
		f.want(t, http.MethodGet, path, "", f.user, http.StatusForbidden)
		raw := f.want(t, http.MethodGet, path, "", f.admin, http.StatusOK)
		if strings.Contains(path, "ai-requests") && !strings.Contains(string(raw), `"total_rows":2`) {
			t.Fatalf("cross-tenant AI ledger missing rows: %s", raw)
		}
		if path == "/api/admin/orders" && (!strings.Contains(string(raw), "management-order-96311") || !strings.Contains(string(raw), "management-order-96312")) {
			t.Fatalf("cross-tenant orders missing rows: %s", raw)
		}
		assertClean()
	}
	const payment = `{"expectedRevision":0,"providers":[{"provider":"stripe","enabled":false,"values":{"currency":"usd"}}]}`
	f.want(t, http.MethodPut, "/api/admin/payment/config", payment, f.user, http.StatusForbidden)
	f.want(t, http.MethodPut, "/api/admin/payment/config", payment, f.admin, http.StatusOK)
	storedPayment := f.want(t, http.MethodGet, "/api/admin/payment/config", "", f.admin, http.StatusOK)
	if !strings.Contains(string(storedPayment), `"currency":"usd"`) || !strings.Contains(string(storedPayment), `"revision":1`) {
		t.Fatalf("payment configuration not persisted: %s", storedPayment)
	}
	f.want(t, http.MethodPut, "/api/admin/payment/config", payment, f.admin, http.StatusConflict)
	assertClean()
	created := f.want(t, http.MethodPost, "/api/admin/redeem-codes", `{"quantity":1,"wallet_cents":100,"note":"management role regression"}`, f.admin, http.StatusCreated)
	var codes struct {
		Data struct {
			Codes []struct {
				ID int64 `json:"id"`
			} `json:"codes"`
		} `json:"data"`
	}
	if err := json.Unmarshal(created, &codes); err != nil || len(codes.Data.Codes) != 1 {
		t.Fatalf("created codes: %s %v", created, err)
	}
	path := fmt.Sprintf("/api/admin/redeem-codes/%d", codes.Data.Codes[0].ID)
	listed := f.want(t, http.MethodGet, "/api/admin/redeem-codes", "", f.admin, http.StatusOK)
	if !strings.Contains(string(listed), "management role regression") {
		t.Fatalf("created code missing from refreshed list: %s", listed)
	}
	f.want(t, http.MethodDelete, path, "", f.admin, http.StatusOK)
	listed = f.want(t, http.MethodGet, "/api/admin/redeem-codes", "", f.admin, http.StatusOK)
	if strings.Contains(string(listed), "management role regression") {
		t.Fatalf("deleted code survived refresh: %s", listed)
	}
	f.exec(t, `INSERT INTO event_inbox_events(device_uid,id,org_id,user_id,kind,payload_json,client_created_at,received_at) VALUES('management-device','management-error',$1,96311,'desktop_error_log.v1','{"code":"management_error","source":"host_uncaught","message":"management regression"}','now',clock_timestamp())`, f.org)
	seedMatchingLease(t, f.ctx, f.fixture, "telemetry", "management error deletion")
	logs := f.want(t, http.MethodGet, "/api/admin/error-logs?q=management-error", "", f.admin, http.StatusOK)
	if !strings.Contains(string(logs), "management-error") {
		t.Fatalf("persisted diagnostic missing: %s", logs)
	}
	f.want(t, http.MethodDelete, "/api/admin/error-logs", `{"events":[{"event_id":"management-error","device_uid":"management-device"}]}`, f.admin, http.StatusOK)
	logs = f.want(t, http.MethodGet, "/api/admin/error-logs?q=management-error", "", f.admin, http.StatusOK)
	if !strings.Contains(string(logs), `"total_rows":0`) {
		t.Fatalf("deleted diagnostic survived refresh: %s", logs)
	}
	assertClean()
	for _, state := range []string{"role='user'", "role='super_admin', disabled_at=clock_timestamp()"} {
		f.exec(t, "UPDATE account_users SET "+state+" WHERE id=96311")
		for _, table := range []string{"ai_requests", "payment_orders", "redeem_codes"} {
			var rows int
			err := db.InTx(f.ctx, f.runtime, db.Observer(96311), func(tx pgx.Tx) error {
				return tx.QueryRow(f.ctx, "SELECT count(*) FROM "+table).Scan(&rows)
			})
			if err != nil || rows != 0 {
				t.Fatalf("revoked observer saw %s: %d %v", table, rows, err)
			}
		}
		assertClean()
	}
	f.exec(t, "UPDATE account_users SET role='super_admin',disabled_at=NULL WHERE id=96311")
}
