package delegaterepo

import (
	"context"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go/modules/postgres"

	corerepo "github.com/xxww0098/podhub-go/internal/admin/core/repo"
	delegatecontract "github.com/xxww0098/podhub-go/internal/admin/delegate/contract"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
)

var (
	parityOnce sync.Once
	parityPool *pgxpool.Pool
	parityErr  error
)

func parityDB(t *testing.T) (*pgxpool.Pool, context.Context) {
	t.Helper()
	dsn := os.Getenv("PODHUB_PARITY_DSN")
	if dsn == "" {
		if _, err := os.Stat("/var/run/docker.sock"); err != nil {
			t.Skip("docker daemon is not available")
		}
	}
	parityOnce.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		if dsn == "" {
			container, err := postgres.Run(ctx, "postgres:16-alpine",
				postgres.WithDatabase("podhub"),
				postgres.WithUsername("postgres"),
				postgres.WithPassword("postgres"),
				postgres.BasicWaitStrategies(),
			)
			if err != nil {
				parityErr = err
				return
			}
			dsn, err = container.ConnectionString(ctx, "sslmode=disable")
			if err != nil {
				parityErr = err
				return
			}
		}
		cfg := config.Config{DatabaseURL: dsn}
		if err := cfg.CheckDatabase(); err != nil {
			parityErr = err
			return
		}
		_ = os.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "1")
		pool, err := db.Connect(ctx, cfg)
		if err != nil {
			parityErr = err
			return
		}
		if err := db.Migrate(ctx, pool); err != nil {
			pool.Close()
			parityErr = err
			return
		}
		parityPool = pool
	})
	if parityErr != nil {
		t.Fatal(parityErr)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	t.Cleanup(cancel)
	return parityPool, ctx
}

func TestStaffGUCSeesDelegateOrders(t *testing.T) {
	pool, ctx := parityDB(t)
	const userID = int64(990221)
	if _, err := pool.Exec(ctx, `
		INSERT INTO account_users (id, public_id, email, password_hash, role, name, target, supplier_id, plan, created_at, updated_at)
		VALUES ($1, 'staff990221', 'staff990221@example.invalid', 'x', 'user', 't', '/workspace', '', 'lite', clock_timestamp(), clock_timestamp())
		ON CONFLICT (id) DO NOTHING`, userID); err != nil {
		t.Fatal(err)
	}
	var orgID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO organizations (owner_user_id, name, plan, created_at, updated_at)
		VALUES ($1, 'org-staff-990221', 'lite', clock_timestamp(), clock_timestamp()) RETURNING id`, userID).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM delegate_orders WHERE org_id = $1`, orgID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM organization_members WHERE org_id = $1`, orgID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM organizations WHERE id = $1`, orgID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM account_users WHERE id = $1`, userID)
	})
	const posting = "ADM-STAFF-990221"
	if _, err := pool.Exec(ctx, `
		INSERT INTO delegate_orders (org_id, store_id, posting_number, state, created_at_ms, updated_at_ms)
		VALUES ($1, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', $2, 'ready', 1, 1)`, orgID, posting); err != nil {
		t.Fatal(err)
	}

	bare, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer bare.Rollback(ctx)
	if _, err := bare.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
		t.Fatal(err)
	}
	var hidden int
	if err := bare.QueryRow(ctx, `SELECT count(*) FROM delegate_orders WHERE posting_number = $1`, posting).Scan(&hidden); err != nil || hidden != 0 {
		t.Fatalf("missing staff GUC sees %d %v", hidden, err)
	}

	tx, err := corerepo.BeginStaff(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	defer corerepo.EndLease(tx)
	var seen string
	if err := tx.QueryRow(ctx, `SELECT posting_number FROM delegate_orders WHERE posting_number = $1`, posting).Scan(&seen); err != nil || seen != posting {
		t.Fatalf("staff sees %q %v", seen, err)
	}
	oldUser, oldStaff, oldOrg := sessionSnap(t, ctx, tx)
	var newUser, newStaff, newOrg string
	if err := db.InTx(ctx, pool, db.Staff(), func(tx pgx.Tx) error {
		newUser, newStaff, newOrg = sessionSnap(t, ctx, tx)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if oldUser != newUser || oldStaff != newStaff || oldOrg != newOrg {
		t.Fatalf("staff session old %s %q %q new %s %q %q", oldUser, oldStaff, oldOrg, newUser, newStaff, newOrg)
	}
	repo := DelegateRepo{Pool: pool}
	list, err := repo.List(ctx, delegatecontract.OrderQuery{OrgID: orgID, Limit: 20})
	if err != nil || len(list.Data.Orders) != 1 || list.Data.Orders[0].PostingNumber != posting {
		t.Fatalf("%+v %v", list.Data.Orders, err)
	}
}

func sessionSnap(t *testing.T, ctx context.Context, tx pgx.Tx) (user, staff, org string) {
	t.Helper()
	var staffP, orgP *string
	if err := tx.QueryRow(ctx, `
		SELECT current_user,
		       current_setting('app.staff_access', true),
		       current_setting('app.current_org_id', true)`).Scan(&user, &staffP, &orgP); err != nil {
		t.Fatal(err)
	}
	if staffP != nil {
		staff = *staffP
	}
	if orgP != nil {
		org = *orgP
	}
	return user, staff, org
}
