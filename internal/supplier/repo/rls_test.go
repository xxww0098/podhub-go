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

	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/supplier/contract"
)

func TestWalletRLS(t *testing.T) {
	pool, ctx := parityDB(t)
	userA, userB := int64(882001), int64(882002)
	sourceA, sourceB := "src_wallet_a", "src_wallet_b"
	seedSupplier(t, ctx, pool, userA, sourceA)
	seedSupplier(t, ctx, pool, userB, sourceB)
	t.Cleanup(func() {
		dropSupplier(context.Background(), pool, userA, sourceA)
		dropSupplier(context.Background(), pool, userB, sourceB)
	})
	if _, err := pool.Exec(ctx, `
		INSERT INTO supplier_wallets (source_id, balance_microfen, held_microfen, updated_at_ms)
		VALUES ($1, 100, 10, 1), ($2, 5, 0, 1)`, sourceA, sourceB); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO supplier_withdrawals
		    (source_id, amount_cents, amount_microfen, channel, account, real_name, status, requested_at_ms)
		VALUES ($1, 1, 1000000, 'alipay', 'a', 'n', 'requested', 1),
		       ($2, 2, 2000000, 'bank', 'b', 'm', 'requested', 2)`, sourceA, sourceB); err != nil {
		t.Fatal(err)
	}
	repo := New(pool, tenant.BeginApp)
	wallets, err := repo.ListWallets(ctx, 0, userA)
	if err != nil || len(wallets) != 1 || wallets[0].SourceID != sourceA || wallets[0].BalanceMicrofen != 100 || wallets[0].HeldMicrofen != 10 {
		t.Fatalf("wallets %+v %v", wallets, err)
	}
	rows, err := repo.ListWithdrawals(ctx, 0, userB)
	if err != nil || len(rows) != 1 || rows[0].SourceID != sourceB || rows[0].AmountCents != 2 || rows[0].Status != "requested" {
		t.Fatalf("withdrawals %+v %v", rows, err)
	}
	if _, err := repo.ListWallets(ctx, 0, 0); err != contract.ErrNoTenant {
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
	var n int
	if err := bare.QueryRow(ctx, `SELECT count(*) FROM supplier_wallets`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("missing GUC wallets %d %v", n, err)
	}
	if err := bare.QueryRow(ctx, `SELECT count(*) FROM supplier_withdrawals`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("missing GUC withdrawals %d %v", n, err)
	}
	_, err = bare.Exec(ctx, `
		INSERT INTO supplier_wallets (source_id, balance_microfen, held_microfen, updated_at_ms)
		VALUES ($1, 1, 0, 1)`, sourceA)
	if err == nil {
		t.Fatal("missing GUC inserted a wallet")
	}

	tx, err := tenant.BeginApp(ctx, pool.Begin, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('app.current_supplier_user_id', $1, true)`, fmt.Sprint(userA)); err != nil {
		t.Fatal(err)
	}
	tag, err := tx.Exec(ctx, `
		UPDATE supplier_wallets SET balance_microfen = 1 WHERE source_id = $1`, sourceB)
	if err != nil {
		t.Fatal(err)
	}
	if tag.RowsAffected() != 0 {
		t.Fatalf("supplier A updated source B (%d rows)", tag.RowsAffected())
	}
	var visible int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM supplier_wallets WHERE source_id = $1`, sourceB).Scan(&visible); err != nil {
		t.Fatal(err)
	}
	if visible != 0 {
		t.Fatalf("supplier A can see source B")
	}
}

func seedSupplier(t *testing.T, ctx context.Context, pool *pgxpool.Pool, userID int64, sourceID string) {
	t.Helper()
	if _, err := pool.Exec(ctx, `
		INSERT INTO account_users (id, public_id, email, password_hash, role, name, target, supplier_id, plan, created_at, updated_at)
		VALUES ($1, $2, $3, 'x', 'user', 't', '/workspace', '', 'lite', clock_timestamp(), clock_timestamp())`,
		userID, fmt.Sprintf("s%d", userID), fmt.Sprintf("s%d@example.invalid", userID)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO sc_sources (source_id, name, created_at_ms, updated_at_ms) VALUES ($1, $2, 1, 1)`,
		sourceID, sourceID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO sc_source_members (source_id, user_id, created_by, created_at_ms) VALUES ($1, $2, $2, 1)`,
		sourceID, userID); err != nil {
		t.Fatal(err)
	}
}

func dropSupplier(ctx context.Context, pool *pgxpool.Pool, userID int64, sourceID string) {
	_, _ = pool.Exec(ctx, `DELETE FROM supplier_withdrawals WHERE source_id = $1`, sourceID)
	_, _ = pool.Exec(ctx, `DELETE FROM supplier_wallet_ledger WHERE source_id = $1`, sourceID)
	_, _ = pool.Exec(ctx, `DELETE FROM supplier_wallets WHERE source_id = $1`, sourceID)
	_, _ = pool.Exec(ctx, `DELETE FROM sc_source_members WHERE source_id = $1`, sourceID)
	_, _ = pool.Exec(ctx, `DELETE FROM sc_sources WHERE source_id = $1`, sourceID)
	_, _ = pool.Exec(ctx, `DELETE FROM account_users WHERE id = $1`, userID)
}

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
