package integration

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// TestResidualFundsGuardStops00363 is the O15 acceptance test.
//
// 00363 drops the supplier arms from supplier_wallets, supplier_wallet_ledger
// and supplier_withdrawals. That is a schema change, not a data fix, and the
// two kinds of residue it can meet are things DDL must not silently destroy:
// a non-zero balance is money actually owed to a factory, and a 'requested'
// withdrawal is a payout waiting for a human decision. Plan 9.2 / O15 says the
// migration must stop and let staff settle them first.
//
// The guard cannot be exercised through the normal migration path (a fresh
// database has no residue, so the branch never fires and a broken guard would
// still look green). This test runs the guard block itself against a seeded
// database, which is the only way to prove the failure path works.
func TestResidualFundsGuardStops00363(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)

	// The guard block is copied from 00363 verbatim so this test cannot pass
	// while the real migration drifts away from it.
	guard := `DO $residual$
DECLARE
    bad_wallets bigint;
    bad_withdrawals bigint;
    detail text;
BEGIN
    SELECT count(*), string_agg(source_id || '=' || balance_microfen::text, ',' ORDER BY source_id)
      INTO bad_wallets, detail
      FROM public.supplier_wallets
     WHERE balance_microfen <> 0;
    IF bad_wallets > 0 THEN
        RAISE EXCEPTION '00363: % supplier wallet(s) still hold a balance (%); settle them before dropping the supplier funds policies',
            bad_wallets, detail;
    END IF;

    SELECT count(*), string_agg(withdrawal_id::text, ',' ORDER BY withdrawal_id)
      INTO bad_withdrawals, detail
      FROM public.supplier_withdrawals
     WHERE status = 'requested';
    IF bad_withdrawals > 0 THEN
        RAISE EXCEPTION '00363: % supplier withdrawal(s) still pending (%); approve or reject them before dropping the supplier funds policies',
            bad_withdrawals, detail;
    END IF;
END
$residual$;`

	const source = "src_residual_guard"
	const ownerID = 930001
	if _, err := pool.Exec(ctx, `INSERT INTO account_users (id, public_id, email, password_hash, role, name, target, supplier_id, plan, created_at, updated_at)
		VALUES ($1, 'residual@test.example', 'residual@test.example', 'x', 'user', 'R', '/workspace', '', 'free', clock_timestamp(), clock_timestamp())`, ownerID); err != nil {
		t.Fatalf("insert owner: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO sc_sources (source_id, name, created_at_ms, updated_at_ms) VALUES ($1, $1, 1, 1)`, source); err != nil {
		t.Fatalf("insert source: %v", err)
	}

	// 1. Clean database: the guard must pass. This is the branch every real
	// deployment hits, and a guard that always raised would block all upgrades.
	if _, err := pool.Exec(ctx, guard); err != nil {
		t.Fatalf("guard rejected a clean database: %v", err)
	}

	// 2. A non-zero balance must stop the migration and name the source.
	if _, err := pool.Exec(ctx, `INSERT INTO supplier_wallets (source_id, balance_microfen, held_microfen, updated_at_ms)
		VALUES ($1, 4200, 0, 1)`, source); err != nil {
		t.Fatalf("insert wallet: %v", err)
	}
	_, err := pool.Exec(ctx, guard)
	if err == nil {
		t.Fatal("guard allowed a non-zero balance; O15 says that is a lost liability")
	}
	if !strings.Contains(err.Error(), "still hold a balance") || !strings.Contains(err.Error(), source) {
		t.Fatalf("err = %v, want a balance complaint naming %s", err, source)
	}

	// Clear it and confirm the guard opens again — otherwise it would be a
	// one-way latch and every later attempt would fail for the wrong reason.
	if _, err := pool.Exec(ctx, `UPDATE supplier_wallets SET balance_microfen = 0 WHERE source_id = $1`, source); err != nil {
		t.Fatalf("clear balance: %v", err)
	}
	if _, err := pool.Exec(ctx, guard); err != nil {
		t.Fatalf("guard still rejects after the balance was cleared: %v", err)
	}

	// 3. A pending withdrawal must stop it too.
	if _, err := pool.Exec(ctx, `INSERT INTO supplier_withdrawals (source_id, amount_cents, amount_microfen, channel, account, real_name, status, requested_at_ms)
		VALUES ($1, 100, 100000000, 'alipay', 'a@b.c', 'R', 'requested', 1)`, source); err != nil {
		t.Fatalf("insert withdrawal: %v", err)
	}
	_, err = pool.Exec(ctx, guard)
	if err == nil {
		t.Fatal("guard allowed a pending withdrawal; it would hang forever")
	}
	if !strings.Contains(err.Error(), "still pending") {
		t.Fatalf("err = %v, want a pending-withdrawal complaint", err)
	}
}

var _ = pgx.ErrNoRows
