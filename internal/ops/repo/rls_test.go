package repo

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
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
)

func TestLedgerAndConsoleRLS(t *testing.T) {
	pool, ctx := parityDB(t)
	userA, userB := int64(883001), int64(883002)
	orgA, storeA, uuidA := seedOpsOrg(t, ctx, pool, userA, "a")
	orgB, storeB, uuidB := seedOpsOrg(t, ctx, pool, userB, "b")
	t.Cleanup(func() {
		dropOpsOrg(context.Background(), pool, orgA, userA)
		dropOpsOrg(context.Background(), pool, orgB, userB)
	})
	if _, err := pool.Exec(ctx, `
		INSERT INTO console_store_metrics
		    (org_id, store_id, refresh_generation, ordered_units_30d, day_series_14d, through_day, last_sync_at_ms)
		VALUES ($1, $2, 1, 4,
		        ARRAY[0,0,0,0,0,0,0,0,0,0,0,0,0,1]::float8[],
		        '2026-08-17', 1)`, orgA, uuidA); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO store_product_sync
		    (org_id, store_id, refresh_generation,
		     count_total, count_on_sale, count_processing, count_hidden,
		     count_moderation_failed, count_zero_stock, count_archived, count_delisted)
		VALUES ($1, $2, 1, 3, 1, 0, 0, 0, 0, 0, 0)`, orgA, uuidA); err != nil {
		t.Fatal(err)
	}

	store := New(pool, seal.Ring{}, false)
	row, err := store.Begin(ctx, orgA, storeA, "k-a", "h-a", "chat_send", []byte(`{}`))
	if err != nil || !row.Inserted || row.State != "dispatching" {
		t.Fatalf("begin %+v %v", row, err)
	}

	tx, err := tenantx.BeginApp(ctx, pool.Begin, orgB)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	var n int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM seller_upstream_writes WHERE idempotency_key = 'k-a'`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("org B sees ledger %d %v", n, err)
	}
	tag, err := tx.Exec(ctx, `UPDATE seller_upstream_writes SET request_hash = 'stolen' WHERE idempotency_key = 'k-a'`)
	if err != nil {
		t.Fatal(err)
	}
	if tag.RowsAffected() != 0 {
		t.Fatal("org B updated org A ledger")
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO seller_upstream_writes
		    (org_id, store_id, idempotency_key, request_hash, kind, request_body)
		VALUES ($1, $2, 'cross', 'h', 'chat_send', '{}'::jsonb)`, orgA, storeA)
	if err == nil {
		t.Fatal("org B inserted org A's ledger row")
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}

	metrics, err := store.Metrics(ctx, orgB, []string{uuidA, uuidB})
	if err != nil || len(metrics) != 0 {
		t.Fatalf("org B metrics %+v %v", metrics, err)
	}
	metrics, err = store.Metrics(ctx, orgA, []string{uuidA})
	if err != nil || len(metrics) != 1 || metrics[0].StoreID != uuidA || metrics[0].Ordered == nil || *metrics[0].Ordered != 4 {
		t.Fatalf("org A metrics %+v %v", metrics, err)
	}
	products, err := store.Products(ctx, orgB, []string{uuidA})
	if err != nil || len(products) != 0 {
		t.Fatalf("org B products %+v %v", products, err)
	}
	products, err = store.Products(ctx, orgA, []string{uuidA})
	if err != nil || len(products) != 1 || products[0].CountTotal == nil || *products[0].CountTotal != 3 {
		t.Fatalf("org A products %+v %v", products, err)
	}

	bare, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer bare.Rollback(ctx)
	if _, err := bare.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"seller_upstream_writes", "console_store_metrics", "store_product_sync"} {
		if err := bare.QueryRow(ctx, `SELECT count(*) FROM `+table).Scan(&n); err != nil || n != 0 {
			t.Fatalf("missing GUC %s %d %v", table, n, err)
		}
	}
	_, err = bare.Exec(ctx, `
		INSERT INTO seller_upstream_writes
		    (org_id, store_id, idempotency_key, request_hash, kind, request_body)
		VALUES ($1, $2, 'noguc', 'h', 'chat_send', '{}'::jsonb)`, orgA, storeA)
	if err == nil {
		t.Fatal("missing GUC inserted a ledger row")
	}
	other, err := store.Begin(ctx, orgB, storeB, "k-b", "h-b", "chat_send", []byte(`{}`))
	if err != nil || !other.Inserted {
		t.Fatalf("org B begin %+v %v", other, err)
	}
	own, err := tenantx.BeginApp(ctx, pool.Begin, orgA)
	if err != nil {
		t.Fatal(err)
	}
	defer own.Rollback(ctx)
	if err := own.QueryRow(ctx, `SELECT count(*) FROM seller_upstream_writes WHERE idempotency_key = 'k-b'`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("org A sees org B ledger %d %v", n, err)
	}
}

func seedOpsOrg(t *testing.T, ctx context.Context, pool *pgxpool.Pool, userID int64, tag string) (orgID, storeID int64, storeUUID string) {
	t.Helper()
	if _, err := pool.Exec(ctx, `
		INSERT INTO account_users (id, public_id, email, password_hash, role, name, target, supplier_id, plan, created_at, updated_at)
		VALUES ($1, $2, $3, 'x', 'user', 't', '/workspace', '', 'lite', clock_timestamp(), clock_timestamp())`,
		userID, fmt.Sprintf("ops%d", userID), fmt.Sprintf("ops%d@example.invalid", userID)); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO organizations (owner_user_id, name, plan, created_at, updated_at)
		VALUES ($1, $2, 'lite', clock_timestamp(), clock_timestamp()) RETURNING id`,
		userID, "ops-"+tag).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO organization_members (org_id, user_id, role, status, display_name, created_at, updated_at, join_order)
		VALUES ($1, $2, 'owner', 'active', 't', clock_timestamp(), clock_timestamp(), 1)`, orgID, userID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO organization_stores (org_id, create_order, name)
		VALUES ($1, 1, $2) RETURNING id, uuid::text`, orgID, "store-"+tag).Scan(&storeID, &storeUUID); err != nil {
		t.Fatal(err)
	}
	return orgID, storeID, storeUUID
}

func dropOpsOrg(ctx context.Context, pool *pgxpool.Pool, orgID, userID int64) {
	_, _ = pool.Exec(ctx, `DELETE FROM seller_upstream_writes WHERE org_id = $1`, orgID)
	_, _ = pool.Exec(ctx, `DELETE FROM console_store_metrics WHERE org_id = $1`, orgID)
	_, _ = pool.Exec(ctx, `DELETE FROM store_product_sync WHERE org_id = $1`, orgID)
	_, _ = pool.Exec(ctx, `DELETE FROM organization_stores WHERE org_id = $1`, orgID)
	_, _ = pool.Exec(ctx, `DELETE FROM organization_members WHERE org_id = $1`, orgID)
	_, _ = pool.Exec(ctx, `DELETE FROM organizations WHERE id = $1`, orgID)
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
