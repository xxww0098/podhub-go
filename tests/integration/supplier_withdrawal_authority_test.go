package integration

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	adminhttp "github.com/xxww0098/podhub-go/internal/admin/http"
	adminrepo "github.com/xxww0098/podhub-go/internal/admin/repo"
	adminservice "github.com/xxww0098/podhub-go/internal/admin/service"
	adminsupplier "github.com/xxww0098/podhub-go/internal/admin/supplier/repo"
	x1repo "github.com/xxww0098/podhub-go/internal/admin/x1/repo"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

type withdrawalAuthorityStore struct {
	adminrepo.Repo
	adminsupplier.Portal
	x1repo.X1
}

func TestSupplierWithdrawalRechecksAuthorityAfterLockWait(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	seedMatchingLease(t, ctx, pool, "admin", "synthetic withdrawal authority race")
	svc := adminservice.New(withdrawalAuthorityStore{
		Repo:   adminrepo.New(pool, tenantx.BeginApp),
		Portal: adminsupplier.Portal{Pool: pool, Begin: tenantx.BeginApp},
		X1:     x1repo.NewX1(pool, tenantx.BeginApp),
	})
	for _, role := range []string{"admin", "super_admin"} {
		for _, action := range []string{"pay", "reject"} {
			for _, change := range []string{"downgraded", "disabled", "unchanged"} {
				t.Run(role+"/"+action+"/"+change, func(t *testing.T) {
					user, source, withdrawal := seedWithdrawalAuthority(t, ctx, pool, role)
					router := chi.NewRouter()
					adminhttp.Mount(router, adminhttp.Deps{
						Supplier: &svc,
						Resolve: func(*http.Request) (*adminhttp.Session, *adminhttp.Refusal, error) {
							return &adminhttp.Session{UserID: user, PlatformRole: role}, nil, nil
						},
					})
					tx, err := pool.Begin(ctx)
					if err != nil {
						t.Fatal(err)
					}
					defer tx.Rollback(ctx)
					var blocker int
					if err := tx.QueryRow(ctx, `SELECT pg_backend_pid() FROM supplier_withdrawals WHERE withdrawal_id=$1::uuid FOR UPDATE`, withdrawal).Scan(&blocker); err != nil {
						t.Fatal(err)
					}
					done := make(chan *httptest.ResponseRecorder, 1)
					go func() {
						body := `{"reference":"synthetic-payment"}`
						if action == "reject" {
							body = `{"reason":"synthetic rejection"}`
						}
						req := httptest.NewRequest(http.MethodPost, "/api/admin/supplier-withdrawals/"+withdrawal+"/"+action, strings.NewReader(body)).WithContext(ctx)
						req.Header.Set("Content-Type", "application/json")
						rec := httptest.NewRecorder()
						router.ServeHTTP(rec, req)
						done <- rec
					}()
					waitWithdrawalAuthorityBlocked(t, ctx, pool, blocker, done)
					switch change {
					case "downgraded":
						_, err = tx.Exec(ctx, `UPDATE account_users SET role='user' WHERE id=$1`, user)
					case "disabled":
						_, err = tx.Exec(ctx, `UPDATE account_users SET disabled_at=clock_timestamp() WHERE id=$1`, user)
					}
					if err != nil {
						t.Fatal(err)
					}
					if err := tx.Commit(ctx); err != nil {
						t.Fatal(err)
					}
					wantStatus := http.StatusForbidden
					if change == "unchanged" {
						wantStatus = http.StatusOK
					}
					select {
					case rec := <-done:
						if rec.Code != wantStatus {
							t.Errorf("withdrawal decision after %s: status=%d want=%d body=%s", change, rec.Code, wantStatus, rec.Body.String())
						}
					case <-ctx.Done():
						t.Fatal(ctx.Err())
					}
					wantBalance, wantHeld, wantWrites := int64(2000000), int64(1000000), 0
					wantState := "requested"
					if change == "unchanged" {
						wantHeld, wantWrites, wantState = 0, 1, "rejected"
						if action == "pay" {
							wantBalance, wantState = 1000000, "paid"
						}
					}
					var balance, held int64
					var state string
					var ledger, audits, decisions int
					if err := pool.QueryRow(ctx, `SELECT sw.balance_microfen,sw.held_microfen,w.status,
 (SELECT count(*) FROM supplier_wallet_ledger WHERE source_id=$1),
 (SELECT count(*) FROM audit_logs WHERE entity_type='supplier_withdrawal' AND entity_id=$2),
 (SELECT count(*) FROM supplier_withdrawals WHERE withdrawal_id=$2::uuid AND (reference IS NOT NULL OR reject_reason IS NOT NULL OR decided_at_ms IS NOT NULL))
 FROM supplier_wallets sw JOIN supplier_withdrawals w USING(source_id)
 WHERE sw.source_id=$1 AND w.withdrawal_id=$2::uuid`, source, withdrawal).Scan(&balance, &held, &state, &ledger, &audits, &decisions); err != nil {
						t.Fatal(err)
					}
					if balance != wantBalance || held != wantHeld || state != wantState || ledger != wantWrites || audits != wantWrites || decisions != wantWrites {
						t.Errorf("withdrawal state after %s: wallet=%d/%d state=%s ledger=%d audits=%d decisions=%d; want wallet=%d/%d state=%s writes=%d", change, balance, held, state, ledger, audits, decisions, wantBalance, wantHeld, wantState, wantWrites)
					}
				})
			}
		}
	}
}

