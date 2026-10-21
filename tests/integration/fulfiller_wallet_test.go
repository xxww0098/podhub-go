package integration

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

// TestFulfillerWalletCreditIsReachableFromSupplierSession is the 00363/00364
// regression test for P0-A.
//
// 00363 F2 drops supplier_source_isolation from supplier_wallets and
// supplier_wallet_ledger because a supplier has no funds surface any more.
// Those tables are ENABLE + FORCE ROW LEVEL SECURITY, so after that drop a
// supplier session has no arm left and every write raised 42501. Ship credits
// the factory wallet, and Ship runs in a supplier session, so shipping was
// impossible and the packet stayed 'accepted' forever.
//
// The fix routes the credit through delegate_credit_fulfiller_wallet, a
// SECURITY DEFINER function. This test proves the reachability claim, because
// it is the one thing that cannot be checked by reading the policy: a definer
// function owned by the migration role is not subject to FORCE RLS.
func TestFulfillerWalletCreditIsReachableFromSupplierSession(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)

	const source = "src_wallet_credit"
	const dispatchID = "7a1f9e2c-0000-4000-8000-000000000001"
	const orderID = "7a1f9e2c-0000-4000-8000-000000000002"
	const bindingID = "7a1f9e2c-0000-4000-8000-000000000003"
	var fulfillerID string
	var userID int64
	if err := pool.QueryRow(ctx, `INSERT INTO account_users (id, public_id, email, password_hash, role, name, target, supplier_id, account_kind, plan, created_at, updated_at)
		VALUES (920001, 'fulfiller@test.example', 'fulfiller@test.example', 'x', 'user', 'F', '/supplier', $1, 'supplier', 'free', clock_timestamp(), clock_timestamp())
		RETURNING id`, source).Scan(&userID); err != nil {
		t.Fatalf("insert fulfiller user: %v", err)
	}
	var orgID int64
	if err := pool.QueryRow(ctx, `INSERT INTO organizations (owner_user_id, name, plan, created_at, updated_at)
		VALUES ($1, 'wallet credit org', 'free', clock_timestamp(), clock_timestamp()) RETURNING id`, userID).Scan(&orgID); err != nil {
		t.Fatalf("insert org: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO sc_sources (source_id, name, created_at_ms, updated_at_ms)
		VALUES ($1, $1, 1, 1)`, source); err != nil {
		t.Fatalf("insert source: %v", err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO sc_source_fulfillers (source_id, user_id, created_at_ms)
		VALUES ($1, $2, 1) RETURNING fulfiller_id::text`, source, userID).Scan(&fulfillerID); err != nil {
		t.Fatalf("insert fulfiller: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO delegate_orders (order_id, org_id, store_id, posting_number, state, created_at_ms, updated_at_ms)
		VALUES ($1::uuid, $2, gen_random_uuid(), 'WALLET-1', 'dispatched', 1, 1)`, orderID, orgID); err != nil {
		t.Fatalf("insert order: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO delegate_dispatches (dispatch_id, org_id, order_id, source_id, dispatch_no, payload, state, fulfiller_id, created_at_ms, updated_at_ms)
		VALUES ($1::uuid, $2, $3::uuid, $4, 'WALLET-1-D1', '{}'::jsonb, 'accepted', $5::uuid, 1, 1)`,
		dispatchID, orgID, orderID, source, fulfillerID); err != nil {
		t.Fatalf("insert dispatch: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO delegate_settlements (org_id, order_id, dispatch_id, source_id, amount_cents, amount_microfen, state, breakdown, held_at_ms)
		VALUES ($1, $2::uuid, $3::uuid, $4, 250, 250000000, 'settled', '{}'::jsonb, 1)`,
		orgID, orderID, dispatchID, source); err != nil {
		t.Fatalf("insert settlement: %v", err)
	}
	_ = bindingID

	// Run the credit exactly the way Ship does: inside a supplier session,
	// with app.current_supplier_user_id set and no staff_access.
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := tenant.EnterSupplier(ctx, tx, userID); err != nil {
		t.Fatalf("enter supplier: %v", err)
	}
	if _, err := tx.Exec(ctx, `SELECT public.delegate_credit_fulfiller_wallet($1::uuid, $2)`, dispatchID, int64(1000)); err != nil {
		t.Fatalf("credit from supplier session: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}

	// Read back as staff (the supplier cannot see the wallet any more, which
	// is the whole point of F2).
	var balance, held int64
	if err := pool.QueryRow(ctx, `SELECT balance_microfen, held_microfen FROM supplier_wallets WHERE source_id = $1`, source).Scan(&balance, &held); err != nil {
		t.Fatalf("read wallet: %v", err)
	}
	if balance != 250000000 || held != 0 {
		t.Fatalf("wallet = (%d, %d), want (250000000, 0)", balance, held)
	}
	var entries int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM supplier_wallet_ledger WHERE source_id = $1 AND entry_type = 'credit'`, source).Scan(&entries); err != nil {
		t.Fatalf("count ledger: %v", err)
	}
	if entries != 1 {
		t.Fatalf("ledger entries = %d, want 1", entries)
	}

	// Idempotency: a retried ship must not pay twice.
	tx2, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin 2: %v", err)
	}
	defer func() { _ = tx2.Rollback(ctx) }()
	if err := tenant.EnterSupplier(ctx, tx2, userID); err != nil {
		t.Fatalf("enter supplier 2: %v", err)
	}
	if _, err := tx2.Exec(ctx, `SELECT public.delegate_credit_fulfiller_wallet($1::uuid, $2)`, dispatchID, int64(2000)); err != nil {
		t.Fatalf("second credit: %v", err)
	}
	if err := tx2.Commit(ctx); err != nil {
		t.Fatalf("commit 2: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT balance_microfen FROM supplier_wallets WHERE source_id = $1`, source).Scan(&balance); err != nil {
		t.Fatalf("reread wallet: %v", err)
	}
	if balance != 250000000 {
		t.Fatalf("balance after replay = %d, want 250000000 (idempotent)", balance)
	}
}

// TestFulfillerWalletCreditRejectsStranger is the other half: the definer
// function must not be a money faucet for someone who is not the packet's
// pinned fulfiller.
func TestFulfillerWalletCreditRejectsStranger(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)

	const source = "src_wallet_denied"
	const dispatchID = "7a1f9e2c-0000-4000-8000-000000000011"
	const orderID = "7a1f9e2c-0000-4000-8000-000000000012"
	var ownerID, strangerID int64
	if err := pool.QueryRow(ctx, `INSERT INTO account_users (id, public_id, email, password_hash, role, name, target, supplier_id, account_kind, plan, created_at, updated_at)
		VALUES (920011, 'owner@test.example', 'owner@test.example', 'x', 'user', 'O', '/supplier', $1, 'supplier', 'free', clock_timestamp(), clock_timestamp()) RETURNING id`, source).Scan(&ownerID); err != nil {
		t.Fatalf("insert owner: %v", err)
	}
	var orgID int64
	if err := pool.QueryRow(ctx, `INSERT INTO organizations (owner_user_id, name, plan, created_at, updated_at)
		VALUES ($1, 'wallet denied org', 'free', clock_timestamp(), clock_timestamp()) RETURNING id`, ownerID).Scan(&orgID); err != nil {
		t.Fatalf("insert org: %v", err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO account_users (id, public_id, email, password_hash, role, name, target, supplier_id, account_kind, plan, created_at, updated_at)
		VALUES (920012, 'stranger2@test.example', 'stranger2@test.example', 'x', 'user', 'S', '/supplier', 'src_other', 'supplier', 'free', clock_timestamp(), clock_timestamp()) RETURNING id`).Scan(&strangerID); err != nil {
		t.Fatalf("insert stranger: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO sc_sources (source_id, name, created_at_ms, updated_at_ms) VALUES ($1, $1, 1, 1)`, source); err != nil {
		t.Fatalf("insert source: %v", err)
	}
	var fulfillerID string
	if err := pool.QueryRow(ctx, `INSERT INTO sc_source_fulfillers (source_id, user_id, created_at_ms)
		VALUES ($1, $2, 1) RETURNING fulfiller_id::text`, source, ownerID).Scan(&fulfillerID); err != nil {
		t.Fatalf("insert fulfiller: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO delegate_orders (order_id, org_id, store_id, posting_number, state, created_at_ms, updated_at_ms)
		VALUES ($1::uuid, $2, gen_random_uuid(), 'WALLET-2', 'dispatched', 1, 1)`, orderID, orgID); err != nil {
		t.Fatalf("insert order: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO delegate_dispatches (dispatch_id, org_id, order_id, source_id, dispatch_no, payload, state, fulfiller_id, created_at_ms, updated_at_ms)
		VALUES ($1::uuid, $2, $3::uuid, $4, 'WALLET-2-D1', '{}'::jsonb, 'accepted', $5::uuid, 1, 1)`,
		dispatchID, orgID, orderID, source, fulfillerID); err != nil {
		t.Fatalf("insert dispatch: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO delegate_settlements (org_id, order_id, dispatch_id, source_id, amount_cents, amount_microfen, state, breakdown, held_at_ms)
		VALUES ($1, $2::uuid, $3::uuid, $4, 100, 100000000, 'settled', '{}'::jsonb, 1)`,
		orgID, orderID, dispatchID, source); err != nil {
		t.Fatalf("insert settlement: %v", err)
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := tenant.EnterSupplier(ctx, tx, strangerID); err != nil {
		t.Fatalf("enter supplier: %v", err)
	}
	_, err = tx.Exec(ctx, `SELECT public.delegate_credit_fulfiller_wallet($1::uuid, $2)`, dispatchID, int64(1000))
	if err == nil {
		t.Fatal("stranger credited a wallet; the definer function is a money faucet")
	}
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "P0001" {
		t.Fatalf("err = %v, want raised DELEGATE_FORBIDDEN", err)
	}
}
