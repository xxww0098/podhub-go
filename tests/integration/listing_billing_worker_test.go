package integration

import (
	"context"
	"net/url"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	billingrepo "github.com/xxww0098/podhub-go/internal/billing/repo"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
)

func TestListingBillingWorkerRole(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	t.Setenv("PODHUB_PARITY_DSN", "")
	dsn := securityDSN(t, ctx)
	t.Setenv("PODHUB_PARITY_DSN", dsn)
	fixture := migratedPool(t, ctx)
	org, _, store, user := seedGapTenant(t, ctx, fixture, 97022)
	if _, err := fixture.Exec(ctx, `ALTER ROLE podhub_login_listing_worker PASSWORD 'isolated-listing-billing'`); err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(swapUser(dsn, "podhub_login_listing_worker", "isolated-listing-billing"))
	if err != nil {
		t.Fatal(err)
	}
	query := u.Query()
	query.Set("pool_max_conns", "1")
	u.RawQuery = query.Encode()
	t.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "")
	worker, err := db.Connect(ctx, config.Config{DatabaseURL: u.String()})
	if err != nil {
		t.Fatal(err)
	}
	defer worker.Close()
	assertLogin := func() {
		t.Helper()
		var current, session, tenant string
		var super, inherit, bypass bool
		if err := worker.QueryRow(ctx, `SELECT current_user,session_user,COALESCE(current_setting('app.current_org_id',true),''),rolsuper,rolinherit,rolbypassrls FROM pg_roles WHERE rolname=current_user`).Scan(&current, &session, &tenant, &super, &inherit, &bypass); err != nil {
			t.Fatal(err)
		}
		if current != "podhub_login_listing_worker" || session != current || tenant != "" || super || inherit || bypass {
			t.Fatalf("worker role leaked: current=%s session=%s tenant=%s super=%v inherit=%v bypass=%v", current, session, tenant, super, inherit, bypass)
		}
		if _, err := worker.Exec(ctx, `SELECT id FROM jobs LIMIT 1`); err == nil {
			t.Fatal("NOINHERIT worker gained direct jobs access")
		} else if pg, ok := err.(*pgconn.PgError); !ok || pg.Code != "42501" {
			t.Fatalf("expected direct-query permission denial: %v", err)
		}
	}
	assertLogin()
	testListingLedger(t, ctx, fixture, worker, org, user, store)
	assertLogin()
	var balance, held int64
	if err := fixture.QueryRow(ctx, `SELECT balance_microfen,held_microfen FROM workspace_wallets WHERE org_id=$1`, org).Scan(&balance, &held); err != nil || balance != 9900 || held != 0 {
		t.Fatalf("worker charge/refund balance=%d held=%d err=%v", balance, held, err)
	}

	var job string
	if err := fixture.QueryRow(ctx, `SELECT id::text FROM jobs WHERE org_id=$1 AND state='succeeded'`, org).Scan(&job); err != nil {
		t.Fatal(err)
	}
	if err := billingrepo.SettleListingJob(ctx, worker, org+1, job); err != nil {
		t.Fatal(err)
	}
	if err := db.InTx(ctx, worker, db.App(org+1), func(tx pgx.Tx) error {
		var visible int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM jobs WHERE id=$1::uuid`, job).Scan(&visible); err != nil {
			return err
		}
		if visible != 0 {
			t.Fatal("billing transaction exposed another workspace's job")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	t.Setenv("CLOUD_LISTING_SUBMIT_PRICE_MICROFEN", "0")
	free := uuid.NewString()
	if _, err := fixture.Exec(ctx, `INSERT INTO jobs(id,org_id,kind,aggregate_type,aggregate_id,input_revision,idempotency_key,state,payload,result_ref,lane,submitter_user_id) VALUES($1::uuid,$2,'listing.submit.batch','listing_row',gen_random_uuid(),1,$1,'succeeded','{}','{"taskId":"88"}','listing.submit',$3)`, free, org, user); err != nil {
		t.Fatal(err)
	}
	if err := billingrepo.SettleListingJob(ctx, worker, org, free); err != nil {
		t.Fatal(err)
	}
	var charges int
	if err := fixture.QueryRow(ctx, `SELECT count(*) FROM wallet_ledger WHERE org_id=$1 AND idempotency_key=$2`, org, free).Scan(&charges); err != nil || charges != 0 {
		t.Fatalf("zero-price listing charged: count=%d err=%v", charges, err)
	}
	assertLogin()
}