func seedWithdrawalAuthority(t *testing.T, ctx context.Context, pool *pgxpool.Pool, role string) (int64, string, string) {
	t.Helper()
	publicID, source := uuid.NewString(), "src_withdrawal_"+uuid.NewString()
	var user int64
	if err := pool.QueryRow(ctx, `INSERT INTO account_users(public_id,email,password_hash,role,name,created_at,updated_at)
 VALUES($1,$2,'synthetic',$3,'Withdrawal authority',clock_timestamp(),clock_timestamp()) RETURNING id`, publicID, publicID+"@example.invalid", role).Scan(&user); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(ctx, `UPDATE account_users SET role='user' WHERE id=$1`, user); err != nil {
			t.Error(err)
		}
	})
	if _, err := pool.Exec(ctx, `INSERT INTO sc_sources(source_id,name,listed,created_at_ms,updated_at_ms) VALUES($1,$1,true,1,1)`, source); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO supplier_wallets(source_id,balance_microfen,held_microfen,updated_at_ms) VALUES($1,2000000,1000000,1)`, source); err != nil {
		t.Fatal(err)
	}
	var withdrawal string
	if err := pool.QueryRow(ctx, `INSERT INTO supplier_withdrawals(source_id,amount_cents,amount_microfen,channel,account,real_name,status,requested_at_ms)
 VALUES($1,1,1000000,'alipay','synthetic-account','Synthetic','requested',1) RETURNING withdrawal_id::text`, source).Scan(&withdrawal); err != nil {
		t.Fatal(err)
	}
	return user, source, withdrawal
}

func waitWithdrawalAuthorityBlocked(t *testing.T, ctx context.Context, pool *pgxpool.Pool, blocker int, done <-chan *httptest.ResponseRecorder) {
	t.Helper()
	wait, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	for {
		var blocked bool
		if err := pool.QueryRow(wait, `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%FROM supplier_withdrawals%' AND query LIKE '%FOR UPDATE%')`, blocker).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			return
		}
		select {
		case rec := <-done:
			t.Fatalf("withdrawal returned before the lock wait: status=%d body=%s", rec.Code, rec.Body.String())
		case <-wait.Done():
			t.Fatal("withdrawal decision did not reach the locked withdrawal")
		case <-time.After(10 * time.Millisecond):
		}
	}
}
