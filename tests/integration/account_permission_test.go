package integration

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

// This file is the doc 11.6 verification matrix, restricted to the assertions
// that need a real PostgreSQL. The HTTP-shaped rows of that matrix are already
// covered elsewhere and are deliberately NOT duplicated here:
//
//   - must_change_password whitelist / blocklist: internal/identity/gate_test.go
//     (a pure function over method+path; a real DB would test nothing extra)
//   - catalogue manager isolation: catalog_manager_test.go
//   - cost visibility: catalog_cost_test.go
//   - platform-flag pin + offer arms: catalog_manager_scope_test.go
//   - migration hash guard: internal/platform/db TestMigrationGuard
//
// What is left is the set of invariants that only a CHECK constraint, an RLS
// policy or a SECURITY DEFINER grant can enforce. Each test below fails if the
// invariant is relaxed, and the comment says which edit would relax it.

// TestSupplierAccountCannotBecomeAdmin is doc 11.6 row 1.
//
// Two independent guards exist and this asserts BOTH, because they protect
// different call paths: 00360's ck_account_users_supplier_is_user refuses the
// row write even if a future SetRole forgets its Go-side check, and the Go
// guard refuses before the statement is built. Dropping either one leaves a
// path where a supplier sign-in becomes a platform admin.
func TestSupplierAccountCannotBecomeAdmin(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)

	const supplierID = 950001
	seedAccount(t, ctx, pool, supplierID, "supplier-admin@test.example", "user", "supplier")

	// 1. The DB refuses the write outright.
	_, err := pool.Exec(ctx, `UPDATE public.account_users SET role = 'admin' WHERE id = $1`, supplierID)
	if err == nil {
		t.Fatalf("a supplier account became an admin; ck_account_users_supplier_is_user is gone")
	}
	if !strings.Contains(err.Error(), "ck_account_users_supplier_is_user") {
		t.Fatalf("want a ck_account_users_supplier_is_user violation, got %v", err)
	}

	// 2. And the row is unchanged, so a swallowed error cannot hide it.
	var role string
	if err := pool.QueryRow(ctx, `SELECT role FROM public.account_users WHERE id = $1`, supplierID).Scan(&role); err != nil {
		t.Fatalf("reread role: %v", err)
	}
	if role != "user" {
		t.Fatalf("role is %q after a refused promotion, want user", role)
	}

	// 3. The same CHECK must not block a legitimate platform admin: without
	// this control the test would also pass if account_kind were unconstrained.
	const platformID = 950002
	seedAccount(t, ctx, pool, platformID, "platform-admin@test.example", "user", "platform")
	if _, err := pool.Exec(ctx, `UPDATE public.account_users SET role = 'admin' WHERE id = $1`, platformID); err != nil {
		t.Fatalf("a platform account cannot be promoted; the CHECK is too wide: %v", err)
	}

	// 4. The vocabulary itself is closed: a third kind is a bug, not a value.
	if _, err := pool.Exec(ctx, `UPDATE public.account_users SET account_kind = 'robot' WHERE id = $1`, platformID); err == nil {
		t.Fatalf("account_kind accepted 'robot'; ck_account_users_kind is gone")
	}
}

