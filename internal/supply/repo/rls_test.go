package supplyrepo

import (
	"context"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go/modules/postgres"

	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/supply/contract"
)

func TestBindingOrgFilterAndMissingRLS(t *testing.T) {
	pool, ctx := parityDB(t)
	userA, userB := int64(883001), int64(883002)
	orgA := seedOrg(t, ctx, pool, userA, "bind-a")
	orgB := seedOrg(t, ctx, pool, userB, "bind-b")
	rowA := uuid.NewString()
	rowB := uuid.NewString()
	skuA := "sku-bind-a-" + uuid.NewString()
	skuB := "sku-bind-b-" + uuid.NewString()
	t.Cleanup(func() {
		dropBinding(context.Background(), pool, orgA, userA, skuA, rowA)
		dropBinding(context.Background(), pool, orgB, userB, skuB, rowB)
	})
	seedBinding(t, ctx, pool, orgA, rowA, skuA, "sku-a")
	seedBinding(t, ctx, pool, orgB, rowB, skuB, "sku-b")
	repo := New(pool, tenant.BeginApp)
	got, err := repo.GetBinding(ctx, orgA, rowA)
	if err != nil || got.PlatformSKUID != skuA || got.SpecVersion != 2 || got.DesignRevision != 3 {
		t.Fatalf("%+v %v", got, err)
	}
	if _, err := repo.GetBinding(ctx, orgA, rowB); err != contract.ErrNotFound {
		t.Fatalf("cross org %v", err)
	}
	if _, err := repo.GetBinding(ctx, 0, rowA); err != contract.ErrNoTenant {
		t.Fatalf("missing org %v", err)
	}
	if _, err := repo.GetBinding(ctx, orgA, "not-a-uuid"); err != contract.ErrNotFound {
		t.Fatalf("uuid %v", err)
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
	if err := bare.QueryRow(ctx, `SELECT count(*) FROM sc_listing_bindings WHERE listing_row_id IN ($1, $2)`, rowA, rowB).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("sc_listing_bindings RLS changed; bare app role sees %d", n)
	}
}

func seedOrg(t *testing.T, ctx context.Context, pool *pgxpool.Pool, userID int64, tag string) int64 {
	t.Helper()
	if _, err := pool.Exec(ctx, `
		INSERT INTO account_users (id, public_id, email, password_hash, role, name, target, supplier_id, plan, created_at, updated_at)
		VALUES ($1, $2, $3, 'x', 'user', 't', '/workspace', '', 'lite', clock_timestamp(), clock_timestamp())`,
		userID, fmt.Sprintf("b%d", userID), fmt.Sprintf("b%d@example.invalid", userID)); err != nil {
		t.Fatal(err)
	}
	var orgID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO organizations (owner_user_id, name, plan, created_at, updated_at)
		VALUES ($1, $2, 'lite', clock_timestamp(), clock_timestamp()) RETURNING id`, userID, tag+"-"+fmt.Sprint(userID)).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	return orgID
}

func seedBinding(t *testing.T, ctx context.Context, pool *pgxpool.Pool, orgID int64, rowID, skuID, title string) {
	t.Helper()
	productID := "prod-" + skuID
	if _, err := pool.Exec(ctx, `
		INSERT INTO listing_rows (id, org_id, card_id) VALUES ($1, $2, $3)`,
		rowID, orgID, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO sc_products (product_id, title, created_at_ms, updated_at_ms, created_by_account_uuid)
		VALUES ($1, $2, 1, 1, 'test')`, productID, title); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO sc_skus (sku_id, product_id, platform_code, title, created_at_ms, updated_at_ms, created_by_account_uuid)
		VALUES ($1, $2, $3, $4, 1, 1, 'test')`, skuID, productID, "code-"+skuID, title); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO sc_listing_bindings
		    (org_id, store_id, listing_row_id, platform_sku_id, spec_version, design_revision, production_snapshot, created_at_ms, updated_at_ms, created_by_account_uuid)
		VALUES ($1, $2, $3, $4, 2, 3, '{}'::jsonb, 1, 1, 'test')`,
		orgID, uuid.NewString(), rowID, skuID); err != nil {
		t.Fatal(err)
	}
}

func dropBinding(ctx context.Context, pool *pgxpool.Pool, orgID, userID int64, skuID, rowID string) {
	_, _ = pool.Exec(ctx, `DELETE FROM sc_listing_bindings WHERE org_id = $1`, orgID)
	_, _ = pool.Exec(ctx, `DELETE FROM listing_rows WHERE id = $1`, rowID)
	_, _ = pool.Exec(ctx, `DELETE FROM sc_skus WHERE sku_id = $1`, skuID)
	_, _ = pool.Exec(ctx, `DELETE FROM sc_products WHERE product_id = $1`, "prod-"+skuID)
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
