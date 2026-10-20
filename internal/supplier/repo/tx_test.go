package supplierrepo

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/supplier/contract"
)

type txState struct {
	user     string
	org      *string
	supplier *string
}

func (s txState) String() string {
	show := func(p *string) string {
		if p == nil {
			return "<nil>"
		}
		return strconv.Quote(*p)
	}
	return fmt.Sprintf("user=%s org=%s supplier=%s", s.user, show(s.org), show(s.supplier))
}

func readState(ctx context.Context, tx pgx.Tx) (txState, error) {
	var s txState
	err := tx.QueryRow(ctx, `
		SELECT current_user,
		       NULLIF(current_setting('app.current_org_id', true), ''),
		       NULLIF(current_setting('app.current_supplier_user_id', true), '')`).Scan(&s.user, &s.org, &s.supplier)
	return s, err
}

func strp(s string) *string { return &s }

// TestWithTxSessions pins the role and settings withTx applies for each id
// combination. Org 0 with a supplier user used to write the org setting as
// "0"; it is now unset. Policies match those two the same way, see
// platform/db TestOrgPoliciesUseEqualityOnly and TestSupplierOrgZeroMatchesUnset.
func TestWithTxSessions(t *testing.T) {
	pool, ctx := parityDB(t)
	repo := New(pool, tenant.BeginApp)
	cases := []struct {
		org, user int64
		want      txState
	}{
		{42, 7, txState{tenant.RoleApp, strp("42"), strp("7")}},
		{42, 0, txState{tenant.RoleApp, strp("42"), nil}},
		{42, -1, txState{tenant.RoleApp, strp("42"), nil}},
		{0, 7, txState{tenant.RoleApp, nil, strp("7")}},
		{-1, 7, txState{tenant.RoleApp, nil, strp("7")}},
	}
	for _, tc := range cases {
		var got txState
		err := repo.withTx(ctx, tc.org, tc.user, func(tx pgx.Tx) error {
			var err error
			got, err = readState(ctx, tx)
			return err
		})
		if err != nil {
			t.Fatalf("org=%d user=%d: %v", tc.org, tc.user, err)
		}
		if got.String() != tc.want.String() {
			t.Fatalf("org=%d user=%d: %s, want %s", tc.org, tc.user, got, tc.want)
		}
	}
	errFn := errors.New("fn")
	if err := repo.withTx(ctx, 0, 7, func(pgx.Tx) error { return errFn }); err != errFn {
		t.Fatalf("callback error %v", err)
	}
}

// TestWithTxIsolatesSuppliers is the two-tenant case through withTx with
// org 0, which is how every supplier-user read and write opens.
func TestWithTxIsolatesSuppliers(t *testing.T) {
	pool, ctx := parityDB(t)
	userA, userB := int64(882101), int64(882102)
	sourceA, sourceB := "src_tx_a", "src_tx_b"
	seedSupplier(t, ctx, pool, userA, sourceA)
	seedSupplier(t, ctx, pool, userB, sourceB)
	t.Cleanup(func() {
		dropSupplier(context.Background(), pool, userA, sourceA)
		dropSupplier(context.Background(), pool, userB, sourceB)
	})
	if _, err := pool.Exec(ctx, `
		INSERT INTO supplier_wallets (source_id, balance_microfen, held_microfen, updated_at_ms)
		VALUES ($1, 100, 0, 1), ($2, 200, 0, 1)`, sourceA, sourceB); err != nil {
		t.Fatal(err)
	}
	repo := New(pool, tenant.BeginApp)
	err := repo.withTx(ctx, 0, userA, func(tx pgx.Tx) error {
		var sources string
		if err := tx.QueryRow(ctx, `SELECT coalesce(string_agg(source_id, ','), '') FROM supplier_wallets`).Scan(&sources); err != nil {
			return err
		}
		if sources != sourceA {
			return fmt.Errorf("supplier A sees wallets %q", sources)
		}
		if err := tx.QueryRow(ctx, `SELECT coalesce(string_agg(source_id, ','), '') FROM sc_source_members`).Scan(&sources); err != nil {
			return err
		}
		if sources != sourceA {
			return fmt.Errorf("supplier A sees members %q", sources)
		}
		tag, err := tx.Exec(ctx, `UPDATE supplier_wallets SET balance_microfen = 0 WHERE source_id = $1`, sourceB)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 0 {
			return fmt.Errorf("supplier A updated source B (%d rows)", tag.RowsAffected())
		}
		if _, err := tx.Exec(ctx, `SAVEPOINT probe`); err != nil {
			return err
		}
		_, insErr := tx.Exec(ctx, `
			INSERT INTO supplier_withdrawals
			    (source_id, amount_cents, amount_microfen, channel, account, real_name, status, requested_at_ms)
			VALUES ($1, 1, 1000000, 'alipay', 'x', 'x', 'requested', 9)`, sourceB)
		if _, err := tx.Exec(ctx, `ROLLBACK TO SAVEPOINT probe`); err != nil {
			return err
		}
		if insErr == nil {
			return errors.New("supplier A inserted a withdrawal for source B")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	wallets, err := repo.ListWallets(ctx, 0, userB)
	if err != nil || len(wallets) != 1 || wallets[0].SourceID != sourceB || wallets[0].BalanceMicrofen != 200 {
		t.Fatalf("supplier B wallets %+v %v", wallets, err)
	}
}

// countingPool never reaches a server. Each Begin dials, so the counter is
// the number of transactions the repo tried to open.
func countingPool(t *testing.T) (*pgxpool.Pool, *atomic.Int32) {
	t.Helper()
	cfg, err := pgxpool.ParseConfig("postgres://u:p@127.0.0.1:1/db?connect_timeout=1")
	if err != nil {
		t.Fatal(err)
	}
	var dials atomic.Int32
	cfg.BeforeConnect = func(context.Context, *pgx.ConnConfig) error {
		dials.Add(1)
		return errors.New("no server")
	}
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool, &dials
}

func TestMissingTenantOpensNoTransaction(t *testing.T) {
	pool, dials := countingPool(t)
	repo := New(pool, tenant.BeginApp)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, ids := range [][2]int64{{0, 0}, {-1, 0}, {0, -1}, {-1, -1}} {
		if _, err := repo.ListWallets(ctx, ids[0], ids[1]); err != contract.ErrNoTenant {
			t.Fatalf("ListWallets %v: %v", ids, err)
		}
		if _, err := repo.ListWithdrawals(ctx, ids[0], ids[1]); err != contract.ErrNoTenant {
			t.Fatalf("ListWithdrawals %v: %v", ids, err)
		}
	}
	if n := dials.Load(); n != 0 {
		t.Fatalf("missing tenant dialed %d times", n)
	}
	if _, err := New(nil, tenant.BeginApp).ListWallets(ctx, 0, 7); err != contract.ErrUnavailable {
		t.Fatalf("nil pool: %v", err)
	}
	if _, err := New(pool, nil).ListWallets(ctx, 0, 7); err != contract.ErrUnavailable {
		t.Fatalf("nil begin: %v", err)
	}
	if _, err := repo.ListWallets(ctx, 0, 7); err == nil || dials.Load() == 0 {
		t.Fatalf("control call: err %v dials %d", err, dials.Load())
	}
}