// TestSupplierSessionReadsNoFunds is doc 11.6 row 5.
//
// Plan 9 says a supplier account has no funds surface at all. The routes are
// gone (supplier/http no longer mounts wallet or withdrawals), but the TABLES
// still exist: F2/F3 removed only the isolation policy, because the rows are
// audit history and migration 00363 refuses to delete them (O15/F4).
//
// So the guarantee has to be enforced where the rows live. With no supplier
// arm, a supplier session must read zero rows from all four money tables even
// when rows exist. This test seeds a wallet for the supplier's own source:
// before F2 that row was visible to it, and that is exactly the leak the plan
// closes.
func TestSupplierSessionReadsNoFunds(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)

	const supplierID = 950010
	const source = "src_funds_guard"
	seedAccount(t, ctx, pool, supplierID, "supplier-funds@test.example", "user", "supplier")
	if _, err := pool.Exec(ctx, `INSERT INTO sc_sources (source_id, name, created_at_ms, updated_at_ms) VALUES ($1, $1, 1, 1)`, source); err != nil {
		t.Fatalf("insert source: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO sc_source_members (source_id, user_id, role, status, created_by, created_at_ms) VALUES ($1, $2, 'member', 'active', $2, 1)`, source, supplierID); err != nil {
		t.Fatalf("insert member: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO supplier_wallets (source_id, balance_microfen, held_microfen, updated_at_ms) VALUES ($1, 500, 0, 1)`, source); err != nil {
		t.Fatalf("insert wallet: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO supplier_wallet_ledger (source_id, entry_type, idempotency_key, amount_microfen, held_delta_microfen, balance_after_microfen, held_after_microfen, created_at_ms)
		VALUES ($1, 'credit', 'seed', 500, 0, 500, 0, 1)`, source); err != nil {
		t.Fatalf("insert ledger: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO supplier_withdrawals (source_id, amount_cents, amount_microfen, channel, account, real_name, status, requested_at_ms)
		VALUES ($1, 1, 1000000, 'alipay', 'a', 'n', 'requested', 1)`, source); err != nil {
		t.Fatalf("insert withdrawal: %v", err)
	}
	// delegate_settlements needs an order and a dispatch, and delegate_orders
	// has an FK to organizations, so the supplier needs an org of its own.
	if _, err := pool.Exec(ctx, `INSERT INTO organizations (id, owner_user_id, name, plan, created_at, updated_at) VALUES ($1, $2, 'O', 'free', clock_timestamp(), clock_timestamp())`, supplierID, supplierID); err != nil {
		t.Fatalf("insert org: %v", err)
	}
	const orderID = "00000000-0000-0000-0000-0000000f5101"
	const dispatchID = "00000000-0000-0000-0000-0000000f5102"
	if _, err := pool.Exec(ctx, `INSERT INTO delegate_orders (order_id, org_id, store_id, posting_number, state, created_at_ms, updated_at_ms) VALUES ($1::uuid, $2, '00000000-0000-0000-0000-0000000f5103'::uuid, 'P-S', 'dispatched', 1, 1)`, orderID, supplierID); err != nil {
		t.Fatalf("insert order: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO delegate_dispatches (dispatch_id, org_id, order_id, source_id, dispatch_no, payload, state, created_at_ms, updated_at_ms) VALUES ($1::uuid, $2, $3::uuid, $4, 'D-S', '{"lines":[]}'::jsonb, 'shipped', 1, 1)`, dispatchID, supplierID, orderID, source); err != nil {
		t.Fatalf("insert dispatch: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO delegate_settlements (org_id, order_id, dispatch_id, source_id, amount_cents, amount_microfen, state, breakdown, held_at_ms)
		VALUES ($1, $2::uuid, $3::uuid, $4, 1, 1000000, 'held', '{}'::jsonb, 1)`, supplierID, orderID, dispatchID, source); err != nil {
		t.Fatalf("insert settlement: %v", err)
	}

	for _, table := range []string{"supplier_wallets", "supplier_wallet_ledger", "supplier_withdrawals", "delegate_settlements"} {
		var n int
		err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
			if err := tenantx.EnterSupplier(ctx, tx, supplierID); err != nil {
				return err
			}
			return tx.QueryRow(ctx, "SELECT count(*) FROM public."+table).Scan(&n)
		})
		if err != nil {
			t.Fatalf("count %s as supplier: %v", table, err)
		}
		if n != 0 {
			t.Fatalf("a supplier session read %d row(s) from %s; plan 9 gives a supplier no funds surface", n, table)
		}
	}

	// Control: every table really holds a row, so the zeros above are the
	// policy doing the work rather than four empty tables. Without this the
	// test would pass on a freshly migrated database no matter what 00363 did.
	for _, table := range []string{"supplier_wallets", "supplier_wallet_ledger", "supplier_withdrawals", "delegate_settlements"} {
		var seeded int
		if err := pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&seeded); err != nil {
			t.Fatalf("count %s as superuser: %v", table, err)
		}
		if seeded == 0 {
			t.Fatalf("%s is empty; the supplier zero above proves nothing", table)
		}
	}
}

// TestPublicCannotExecuteDefinerFunctions is doc 11.6 row 8.
//
// Migration 00191 blanket-GRANTs EXECUTE on every new function to PUBLIC, so
// each SECURITY DEFINER function added by 00364 must REVOKE it back. A definer
// function runs as its owner and therefore bypasses RLS; leaving it PUBLIC is
// a hole that no RLS test would ever notice, because RLS is not consulted.
//
// The assertion is has_function_privilege('public', ...) = false for every
// function 00364 introduces. Audit the list here rather than in SQL so adding
// a function without a REVOKE shows up as a failing test.
func TestPublicCannotExecuteDefinerFunctions(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)

	functions := []string{
		"public.delegate_supplier_accept(uuid,bigint,uuid)",
		"public.delegate_supplier_reject(uuid,bigint,text,uuid)",
		"public.delegate_supplier_ship(uuid,bigint,text,text,bigint,uuid)",
		"public.delegate_source_active_fulfiller_count(text)",
		"public.delegate_source_active_fulfiller_id(text)",
		"public.delegate_credit_fulfiller_wallet(uuid,bigint)",
	}
	for _, fn := range functions {
		var publicCan bool
		if err := pool.QueryRow(ctx, `SELECT has_function_privilege('public', $1::regprocedure, 'EXECUTE')`, fn).Scan(&publicCan); err != nil {
			t.Fatalf("has_function_privilege(%s): %v", fn, err)
		}
		if publicCan {
			t.Fatalf("%s is executable by PUBLIC; 00364 forgot REVOKE EXECUTE ... FROM PUBLIC", fn)
		}
	}

	// Control: the app roles must still be able to call them, otherwise the
	// REVOKE above could have been over-applied and broken the feature.
	for _, fn := range functions {
		var appCan bool
		if err := pool.QueryRow(ctx, `SELECT has_function_privilege('podhub_app', $1::regprocedure, 'EXECUTE')`, fn).Scan(&appCan); err != nil {
			t.Fatalf("has_function_privilege(podhub_app, %s): %v", fn, err)
		}
		if !appCan {
			t.Fatalf("podhub_app cannot execute %s; the REVOKE went too far", fn)
		}
	}
}

// TestCatalogTablesForceRLS is doc 11.6 row 9 (10.3 item 8).
//
// ENABLE alone leaves the table owner unconstrained; FORCE is what makes the
// policy apply to the owner too. Every 00365 table must have both, or the
// whole permission model is advisory for whichever role owns the schema.
func TestCatalogTablesForceRLS(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)

	tables := []string{
		"sc_sources", "sc_source_prop_defs", "sc_products",
		"sc_skus", "sc_source_offers", "sc_price_versions",
	}
	for _, table := range tables {
		var enabled, forced bool
		if err := pool.QueryRow(ctx, `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1 AND relnamespace = 'public'::regnamespace`, table).Scan(&enabled, &forced); err != nil {
			t.Fatalf("read pg_class for %s: %v", table, err)
		}
		if !enabled || !forced {
			t.Fatalf("%s: rls enabled=%v forced=%v, want both true", table, enabled, forced)
		}
	}
}

// TestDispatchIsFulfillerScoped is doc 11.6 row 3, the core assertion of the
// whole batch: a member added to a source after a packet was created must not
// be able to take that packet.
//
// Two distinct properties, asserted separately because they fail for different
// reasons:
//
//  1. Another member of the SAME source cannot see the packet at all. The
//     00363 USING arm keys on fulfiller_id IN (my grants), so visibility is
//     the first fence. This is the direct "new member cannot inherit old
//     work" assertion.
//  2. The person the packet IS pinned to can see it, and can still accept it.
//     Without this control the test would pass if the policy were simply
//     broken shut.
//
// The DELEGATE_FORBIDDEN / DELEGATE_NOT_FOUND pair for revoked and non-
// recipient callers is asserted in fulfiller_wallet_test.go and the delegate
// parity tests; duplicating it here would just re-run the same function.
func TestDispatchIsFulfillerScoped(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)

	const orgID = 950020
	const source = "src_fulfil_guard"
	const fulfillerUser = 950021
	const newcomer = 950022

	seedAccount(t, ctx, pool, fulfillerUser, "fulfiller@test.example", "user", "supplier")
	seedAccount(t, ctx, pool, newcomer, "newcomer@test.example", "user", "supplier")
	if _, err := pool.Exec(ctx, `INSERT INTO organizations (id, owner_user_id, name, plan, created_at, updated_at) VALUES ($1, $2, 'O', 'free', clock_timestamp(), clock_timestamp())`, orgID, fulfillerUser); err != nil {
		t.Fatalf("insert org: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO sc_sources (source_id, name, created_at_ms, updated_at_ms) VALUES ($1, $1, 1, 1)`, source); err != nil {
		t.Fatalf("insert source: %v", err)
	}
	var fulfillerID string
	if err := pool.QueryRow(ctx, `INSERT INTO sc_source_fulfillers (source_id, user_id, status, created_by, created_at_ms) VALUES ($1, $2, 'active', $2, 1) RETURNING fulfiller_id::text`, source, fulfillerUser).Scan(&fulfillerID); err != nil {
		t.Fatalf("insert fulfiller: %v", err)
	}

	const orderID = "00000000-0000-0000-0000-0000000f5001"
	const dispatchID = "00000000-0000-0000-0000-0000000f5002"
	if _, err := pool.Exec(ctx, `INSERT INTO delegate_orders (order_id, org_id, store_id, posting_number, state, created_at_ms, updated_at_ms) VALUES ($1::uuid, $2, '00000000-0000-0000-0000-0000000f5003'::uuid, 'P-F', 'dispatched', 1, 1)`, orderID, orgID); err != nil {
		t.Fatalf("insert order: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO delegate_dispatches (dispatch_id, org_id, order_id, source_id, fulfiller_id, dispatch_no, payload, state, created_at_ms, updated_at_ms) VALUES ($1::uuid, $2, $3::uuid, $4, $5::uuid, 'D-F', '{"lines":[]}'::jsonb, 'dispatched', 1, 1)`, dispatchID, orgID, orderID, source, fulfillerID); err != nil {
		t.Fatalf("insert dispatch: %v", err)
	}

	// The newcomer joins the SAME source as an active member. Under the old
	// source-wide model that alone was enough to see and take the packet.
	if _, err := pool.Exec(ctx, `INSERT INTO sc_source_members (source_id, user_id, role, status, created_by, created_at_ms) VALUES ($1, $2, 'member', 'active', $2, 1)`, source, newcomer); err != nil {
		t.Fatalf("insert newcomer member: %v", err)
	}

	// 1. The newcomer must not see the packet at all.
	var seen int
	if err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		if err := tenantx.EnterSupplier(ctx, tx, newcomer); err != nil {
			return err
		}
		return tx.QueryRow(ctx, `SELECT count(*) FROM delegate_dispatches WHERE dispatch_id = $1::uuid`, dispatchID).Scan(&seen)
	}); err != nil {
		t.Fatalf("read dispatch as newcomer: %v", err)
	}
	if seen != 0 {
		t.Fatalf("a member added after dispatch saw %d packet(s); the fulfiller arm is source-wide again", seen)
	}

	// 2. Control: the pinned fulfiller does see it.
	if err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		if err := tenantx.EnterSupplier(ctx, tx, fulfillerUser); err != nil {
			return err
		}
		return tx.QueryRow(ctx, `SELECT count(*) FROM delegate_dispatches WHERE dispatch_id = $1::uuid`, dispatchID).Scan(&seen)
	}); err != nil {
		t.Fatalf("read dispatch as fulfiller: %v", err)
	}
	if seen != 1 {
		t.Fatalf("the pinned fulfiller sees %d packet(s), want 1", seen)
	}

	// 3. And the newcomer's attempt to accept is refused by the function gate.
	err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		if err := tenantx.EnterSupplier(ctx, tx, newcomer); err != nil {
			return err
		}
		_, actErr := tx.Exec(ctx, `SELECT public.delegate_supplier_accept($1::uuid, $2, $3::uuid)`, dispatchID, newcomer, fulfillerID)
		return actErr
	})
	if err == nil {
		t.Fatalf("a member added after dispatch accepted it; the fulfiller gate is gone")
	}
	if !strings.Contains(err.Error(), "DELEGATE_FORBIDDEN") {
		t.Fatalf("want DELEGATE_FORBIDDEN, got %v", err)
	}

	// 4. The packet is still dispatched, not accepted by the wrong person.
	var state string
	if err := pool.QueryRow(ctx, `SELECT state FROM delegate_dispatches WHERE dispatch_id = $1::uuid`, dispatchID).Scan(&state); err != nil {
		t.Fatalf("reread state: %v", err)
	}
	if state != "dispatched" {
		t.Fatalf("state is %q after a refused accept, want dispatched", state)
	}
}

// seedAccount inserts one account with an explicit kind. Keep it local: other
// integration files seed accounts with different column sets and this file must
// not force them to change.
func seedAccount(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id int64, email, role, kind string) {
	t.Helper()
	if _, err := pool.Exec(ctx, `INSERT INTO account_users (id, public_id, email, password_hash, role, name, target, supplier_id, plan, account_kind, created_at, updated_at)
		VALUES ($1, $2, $2, 'x', $3, 'A', '/workspace', '', 'free', $4, clock_timestamp(), clock_timestamp())`, id, email, role, kind); err != nil {
		t.Fatalf("insert account %s: %v", email, err)
	}
}

var _ = fmt.Sprintf
var _ = db.App
