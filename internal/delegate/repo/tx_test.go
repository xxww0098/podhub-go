package delegaterepo

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/delegate/contract"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

type txState struct {
	user     string
	org      *string
	supplier *string
	staff    *string
}

func (s txState) String() string {
	show := func(p *string) string {
		if p == nil {
			return "<nil>"
		}
		return strconv.Quote(*p)
	}
	return fmt.Sprintf("user=%s org=%s supplier=%s staff=%s", s.user, show(s.org), show(s.supplier), show(s.staff))
}

func readState(ctx context.Context, tx pgx.Tx) (txState, error) {
	var s txState
	err := tx.QueryRow(ctx, `
		SELECT current_user,
		       NULLIF(current_setting('app.current_org_id', true), ''),
		       NULLIF(current_setting('app.current_supplier_user_id', true), ''),
		       NULLIF(current_setting('app.staff_access', true), '')`).Scan(&s.user, &s.org, &s.supplier, &s.staff)
	return s, err
}

func strp(s string) *string { return &s }

// TestWithTxSessions pins what withTx applies for each id combination.
// Org 0 with a supplier user used to write the org setting as "0"; it is
// now unset. platform/db TestOrgPoliciesUseEqualityOnly and
// TestSupplierOrgZeroMatchesUnset show policies treat the two the same.
func TestWithTxSessions(t *testing.T) {
	pool, ctx := parityDB(t)
	repo := New(pool, tenant.BeginApp)
	cases := []struct {
		org, user int64
		want      txState
	}{
		{42, 7, txState{user: tenant.RoleApp, org: strp("42"), supplier: strp("7")}},
		{42, 0, txState{user: tenant.RoleApp, org: strp("42")}},
		{42, -1, txState{user: tenant.RoleApp, org: strp("42")}},
		{0, 7, txState{user: tenant.RoleApp, supplier: strp("7")}},
		{-1, 7, txState{user: tenant.RoleApp, supplier: strp("7")}},
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

// TestStaffOpenMatchesOldStatement compares db.Staff with the statement
// resolveOrder and loadDetail used to run, then drives both functions.
func TestStaffOpenMatchesOldStatement(t *testing.T) {
	pool, ctx := parityDB(t)
	old, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer old.Rollback(ctx)
	if _, err := old.Exec(ctx, `SELECT set_config('role', 'podhub_app', true), set_config('app.staff_access', '1', true)`); err != nil {
		t.Fatal(err)
	}
	want, err := readState(ctx, old)
	if err != nil {
		t.Fatal(err)
	}
	var got txState
	if err := db.InTx(ctx, pool, db.Staff(), func(tx pgx.Tx) error {
		var err error
		got, err = readState(ctx, tx)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if got.String() != want.String() || want.String() != (txState{user: tenant.RoleApp, staff: strp("1")}).String() {
		t.Fatalf("old %s new %s", want, got)
	}

	seller := int64(880601)
	orgID := seedOrg(t, ctx, pool, seller, "staff")
	source := "src_staff_880601"
	seedSource(t, ctx, pool, source, "staff")
	t.Cleanup(func() { cleanupDelegate(t, context.Background(), pool, orgID, seller, source) })
	ready := true
	orderID, _ := seedPacket(t, ctx, pool, orgID, seller, source, "dispatched", "dispatched", &ready)
	repo := New(pool, tenant.BeginApp)
	gotOrg, posting, err := repo.resolveOrder(ctx, orderID)
	if err != nil || gotOrg != orgID || !strings.HasPrefix(posting, "post-") {
		t.Fatalf("resolveOrder %d %q %v", gotOrg, posting, err)
	}
	var api *contract.APIError
	if _, _, err := repo.resolveOrder(ctx, uuid.NewString()); !errors.As(err, &api) || api.Status != 404 {
		t.Fatalf("resolveOrder missing: %v", err)
	}
	body, err := repo.loadDetail(ctx, orderID)
	if err != nil || !strings.Contains(string(body), orderID) {
		t.Fatalf("loadDetail %s %v", body, err)
	}
	if _, err := repo.loadDetail(ctx, uuid.NewString()); !errors.As(err, &api) || api.Status != 404 {
		t.Fatalf("loadDetail missing: %v", err)
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

func TestOrgUnsetOpensNoTransaction(t *testing.T) {
	pool, dials := countingPool(t)
	repo := New(pool, tenant.BeginApp)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	nop := func(pgx.Tx) error { return nil }
	for _, org := range []int64{0, -1} {
		if err := repo.readTx(ctx, org, nop); !errors.Is(err, tenant.ErrOrgUnset) {
			t.Fatalf("readTx org=%d: %v", org, err)
		}
		if err := repo.writeTx(ctx, org, 1, nop); !errors.Is(err, tenant.ErrOrgUnset) {
			t.Fatalf("writeTx org=%d: %v", org, err)
		}
		if err := repo.writeOrg(ctx, org, nop); !errors.Is(err, tenant.ErrOrgUnset) {
			t.Fatalf("writeOrg org=%d: %v", org, err)
		}
		if _, err := repo.ListDispatches(ctx, org, 0); err != contract.ErrNoTenant {
			t.Fatalf("ListDispatches org=%d: %v", org, err)
		}
	}
	if n := dials.Load(); n != 0 {
		t.Fatalf("org unset dialed %d times", n)
	}
	if err := New(nil, tenant.BeginApp).readTx(ctx, 1, nop); err != contract.ErrUnavailable {
		t.Fatalf("readTx nil pool: %v", err)
	}
	if err := New(pool, nil).writeTx(ctx, 1, 1, nop); err != contract.ErrUnavailable {
		t.Fatalf("writeTx nil begin: %v", err)
	}
	var api *contract.APIError
	if err := New(pool, nil).writeOrg(ctx, 1, nop); !errors.As(err, &api) || api.Status != 500 {
		t.Fatalf("writeOrg nil begin: %v", err)
	}
	if _, _, err := New(nil, tenant.BeginApp).resolveOrder(ctx, "x"); !errors.As(err, &api) || api.Status != 500 {
		t.Fatalf("resolveOrder nil pool: %v", err)
	}
	if err := repo.readTx(ctx, 1, nop); err == nil || dials.Load() == 0 {
		t.Fatalf("control call: err %v dials %d", err, dials.Load())
	}
}

// TestDispatchAssetsOrgZero covers delegate_dispatch_assets, whose org_id
// has no foreign key or CHECK, so an org_id 0 row is not ruled out by the
// schema. The org-0 supplier open is the only open whose org setting
// changes ("0" to unset). It must neither read nor write this table, and
// nothing else in the repo may write it outside a real org.
func TestDispatchAssetsOrgZero(t *testing.T) {
	pool, ctx := parityDB(t)
	sellerA, sellerB := int64(880701), int64(880702)
	memberA := int64(880703)
	orgA := seedOrg(t, ctx, pool, sellerA, "dda-a")
	orgB := seedOrg(t, ctx, pool, sellerB, "dda-b")
	seedUser(t, ctx, pool, memberA, "dda-ma")
	sourceA, sourceB := "src_dda_a", "src_dda_b"
	seedSource(t, ctx, pool, sourceA, "dda-a")
	seedSource(t, ctx, pool, sourceB, "dda-b")
	seedMember(t, ctx, pool, sourceA, memberA, "active")
	t.Cleanup(func() {
		cleanupDelegate(t, context.Background(), pool, orgA, sellerA, sourceA)
		cleanupDelegate(t, context.Background(), pool, orgB, sellerB, sourceB)
		cleanupDelegate(t, context.Background(), pool, 0, memberA, "")
	})
	notReady := false
	_, dispatchA := seedPacket(t, ctx, pool, orgA, sellerA, sourceA, "dispatched", "dispatched", &notReady)
	_, dispatchB := seedPacket(t, ctx, pool, orgB, sellerB, sourceB, "dispatched", "dispatched", &notReady)
	if _, err := pool.Exec(ctx, `
		INSERT INTO delegate_dispatch_assets (dispatch_id, asset_id, org_id)
		VALUES ($1::uuid, $2::uuid, $3), ($4::uuid, $5::uuid, $6)`,
		dispatchA, uuid.NewString(), orgA, dispatchB, uuid.NewString(), orgB); err != nil {
		t.Fatal(err)
	}

	visible := func(tx pgx.Tx) (string, error) {
		var assets, dispatches, members int
		err := tx.QueryRow(ctx, `
			SELECT (SELECT count(*) FROM delegate_dispatch_assets),
			       (SELECT count(*) FROM delegate_dispatches),
			       (SELECT count(*) FROM sc_source_members)`).Scan(&assets, &dispatches, &members)
		return fmt.Sprintf("assets=%d dispatches=%d members=%d", assets, dispatches, members), err
	}
	oldTx, err := tenant.BeginApp(ctx, pool.Begin, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := oldTx.Exec(ctx, `SELECT set_config('app.current_supplier_user_id', $1, true)`, strconv.FormatInt(memberA, 10)); err != nil {
		t.Fatal(err)
	}
	oldSeen, err := visible(oldTx)
	_ = oldTx.Rollback(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var newSeen string
	if err := db.InTx(ctx, pool, db.Supplier(memberA), func(tx pgx.Tx) error {
		var err error
		newSeen, err = visible(tx)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if oldSeen != newSeen || newSeen != "assets=0 dispatches=1 members=1" {
		t.Fatalf("org \"0\" %s, unset %s", oldSeen, newSeen)
	}

	traced, trace := delegateTracedPool(t, ctx, pool)
	repo := New(traced, tenant.BeginApp)
	trace.reset()
	if _, err := repo.ListDispatches(ctx, 0, memberA); err != nil {
		t.Fatal(err)
	}
	if state, err := repo.Accept(ctx, 0, memberA, dispatchA); err != nil || state != "accepted" {
		t.Fatalf("accept %s %v", state, err)
	}
	if state, err := repo.Ship(ctx, 0, memberA, dispatchA, "T1", "", 5); err != nil || state != "shipped" {
		t.Fatalf("ship %s %v", state, err)
	}
	if _, err := repo.Reject(ctx, 0, memberA, dispatchB, "x"); err == nil {
		t.Fatal("supplier A rejected supplier B's dispatch")
	}
	if n := trace.count("delegate_dispatch_assets"); n != 0 {
		t.Fatalf("org-0 supplier statements touched delegate_dispatch_assets %d times", n)
	}
	var functions, triggers []string
	rows, err := pool.Query(ctx, `
		SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
		 WHERE n.nspname = 'public' AND p.prosrc LIKE '%delegate_dispatch_assets%'`)
	if err != nil {
		t.Fatal(err)
	}
	if functions, err = pgx.CollectRows(rows, pgx.RowTo[string]); err != nil {
		t.Fatal(err)
	}
	rows, err = pool.Query(ctx, `
		SELECT tgname::text FROM pg_trigger
		 WHERE NOT tgisinternal AND tgrelid = 'delegate_dispatch_assets'::regclass`)
	if err != nil {
		t.Fatal(err)
	}
	if triggers, err = pgx.CollectRows(rows, pgx.RowTo[string]); err != nil {
		t.Fatal(err)
	}
	if len(functions) != 0 || len(triggers) != 0 {
		t.Fatalf("server-side readers of delegate_dispatch_assets: functions %v triggers %v", functions, triggers)
	}
	var stored int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM delegate_dispatch_assets WHERE dispatch_id IN ($1::uuid, $2::uuid)`, dispatchA, dispatchB).Scan(&stored); err != nil || stored != 2 {
		t.Fatalf("dispatch assets after supplier actions %d %v", stored, err)
	}

	// The only Go writer is insertDispatchAssets. Its callers all run in
	// writeTx or writeOrg with App(org), and WITH CHECK pins org_id to that org.
	if got := goFilesMentioning(t, "delegate_dispatch_assets"); strings.Join(got, ",") !=
		"internal/delegate/repo/seller_bind.go,internal/delegate/repo/seller_order.go" {
		t.Fatalf("delegate_dispatch_assets users: %v", got)
	}
	err = db.InTx(ctx, pool, db.App(orgA), func(tx pgx.Tx) error {
		return expectFail(ctx, tx, `
			INSERT INTO delegate_dispatch_assets (dispatch_id, asset_id, org_id)
			VALUES ($1::uuid, $2::uuid, 0)`, dispatchA, uuid.NewString())
	})
	if err != nil {
		t.Fatalf("App(org) wrote an org_id 0 asset row: %v", err)
	}
}

func expectFail(ctx context.Context, tx pgx.Tx, sql string, args ...any) error {
	if _, err := tx.Exec(ctx, `SAVEPOINT probe`); err != nil {
		return err
	}
	_, execErr := tx.Exec(ctx, sql, args...)
	if _, err := tx.Exec(ctx, `ROLLBACK TO SAVEPOINT probe`); err != nil {
		return err
	}
	if execErr == nil {
		return errors.New("statement succeeded")
	}
	return nil
}

func goFilesMentioning(t *testing.T, word string) []string {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	err = filepath.WalkDir(filepath.Join(root, "internal"), func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if strings.Contains(string(b), word) {
			rel, _ := filepath.Rel(root, path)
			out = append(out, filepath.ToSlash(rel))
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(out)
	return out
}
