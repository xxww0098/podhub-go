package integration

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

// TestCatalogCostIsInvisibleOutsideStaffAndManager is the margin-leak guard.
//
// 00365 gives sc_source_offers a deliberately narrow arm: staff and the
// source's catalogue manager, nobody else. cost_cents is the factory's cost.
// If a seller or an anonymous visitor can read it, they can compute the
// platform's margin on every SKU - so this is the one row in the \u00a76.4
// matrix where "nobody can see it" is a business requirement rather than a
// tidiness preference.
//
// A comment in the migration cannot enforce that. The read arms on the OTHER
// five tables are broad (published rows are readable by any app session), so
// the natural mistake when editing this file is to copy one of those arms
// onto sc_source_offers. This test fails if that happens.
func TestCatalogCostIsInvisibleOutsideStaffAndManager(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)

	seedCatalogCost(t, ctx, pool)

	// 1. Anonymous / seller app session: zero rows, and specifically no cost.
	if n := countOffers(t, ctx, pool, false); n != 0 {
		t.Fatalf("app session with no identity read %d sc_source_offers row(s); cost_cents is a margin leak", n)
	}

	// 2. The manager of THIS source can read it - the arm is not simply closed.
	if n := countOffers(t, ctx, pool, true); n != 1 {
		t.Fatalf("catalogue manager read %d row(s), want 1: the manager arm must still work", n)
	}

	// 3. Staff can read it.
	if n := countOffersAsStaff(t, ctx, pool); n != 1 {
		t.Fatalf("staff read %d row(s), want 1", n)
	}
}

func seedCatalogCost(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	const source = "src_cost_guard"
	const managerID = 940001

	if _, err := pool.Exec(ctx, `INSERT INTO account_users (id, public_id, email, password_hash, role, name, target, supplier_id, plan, created_at, updated_at)
		VALUES ($1, 'costmgr@test.example', 'costmgr@test.example', 'x', 'user', 'M', '/workspace', '', 'free', clock_timestamp(), clock_timestamp())`, managerID); err != nil {
		t.Fatalf("insert manager: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO sc_sources (source_id, name, created_at_ms, updated_at_ms) VALUES ($1, $1, 1, 1)`, source); err != nil {
		t.Fatalf("insert source: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO sc_products (product_id, source_id, title, published, created_at_ms, updated_at_ms, created_by_account_uuid)
		VALUES ('prod_cost', $1, 'P', true, 1, 1, 'acct')`, source); err != nil {
		t.Fatalf("insert product: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO sc_skus (sku_id, product_id, platform_code, title, published, created_at_ms, updated_at_ms, created_by_account_uuid)
		VALUES ('sku_cost', 'prod_cost', 'ozon', 'S', true, 1, 1, 'acct')`); err != nil {
		t.Fatalf("insert sku: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO sc_source_offers (source_id, sku_id, cost_cents, created_at_ms, updated_at_ms)
		VALUES ($1, 'sku_cost', 4200, 1, 1)`, source); err != nil {
		t.Fatalf("insert offer: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO sc_catalog_managers (source_id, user_id, status, created_by, created_at_ms)
		VALUES ($1, $2, 'active', $2, 1)`, source, managerID); err != nil {
		t.Fatalf("insert manager grant: %v", err)
	}
}

func countOffers(t *testing.T, ctx context.Context, pool *pgxpool.Pool, asManager bool) int {
	t.Helper()
	var n int
	err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		if asManager {
			if err := tenantx.EnterCatalogManager(ctx, tx, 940001); err != nil {
				return err
			}
		} else {
			if err := tenantx.EnterAppRole(ctx, tx); err != nil {
				return err
			}
		}
		return tx.QueryRow(ctx, `SELECT count(*) FROM public.sc_source_offers`).Scan(&n)
	})
	if err != nil {
		t.Fatalf("count offers (manager=%v): %v", asManager, err)
	}
	return n
}

func countOffersAsStaff(t *testing.T, ctx context.Context, pool *pgxpool.Pool) int {
	t.Helper()
	var n int
	err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT set_config('role', 'podhub_app', true), set_config('app.staff_access', '1', true)`); err != nil {
			return err
		}
		return tx.QueryRow(ctx, `SELECT count(*) FROM public.sc_source_offers`).Scan(&n)
	})
	if err != nil {
		t.Fatalf("count offers as staff: %v", err)
	}
	return n
}
