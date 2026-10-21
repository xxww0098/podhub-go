package integration

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

// TestCatalogManagerCannotChangePlatformFlags is the §8.2 boundary guard.
//
// The plan separates two kinds of column on sc_sources: what the catalogue
// manager owns (the factory's name, its property schema, its cost) and what
// the PLATFORM owns (listed = is this factory on the storefront at all,
// accepts_delegate = does it take delegate work). §8.2 marks both of the
// latter as ❌ for managers.
//
// A RLS policy cannot express "you may update this row but not these two
// columns": WITH CHECK only sees the NEW row and PostgreSQL rejects OLD in
// it. So the first cut of 00365 gave managers FOR ALL and the flags moved.
// The migration now pins them with a BEFORE UPDATE trigger. This test fails
// if that trigger is dropped or if a future edit widens the manager arm.
func TestCatalogManagerCannotChangePlatformFlags(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)

	seedCatalogCost(t, ctx, pool)

	// Control: the manager can edit a column it owns. Without this the test
	// would also pass if the manager arm were simply broken.
	if err := asManager(ctx, pool, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE public.sc_sources SET name = 'renamed by manager' WHERE source_id = 'src_cost_guard'`)
		return err
	}); err != nil {
		t.Fatalf("manager cannot rename its own source; the manager arm is broken, not narrow: %v", err)
	}

	// The two platform flags must be refused.
	for _, stmt := range []string{
		`UPDATE public.sc_sources SET listed = NOT listed WHERE source_id = 'src_cost_guard'`,
		`UPDATE public.sc_sources SET accepts_delegate = NOT accepts_delegate WHERE source_id = 'src_cost_guard'`,
	} {
		err := asManager(ctx, pool, func(tx pgx.Tx) error {
			_, e := tx.Exec(ctx, stmt)
			return e
		})
		if err == nil {
			t.Fatalf("a catalogue manager changed a platform-only flag: %s", stmt)
		}
		if !strings.Contains(err.Error(), "CATALOG_MANAGER_FLAG_FORBIDDEN") {
			t.Fatalf("expected CATALOG_MANAGER_FLAG_FORBIDDEN from %s, got %v", stmt, err)
		}
	}

	// Staff keep the platform's own arm: they may flip the flags.
	if err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT set_config('role', 'podhub_app', true), set_config('app.staff_access', '1', true)`); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `UPDATE public.sc_sources SET listed = true WHERE source_id = 'src_cost_guard'`)
		return err
	}); err != nil {
		t.Fatalf("staff cannot set listed; the pin must not apply to the platform arm: %v", err)
	}

	// The flags must actually be unchanged after all of the above.
	var listed, accepts bool
	if err := pool.QueryRow(ctx, `SELECT listed, accepts_delegate FROM public.sc_sources WHERE source_id = 'src_cost_guard'`).Scan(&listed, &accepts); err != nil {
		t.Fatalf("read flags: %v", err)
	}
	if !listed || accepts {
		t.Fatalf("flags are listed=%v accepts=%v, want listed=true accepts=false", listed, accepts)
	}
}

// TestCatalogManagerCannotDeleteOffers pins the other half of §8.2: the
// manager may CHANGE an offer's cost, but creating and deleting the factory's
// supply rows is not in the capability table - an offer is the factory's own
// supply record, opened and closed by the platform or the factory.
func TestCatalogManagerCannotDeleteOffers(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)

	seedCatalogCost(t, ctx, pool)

	// Control: editing the cost is exactly what the manager is for.
	if err := asManager(ctx, pool, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE public.sc_source_offers SET cost_cents = 5000 WHERE source_id = 'src_cost_guard'`)
		return err
	}); err != nil {
		t.Fatalf("manager cannot edit cost_cents; §8.2 grants that: %v", err)
	}

	// Deleting must touch zero rows (RLS filters the row out of the DELETE).
	var deleted int64
	if err := asManager(ctx, pool, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `DELETE FROM public.sc_source_offers WHERE source_id = 'src_cost_guard'`)
		if err != nil {
			return err
		}
		deleted = tag.RowsAffected()
		return nil
	}); err != nil {
		t.Fatalf("delete offers as manager: %v", err)
	}
	if deleted != 0 {
		t.Fatalf("a catalogue manager deleted %d factory offer row(s); §8.2 does not grant that", deleted)
	}

	// And the row is still there.
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM public.sc_source_offers WHERE source_id = 'src_cost_guard'`).Scan(&n); err != nil {
		t.Fatalf("count offers: %v", err)
	}
	if n != 1 {
		t.Fatalf("offer rows = %d, want 1", n)
	}
}

