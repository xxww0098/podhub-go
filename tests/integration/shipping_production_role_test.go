package integration

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"

	"github.com/xxww0098/podhub-go/internal/app"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
	seller "github.com/xxww0098/podhub-go/internal/seller/ozon"
	shippingrepo "github.com/xxww0098/podhub-go/internal/shipping/repo"
	shippingsvc "github.com/xxww0098/podhub-go/internal/shipping/service"
)

// The old shipping admin routes were removed. Test the existing HTTP auth
// gate and the retained shipping service separately, without remounting them.
func TestShippingProductionRoleComponents(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	t.Setenv("PODHUB_PARITY_DSN", "")
	dsn := securityDSN(t, ctx)
	t.Setenv("PODHUB_PARITY_DSN", dsn)
	t.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "1")
	_, fixture, _, store, preset := shippingReconcileFixture(t)
	const userID int64 = 97731
	const password = "shipping-role-password"
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.Exec(ctx, `UPDATE account_users SET role='super_admin',password_hash=$2 WHERE id=$1`, userID, string(hash)); err != nil {
		t.Fatal(err)
	}

	var reads, writes atomic.Int32
	var listMode atomic.Int32
	var pathsMu sync.Mutex
	paths := map[string]int{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		pathsMu.Lock()
		paths[r.URL.Path]++
		pathsMu.Unlock()
		if r.Method != http.MethodPost || r.Header.Get("Client-Id") != "shipping-client" || r.Header.Get("Api-Key") != "shipping-fixture-key" {
			t.Error("shipping did not send the registered credential through the HTTP egress")
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v2/warehouse/list":
			reads.Add(1)
			if listMode.Load() == 1 {
				_, _ = io.WriteString(w, `{"warehouses":[{"warehouse_id":11,"name":"wanted"}],"has_next":false}`)
			} else {
				_, _ = io.WriteString(w, `{"warehouses":[],"has_next":false}`)
			}
		case "/v1/warehouse/erfbs/aggregator/create":
			writes.Add(1)
			_, _ = io.WriteString(w, `{"operation_id":"local-operation"}`)
		case "/v1/warehouse/operation/status":
			reads.Add(1)
			_, _ = io.WriteString(w, `{"status":"SUCCESS","result":{"warehouse_id":11}}`)
		case "/v2/delivery-method/list":
			reads.Add(1)
			_, _ = io.WriteString(w, `{"delivery_methods":[{"id":22,"name":"Express","status":"ACTIVE","warehouse_id":11,"is_express":true}]}`)
		default:
			t.Errorf("unexpected shipping upstream path %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(upstream.Close)
	t.Setenv("CLOUD_SELLER_BASE_URL", upstream.URL+"/")
	t.Setenv("CLOUD_SELLER_CREDENTIAL_KEY", "shipping-reconcile-fixture")
	t.Setenv("CLOUD_SELLER_CREDENTIAL_KEY_ID", seal.DefaultSellerKeyID)
	t.Setenv("CLOUD_SELLER_CREDENTIAL_KEY_PREVIOUS", "")
	t.Setenv("CLOUD_COOKIE_SECURE", "0")
	t.Setenv("OZON_WRITE_KILL_SWITCH", "0")
	t.Setenv("SHIPPING_INJECT_OZON_WRITES", "1")
	login := postJSON(t, app.Handler(fixture), "/api/auth/login", `{"email":"shipping-credential@store.example.invalid","password":"`+password+`"}`, "shipping-role-login", "")
	if login.Code != http.StatusOK {
		t.Fatalf("fixture session issuance: %d %s", login.Code, login.Body.String())
	}
	cookie := sessionCookie(login)
	if _, err := fixture.Exec(ctx, `ALTER ROLE podhub_login_api PASSWORD 'isolated-shipping-login'`); err != nil {
		t.Fatal(err)
	}
	apiDSN, err := url.Parse(swapUser(dsn, "podhub_login_api", "isolated-shipping-login"))
	if err != nil {
		t.Fatal(err)
	}
	query := apiDSN.Query()
	query.Set("pool_max_conns", "1")
	apiDSN.RawQuery = query.Encode()
	t.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "")
	apiPool, err := db.Connect(ctx, config.Config{DatabaseURL: apiDSN.String()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(apiPool.Close)
	assertShippingLoginRole(t, ctx, apiPool)
	if _, err := apiPool.Exec(ctx, `SELECT id FROM shipping_shop_injections LIMIT 1`); err == nil {
		t.Fatal("NOINHERIT login unexpectedly has direct shipping table access")
	} else if pg, ok := err.(*pgconn.PgError); !ok || pg.Code != "42501" {
		t.Fatalf("expected direct-query permission denial, got %v", err)
	}
	server := httptest.NewServer(app.Handler(apiPool))
	t.Cleanup(server.Close)
	request := func(path, sid string) (int, string) {
		t.Helper()
		r, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		if sid != "" {
			r.Header.Set("Cookie", sid)
		}
		response, err := server.Client().Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		body, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		return response.StatusCode, string(body)
	}

	t.Run("existing admin HTTP gate", func(t *testing.T) {
		path := "/api/admin/agents?flagged=invalid"
		status, body := request(path, "")
		if status != http.StatusUnauthorized {
			t.Fatalf("anonymous admin gate: %d %s", status, body)
		}
		status, body = request(path, cookie)
		if status != http.StatusBadRequest || !strings.Contains(body, `"code":"VALIDATION"`) {
			t.Fatalf("real super-admin session did not reach route validation: %d %s", status, body)
		}
		if _, err := fixture.Exec(ctx, `UPDATE account_users SET disabled_at=clock_timestamp() WHERE id=$1`, userID); err != nil {
			t.Fatal(err)
		}
		status, body = request(path, cookie)
		if status != http.StatusUnauthorized {
			t.Fatalf("disabled account passed real authentication: %d %s", status, body)
		}
		if _, err := fixture.Exec(ctx, `UPDATE account_users SET disabled_at=NULL WHERE id=$1`, userID); err != nil {
			t.Fatal(err)
		}
		assertShippingLoginRole(t, ctx, apiPool)
	})

	t.Run("removed shipping routes stay unavailable", func(t *testing.T) {
		for _, action := range []string{"reconcile", "safe-continue"} {
			r, err := http.NewRequestWithContext(ctx, http.MethodPost, server.URL+"/api/admin/shipping-injections/"+store+"/"+preset+"/"+action, nil)
			if err != nil {
				t.Fatal(err)
			}
			r.Header.Set("Cookie", cookie)
			response, err := server.Client().Do(r)
			if err != nil {
				t.Fatal(err)
			}
			_ = response.Body.Close()
			if response.StatusCode != http.StatusNotFound {
				t.Fatalf("removed shipping %s route returned %d", action, response.StatusCode)
			}
		}
		if reads.Load() != 0 || writes.Load() != 0 {
			t.Fatal("removed HTTP routes made an upstream request")
		}
	})

	t.Run("shipping service uses real HTTP and production role", func(t *testing.T) {
		cfg := config.Load()
		egress := seller.New(cfg).WithPool(apiPool)
		service := shippingsvc.Admin{
			Store: shippingrepo.Repo{Pool: apiPool, Ring: seal.Ring{Primary: seal.DeriveKEK(cfg.SellerCredentialKey)}, KeyReady: true, KeyID: cfg.SellerCredentialKeyID},
			Ozon: shippingRead(func(ctx context.Context, path string, body []byte, write bool, clientID, apiKey string) (int, []byte, error) {
				reply, err := egress.Call(ctx, http.MethodPost, path, body, write, true, clientID, apiKey)
				if err != nil {
					t.Errorf("formal shipping egress %s failed: %v", path, err)
				}
				return reply.Status, []byte(reply.Body), err
			}),
			InjectWrites: cfg.ShippingInjectOzonWrites(), OzonWritesDisabled: cfg.OzonWritesDisabled(),
		}
		now := time.Now().UnixMilli()
		if _, err := service.Reconcile(ctx, store, preset, now); err != nil {
			t.Fatalf("production role reconcile failed before/after local HTTP: %v (reads=%d)", err, reads.Load())
		}
		var status string
		var absent, warehouse, delivery *int64
		if err := fixture.QueryRow(ctx, `SELECT status,remote_absent_at_ms,warehouse_id,delivery_method_id FROM shipping_shop_injections WHERE store_uuid=$1::uuid AND preset_id=$2`, store, preset).Scan(&status, &absent, &warehouse, &delivery); err != nil || status != "unknown" || absent == nil || *absent != now {
			t.Fatalf("complete read did not persist absence: status=%s absent=%v err=%v", status, absent, err)
		}
		assertShippingLoginRole(t, ctx, apiPool)
		if _, err := service.SafeContinue(ctx, store, preset, "stshipping-credential", now+1); err != nil {
			t.Fatalf("production role safe-continue failed: %v", err)
		}
		if err := fixture.QueryRow(ctx, `SELECT status,remote_absent_at_ms,warehouse_id,delivery_method_id FROM shipping_shop_injections WHERE store_uuid=$1::uuid AND preset_id=$2`, store, preset).Scan(&status, &absent, &warehouse, &delivery); err != nil || status != "succeeded" || absent != nil || warehouse == nil || *warehouse != 11 || delivery == nil || *delivery != 22 {
			t.Fatalf("local receipt/readback was not persisted: status=%s warehouse=%v delivery=%v err=%v", status, warehouse, delivery, err)
		}
		var operations int
		if err := fixture.QueryRow(ctx, `SELECT count(*) FROM shipping_inject_operations WHERE store_uuid=$1::uuid AND preset_id=$2 AND status='succeeded' AND phase='verify' AND ozon_operation_id='local-operation'`, store, preset).Scan(&operations); err != nil || operations != 1 || writes.Load() != 1 {
			t.Fatalf("local operation did not settle once: operations=%d writes=%d err=%v", operations, writes.Load(), err)
		}
		listMode.Store(1)
		if _, err := service.Reconcile(ctx, store, preset, now+2); err != nil {
			t.Fatalf("existing warehouse reconciliation failed: %v", err)
		}
		var budgets int
		if err := fixture.QueryRow(ctx, `SELECT count(*) FROM lease_budget`).Scan(&budgets); err != nil || budgets == 0 {
			t.Fatalf("formal egress skipped its persistent budget: count=%d err=%v", budgets, err)
		}
		assertShippingLoginRole(t, ctx, apiPool)
		pathsMu.Lock()
		defer pathsMu.Unlock()
		for _, path := range []string{"/v2/warehouse/list", "/v1/warehouse/erfbs/aggregator/create", "/v1/warehouse/operation/status", "/v2/delivery-method/list"} {
			if paths[path] == 0 {
				t.Errorf("local HTTP path not exercised: %s", path)
			}
		}
	})
}

func assertShippingLoginRole(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	var current, session, org, staff string
	var super, inherit, bypass bool
	if err := pool.QueryRow(ctx, `SELECT current_user,session_user,rolsuper,rolinherit,rolbypassrls,COALESCE(current_setting('app.current_org_id',true),''),COALESCE(current_setting('app.staff_access',true),'') FROM pg_roles WHERE rolname=current_user`).Scan(&current, &session, &super, &inherit, &bypass, &org, &staff); err != nil {
		t.Fatal(err)
	}
	if current != "podhub_login_api" || session != current || super || inherit || bypass || org != "" || staff != "" {
		t.Fatalf("unsafe or leaked database session: current=%s session=%s super=%v inherit=%v bypass=%v org=%q staff=%q", current, session, super, inherit, bypass, org, staff)
	}
}
