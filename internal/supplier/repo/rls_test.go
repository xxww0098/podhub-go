package supplierrepo

import (
	"context"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go/modules/postgres"

	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
)

// TestSupplierHasNoFundsAccess is §11.6 row 5: a supplier session reads zero
// rows from every funds table, including its own source's.
//
// 00363 drops supplier_source_isolation from supplier_wallets,
// supplier_wallet_ledger and supplier_withdrawals (§6.1, §9). Before that
// migration those tables gave a supplier session a self arm keyed on
// app.current_supplier_user_id, and this test asserted one supplier saw its own
// rows but not another's. That arm is gone, so the only correct answer is 0 for
// every supplier. The rows themselves stay put: this is an access rule, not a
// delete.
func TestSupplierHasNoFundsAccess(t *testing.T) {
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

	tables := []string{"supplier_wallets", "supplier_wallet_ledger", "supplier_withdrawals", "delegate_settlements"}
	for _, user := range []struct {
		id     int64
		source string
	}{{userA, sourceA}, {userB, sourceB}} {
		sess := db.Supplier(user.id)
		err := db.InTx(ctx, pool, sess, func(tx pgx.Tx) error {
			for _, table := range tables {
				var n int
				if err := tx.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&n); err != nil {
					return fmt.Errorf("count %s: %w", table, err)
				}
				if n != 0 {
					return fmt.Errorf("supplier %d sees %d rows in %s, want 0", user.id, n, table)
				}
			}
			// The insert is expected to fail, and in PostgreSQL a failed
			// statement aborts the whole transaction -- committing afterwards
			// degrades to a rollback. Run it in a savepoint so the denial is
			// observed without poisoning the transaction we still commit.
			sp, err := tx.Begin(ctx)
			if err != nil {
				return err
			}
			_, insErr := sp.Exec(ctx, `
				INSERT INTO supplier_wallets (source_id, balance_microfen, held_microfen, updated_at_ms)
				VALUES ($1, 1, 0, 1)`, user.source)
			_ = sp.Rollback(ctx)
			if insErr == nil {
				return fmt.Errorf("supplier %d inserted a wallet row", user.id)
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}

	var stored int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM supplier_wallets`).Scan(&stored); err != nil || stored < 2 {
		t.Fatalf("wallets disappeared %d %v", stored, err)
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
