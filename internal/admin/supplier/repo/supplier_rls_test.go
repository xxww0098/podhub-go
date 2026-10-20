package supplierrepo

import (
	"context"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go/modules/postgres"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
	"github.com/xxww0098/podhub-go/internal/admin/domain"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

func TestSupplierPortalRLS(t *testing.T) {
	pool, ctx := supParityDB(t)
	const (
		userA = int64(910201)
		userB = int64(910202)
		userS = int64(910203)
	)
	pubA := "a910201"
	supSeedUser(t, ctx, pool, userA, pubA, "admin")
	supSeedUser(t, ctx, pool, userB, "a910202", "admin")
	supSeedUser(t, ctx, pool, userS, "a910203", "super_admin")
	t.Cleanup(func() {
		c := context.Background()
		_, _ = pool.Exec(c, `DELETE FROM supplier_withdrawals WHERE source_id = 'src_admin_sup_910201'`)
		_, _ = pool.Exec(c, `DELETE FROM supplier_wallets WHERE source_id = 'src_admin_sup_910201'`)
		_, _ = pool.Exec(c, `DELETE FROM sc_sources WHERE source_id = 'src_admin_sup_910201'`)
		_, _ = pool.Exec(c, `DELETE FROM account_users WHERE id = ANY($1)`, []int64{userA, userB, userS})
	})
	supSeedLease(t, ctx, pool)
	portal := Portal{Pool: pool, Begin: tenantx.BeginApp}
	actorA := contract.Actor{UserID: userA, Role: "admin"}
	actorB := contract.Actor{UserID: userB, Role: "admin"}
	actorS := contract.Actor{UserID: userS, Role: "super_admin"}
	dbRow, _, err := portal.CreateDb(ctx, actorA, domain.NormalizedDb{
		Name: "隔离印花厂-910201", Country: "CN", ViewPrefs: []byte(`{}`),
	}, "src_admin_sup_910201", nil, 10, "")
	if err != nil {
		t.Fatal(err)
	}
	if dbRow.CreatedBy != pubA || dbRow.RowCount != 0 {
		t.Fatalf("created %+v", dbRow)
	}
	own, err := portal.ListDbs(ctx, actorA)
	if err != nil || !supHasSource(own, "src_admin_sup_910201") {
		t.Fatalf("owner list %+v %v", own, err)
	}
	other, err := portal.ListDbs(ctx, actorB)
	if err != nil || supHasSource(other, "src_admin_sup_910201") {
		t.Fatalf("other admin saw the db %+v %v", other, err)
	}
	all, err := portal.ListDbs(ctx, actorS)
	if err != nil || !supHasSource(all, "src_admin_sup_910201") {
		t.Fatalf("super list %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO supplier_wallets (source_id, balance_microfen, held_microfen, updated_at_ms)
		VALUES ('src_admin_sup_910201', 2000000, 1000000, 1)`); err != nil {
		t.Fatal(err)
	}
	var withdrawal string
	if err := pool.QueryRow(ctx, `
		INSERT INTO supplier_withdrawals
		    (source_id, amount_cents, amount_microfen, channel, account, real_name, status, requested_at_ms)
		VALUES ('src_admin_sup_910201', 1, 1000000, 'alipay', 'acct', '名', 'requested', 5)
		RETURNING withdrawal_id::text`).Scan(&withdrawal); err != nil {
		t.Fatal(err)
	}
	listed, err := portal.ListWithdrawals(ctx, actorA, "requested")
	if err != nil || len(listed) != 1 || listed[0].WithdrawalID != withdrawal || listed[0].Reference != "" {
		t.Fatalf("withdrawals %+v %v", listed, err)
	}
	paid, err := portal.PayWithdrawal(ctx, actorA, withdrawal, "  单号-1  ", 20)
	if err != nil || paid.Status != "paid" || paid.Reference != "单号-1" || paid.DecidedAtMs == nil || *paid.DecidedAtMs != 20 {
		t.Fatalf("paid %+v %v", paid, err)
	}
	var balance, held int64
	if err := pool.QueryRow(ctx, `SELECT balance_microfen, held_microfen FROM supplier_wallets WHERE source_id = 'src_admin_sup_910201'`).Scan(&balance, &held); err != nil {
		t.Fatal(err)
	}
	if balance != 1000000 || held != 0 {
		t.Fatalf("wallet %d %d", balance, held)
	}
	if _, err := portal.PayWithdrawal(ctx, actorA, withdrawal, "单号-1", 21); err == nil || err.Error() != "这笔提现已经处理过" {
		t.Fatalf("replay %v", err)
	}
}

func supHasSource(rows []domain.SupplierDb, id string) bool {
	for _, row := range rows {
		if row.SourceID == id {
			return true
		}
	}
	return false
}

func supSeedUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id int64, publicID, role string) {
	t.Helper()
	_, err := pool.Exec(ctx, `
		INSERT INTO account_users (id, public_id, email, password_hash, role, name, target, supplier_id, plan, created_at, updated_at)
		VALUES ($1, $2, $3, 'x', $4, '管理员', '/workspace', '', 'lite', clock_timestamp(), clock_timestamp())`,
		id, publicID, fmt.Sprintf("%s@example.invalid", publicID), role)
	if err != nil {
		t.Fatal(err)
	}
}

func supSeedLease(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	if _, err := pool.Exec(ctx, `DELETE FROM writer_lease_events WHERE lease_id IN (
		SELECT id FROM writer_leases WHERE domain = 'admin' AND revoked_at_ms IS NULL)`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM writer_leases WHERE domain = 'admin' AND revoked_at_ms IS NULL`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO writer_leases (
		    domain, holder, holder_instance, fence_token, granted_at_ms,
		    expires_at_ms, heartbeat_at_ms, grant_reason)
		VALUES ('admin', 'axum', $1, 1, 0,
		        (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint + 600000,
		        (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint, 'admin lease')`,
		fmt.Sprintf("axum-%d", os.Getpid())); err != nil {
		t.Fatal(err)
	}
}

var (
	supOnce sync.Once
	supPool *pgxpool.Pool
	supErr  error
)

func supParityDB(t testing.TB) (*pgxpool.Pool, context.Context) {
	t.Helper()
	dsn := os.Getenv("PODHUB_PARITY_DSN")
	if dsn == "" {
		if _, err := os.Stat("/var/run/docker.sock"); err != nil {
			t.Skip("docker daemon is not available")
		}
	}
	supOnce.Do(func() {
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
				supErr = err
				return
			}
			dsn, err = container.ConnectionString(ctx, "sslmode=disable")
			if err != nil {
				supErr = err
				return
			}
		}
		cfg := config.Config{DatabaseURL: dsn}
		if err := cfg.CheckDatabase(); err != nil {
			supErr = err
			return
		}
		_ = os.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "1")
		pool, err := db.Connect(ctx, cfg)
		if err != nil {
			supErr = err
			return
		}
		if err := db.Migrate(ctx, pool); err != nil {
			pool.Close()
			supErr = err
			return
		}
		supPool = pool
	})
	if supErr != nil {
		t.Fatal(supErr)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	t.Cleanup(cancel)
	return supPool, ctx
}