// TestSettlementArmDoesNotLeakSourceCosts is the regression guard for the
// removed sc_source_offers_settlement_read arm.
//
// The deleted arm keyed on "this seller has a dispatch from this source". A
// dispatch carries offer_ids in a jsonb payload, so the policy could only
// reach source_id - meaning one dispatch exposed the factory's ENTIRE cost
// sheet and let the seller reconstruct the platform margin. The settlement
// path does not need it: Receipt and lockedOrgWrite both set staff_access
// before reading.
func TestSettlementArmDoesNotLeakSourceCosts(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)

	const buyerOrg = int64(77001)
	const source = "src_settle_guard"

	if _, err := pool.Exec(ctx, `INSERT INTO organizations (id, name, plan, owner_user_id, created_at, updated_at) VALUES ($1, 'buyer', 'free', 970001, clock_timestamp(), clock_timestamp())`, buyerOrg); err != nil {
		t.Fatalf("insert org: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO sc_sources (source_id, name, created_at_ms, updated_at_ms) VALUES ($1, $1, 1, 1)`, source); err != nil {
		t.Fatalf("insert source: %v", err)
	}
	// sc_skus_product_unique allows ONE sku per product (00265), so the two
	// offers live on two separate products of the same source.
	for _, sku := range []struct{ id, product, code string }{
		{"sku_bought", "prod_bought", "code_bought"},
		{"sku_secret", "prod_secret", "code_secret"},
	} {
		if _, err := pool.Exec(ctx, `INSERT INTO sc_products (product_id, source_id, title, published, created_at_ms, updated_at_ms, created_by_account_uuid) VALUES ($1, $2, 'P', true, 1, 1, 'acct')`, sku.product, source); err != nil {
			t.Fatalf("insert product %s: %v", sku.product, err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO sc_skus (sku_id, product_id, platform_code, title, published, created_at_ms, updated_at_ms, created_by_account_uuid) VALUES ($1, $2, $3, 'S', true, 1, 1, 'acct')`, sku.id, sku.product, sku.code); err != nil {
			t.Fatalf("insert sku %s: %v", sku.id, err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO sc_source_offers (source_id, sku_id, cost_cents, created_at_ms, updated_at_ms) VALUES ($1, $2, 7000, 1, 1)`, source, sku.id); err != nil {
			t.Fatalf("insert offer %s: %v", sku.id, err)
		}
	}
	const orderID = "00000000-0000-0000-0000-0000000e7701"
	const dispatchID = "00000000-0000-0000-0000-0000000e7702"
	if _, err := pool.Exec(ctx, `INSERT INTO delegate_orders (order_id, org_id, store_id, posting_number, state, created_at_ms, updated_at_ms) VALUES ($1::uuid, $2, '00000000-0000-0000-0000-0000000e7703'::uuid, 'P-1', 'dispatched', 1, 1)`, orderID, buyerOrg); err != nil {
		t.Fatalf("insert order: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO delegate_dispatches (dispatch_id, org_id, order_id, source_id, dispatch_no, payload, state, created_at_ms, updated_at_ms) VALUES ($1::uuid, $2, $3::uuid, $4, 'D-1', '{"lines":[]}'::jsonb, 'accepted', 1, 1)`, dispatchID, buyerOrg, orderID, source); err != nil {
		t.Fatalf("insert dispatch: %v", err)
	}

	// The buyer org, with a dispatch from this source, must still see ZERO
	// offer rows. Before the arm was removed this returned both rows.
	var n int
	if err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		if err := tenantx.EnterApp(ctx, tx, buyerOrg); err != nil {
			return err
		}
		return tx.QueryRow(ctx, `SELECT count(*) FROM public.sc_source_offers`).Scan(&n)
	}); err != nil {
		t.Fatalf("count offers as buyer: %v", err)
	}
	if n != 0 {
		t.Fatalf("a seller with one dispatch read %d of the factory's offer rows; one dispatch must not unlock the whole cost sheet", n)
	}

	// Staff still settle: the staff arm is what the settlement path uses.
	if err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT set_config('role', 'podhub_app', true), set_config('app.staff_access', '1', true)`); err != nil {
			return err
		}
		return tx.QueryRow(ctx, `SELECT count(*) FROM public.sc_source_offers`).Scan(&n)
	}); err != nil {
		t.Fatalf("count offers as staff: %v", err)
	}
	if n != 2 {
		t.Fatalf("staff read %d offer rows, want 2: the settlement path must keep working", n)
	}
}

func asManager(ctx context.Context, pool *pgxpool.Pool, fn func(pgx.Tx) error) error {
	return pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		if err := tenantx.EnterCatalogManager(ctx, tx, 940001); err != nil {
			return err
		}
		return fn(tx)
	})
}

// TestCatalogManagerMayOpenAnOfferButNotDeleteOne pins the manager's write
// arms on sc_source_offers to INSERT + UPDATE, never DELETE.
//
// The plan grants a manager "create / edit / delete sc_products and sc_skus"
// and "change cost_cents". Those only compose if INSERT is allowed too: a new
// sku with no offer row makes the seller's LEFT JOIN yield NULL, and the
// portal renders a silent CNY 0.00. DELETE stays out because the manager
// writer must upsert with ON CONFLICT; granting DELETE would also re-open the
// x1-style DELETE+INSERT shape, which can drop a row between the two halves.
func TestCatalogManagerMayOpenAnOfferButNotDeleteOne(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)

	seedCatalogCost(t, ctx, pool)

	// Control: the manager can move the cost on the seeded offer. Without this
	// the test would pass if the whole manager arm were broken.
	if err := asManager(ctx, pool, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE public.sc_source_offers SET cost_cents = 5000 WHERE source_id = 'src_cost_guard' AND sku_id = 'sku_cost'`)
		return err
	}); err != nil {
		t.Fatalf("manager cannot change cost_cents on its own source: %v", err)
	}

	// A new sku needs a supply record, so INSERT must be allowed.
	if _, err := pool.Exec(ctx, `INSERT INTO sc_products (product_id, source_id, title, published, created_at_ms, updated_at_ms, created_by_account_uuid) VALUES ('prod_new_offer', 'src_cost_guard', 'P', false, 1, 1, 'acct')`); err != nil {
		t.Fatalf("insert product: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO sc_skus (sku_id, product_id, platform_code, title, published, created_at_ms, updated_at_ms, created_by_account_uuid) VALUES ('sku_new_offer', 'prod_new_offer', 'code_new_offer', 'S', false, 1, 1, 'acct')`); err != nil {
		t.Fatalf("insert sku: %v", err)
	}
	if err := asManager(ctx, pool, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `INSERT INTO public.sc_source_offers (source_id, sku_id, cost_cents, created_at_ms, updated_at_ms) VALUES ('src_cost_guard', 'sku_new_offer', 3300, 1, 1)`)
		return err
	}); err != nil {
		t.Fatalf("manager cannot open an offer for a sku it just created; the new row would render CNY 0.00: %v", err)
	}

	// The upsert the manager writer must use: one statement, INSERT + UPDATE only.
	if err := asManager(ctx, pool, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `INSERT INTO public.sc_source_offers (source_id, sku_id, cost_cents, created_at_ms, updated_at_ms)
			VALUES ('src_cost_guard', 'sku_new_offer', 3400, 1, 2)
			ON CONFLICT (source_id, sku_id) DO UPDATE SET cost_cents = EXCLUDED.cost_cents, updated_at_ms = EXCLUDED.updated_at_ms`)
		return err
	}); err != nil {
		t.Fatalf("manager upsert (INSERT ON CONFLICT DO UPDATE) failed; the writer cannot update an offer without DELETE: %v", err)
	}

	// DELETE must stay refused. RLS filters rather than errors on a missing
	// arm, so the assertion is the row count, not an error.
	if err := asManager(ctx, pool, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `DELETE FROM public.sc_source_offers WHERE source_id = 'src_cost_guard'`)
		return err
	}); err != nil {
		t.Fatalf("manager DELETE on sc_source_offers raised: %v", err)
	}
	var remaining int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM public.sc_source_offers WHERE source_id = 'src_cost_guard'`).Scan(&remaining); err != nil {
		t.Fatalf("count offers: %v", err)
	}
	if remaining != 2 {
		t.Fatalf("a catalogue manager deleted offer rows (%d left, want 2); DELETE must not be granted", remaining)
	}
}
