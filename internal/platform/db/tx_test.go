package db

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/tests/testkit"
)

func TestInTxRejectsUnsetIDsBeforeBegin(t *testing.T) {
	ctx := context.Background()
	cases := []struct {
		name    string
		session Session
		want    error
	}{
		{"app zero", App(0), tenantx.ErrOrgUnset},
		{"app negative", App(-1), tenantx.ErrOrgUnset},
		{"wallet org", WalletUser(0, 7), tenantx.ErrOrgUnset},
		{"supplier org", SupplierUser(-3, 7), tenantx.ErrOrgUnset},
		{"observer zero", Observer(0), tenantx.ErrUserUnset},
		{"observer negative", Observer(-1), tenantx.ErrUserUnset},
		{"wallet user", WalletUser(7, 0), tenantx.ErrUserUnset},
		{"supplier user", SupplierUser(7, -1), tenantx.ErrUserUnset},
		{"grant empty", AutomationGrant(""), tenantx.ErrGrantUnset},
		{"grant blank", AutomationGrant("  "), tenantx.ErrGrantUnset},
		{"empty session", Session{}, errEmptySession},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			begin := &failBegin{}
			err := InTx(ctx, begin, tc.session, func(pgx.Tx) error { return nil })
			if !errors.Is(err, tc.want) {
				t.Fatalf("error %v, want %v", err, tc.want)
			}
			if begin.calls != 0 {
				t.Fatalf("Begin called %d times", begin.calls)
			}
		})
	}
	begin := &failBegin{}
	if err := InTx(ctx, nil, App(1), func(pgx.Tx) error { return nil }); !errors.Is(err, errNilPool) {
		t.Fatalf("nil pool: %v", err)
	}
	if err := InTx(ctx, begin, App(1), nil); !errors.Is(err, errNilFn) || begin.calls != 0 {
		t.Fatalf("nil fn: %v calls %d", err, begin.calls)
	}
}

type failBegin struct{ calls int }

func (f *failBegin) Begin(context.Context) (pgx.Tx, error) {
	f.calls++
	return nil, errors.New("begin")
}

func TestSessionMatchesExistingPath(t *testing.T) {
	pool, ctx := sessionDB(t)
	const (
		orgID  int64 = 42
		userID int64 = 88022
		grant        = "44444444-4444-4444-8444-444444444444"
	)
	cases := []struct {
		name string
		old  func(context.Context, txBegin) (pgx.Tx, error)
		sess Session
		want snap
	}{
		{
			name: "app",
			old: func(ctx context.Context, begin txBegin) (pgx.Tx, error) {
				return tenantx.BeginApp(ctx, begin, orgID)
			},
			sess: App(orgID),
			want: snap{user: tenantx.RoleApp, org: strPtr(strconv.FormatInt(orgID, 10))},
		},
		{
			name: "worker",
			old: func(ctx context.Context, begin txBegin) (pgx.Tx, error) {
				return tenantx.BeginWorker(ctx, begin)
			},
			sess: Worker(),
			want: snap{user: tenantx.RoleWorker},
		},
		{
			name: "staff",
			old:  oldStaff,
			sess: Staff(),
			want: snap{user: tenantx.RoleApp, staff: strPtr("1")},
		},
		{
			name: "observer",
			old: func(ctx context.Context, begin txBegin) (pgx.Tx, error) {
				return oldObserver(ctx, begin, userID)
			},
			sess: Observer(userID),
			want: snap{user: tenantx.RoleApp, observer: strPtr(strconv.FormatInt(userID, 10))},
		},
		{
			name: "wallet",
			old: func(ctx context.Context, begin txBegin) (pgx.Tx, error) {
				return oldWallet(ctx, begin, orgID, userID)
			},
			sess: WalletUser(orgID, userID),
			want: snap{
				user:   tenantx.RoleApp,
				org:    strPtr(strconv.FormatInt(orgID, 10)),
				wallet: strPtr(strconv.FormatInt(userID, 10)),
			},
		},
		{
			name: "supplier",
			old: func(ctx context.Context, begin txBegin) (pgx.Tx, error) {
				return oldSupplier(ctx, begin, orgID, userID)
			},
			sess: SupplierUser(orgID, userID),
			want: snap{
				user:     tenantx.RoleApp,
				org:      strPtr(strconv.FormatInt(orgID, 10)),
				supplier: strPtr(strconv.FormatInt(userID, 10)),
			},
		},
		{
			name: "grant",
			old: func(ctx context.Context, begin txBegin) (pgx.Tx, error) {
				return oldGrant(ctx, begin, grant)
			},
			sess: AutomationGrant(grant),
			want: snap{user: tenantx.RoleApp, grant: strPtr(grant)},
		},
		{
			name: "catalog",
			old:  oldCatalog,
			sess: Catalog(),
			want: snap{user: tenantx.RoleCatalog},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// A custom GUC stays visible as an empty string on a connection
			// after the transaction that first mentioned it ends. Each path
			// gets a new connection so an unset value stays NULL.
			fresh := freshBegin{dsn: sessionDSN}
			oldTx, err := tc.old(ctx, fresh.Begin)
			if err != nil {
				t.Fatal(err)
			}
			defer oldTx.Rollback(ctx)
			gotOld, err := readSnap(ctx, oldTx)
			if err != nil {
				t.Fatal(err)
			}
			var gotNew snap
			err = InTx(ctx, fresh, tc.sess, func(tx pgx.Tx) error {
				var readErr error
				gotNew, readErr = readSnap(ctx, tx)
				return readErr
			})
			if err != nil {
				t.Fatal(err)
			}
			if !gotOld.equal(gotNew) {
				t.Fatalf("old %s new %s", gotOld, gotNew)
			}
			if !gotOld.equal(tc.want) {
				t.Fatalf("path %s want %s", gotOld, tc.want)
			}
		})
	}
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	if err := InTx(ctx, conn, App(orgID), func(pgx.Tx) error { return nil }); err != nil {
		t.Fatal(err)
	}
	var login string
	if err := conn.QueryRow(ctx, `SELECT current_user`).Scan(&login); err != nil {
		t.Fatal(err)
	}
	if login == tenantx.RoleApp || login == tenantx.RoleWorker || login == tenantx.RoleCatalog {
		t.Fatalf("role leaked onto the connection: %s", login)
	}
}

func TestInTxRLSIsolatesOrgs(t *testing.T) {
	pool, ctx := sessionDB(t)
	orgA, storeA, _ := seedSessionOrg(t, ctx, pool, 770001, "a")
	orgB, _, _ := seedSessionOrg(t, ctx, pool, 770002, "b")
	now := time.Date(2026, 10, 17, 0, 0, 0, 0, time.UTC)

	err := InTx(ctx, pool, App(orgA), func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			INSERT INTO store_rating_snapshots
			    (org_id, store_id, rating_key, name, value_type, status, synced_at)
			VALUES ($1, $2::uuid, 'rating_wrap', '', '', 'UNKNOWN', $3)`, orgA, storeA, now)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	err = InTx(ctx, pool, App(orgA), func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			INSERT INTO store_rating_snapshots
			    (org_id, store_id, rating_key, name, value_type, status, synced_at)
			VALUES ($1, $2::uuid, 'rating_rollback', '', '', 'UNKNOWN', $3)`, orgA, storeA, now); err != nil {
			return err
		}
		return errors.New("force rollback")
	})
	if err == nil || err.Error() != "force rollback" {
		t.Fatalf("rollback: %v", err)
	}

	assertVisible := func(session Session, key string, want int) {
		t.Helper()
		var n int
		err := InTx(ctx, pool, session, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `
				SELECT count(*) FROM store_rating_snapshots WHERE rating_key = $1`, key).Scan(&n)
		})
		if err != nil || n != want {
			t.Fatalf("%s visible %d err %v, want %d", key, n, err, want)
		}
	}
	assertVisible(App(orgA), "rating_wrap", 1)
	assertVisible(App(orgA), "rating_rollback", 0)

	tx, err := tenantx.BeginApp(ctx, pool.Begin, orgA)
	if err != nil {
		t.Fatal(err)
	}
	var seen int
	err = tx.QueryRow(ctx, `SELECT count(*) FROM store_rating_snapshots WHERE rating_key = 'rating_wrap'`).Scan(&seen)
	_ = tx.Rollback(ctx)
	if err != nil || seen != 1 {
		t.Fatalf("old path sees %d %v", seen, err)
	}

	err = InTx(ctx, pool, App(orgB), func(tx pgx.Tx) error {
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM store_rating_snapshots`).Scan(&n); err != nil {
			return err
		}
		if n != 0 {
			return fmt.Errorf("org B sees %d", n)
		}
		tag, err := tx.Exec(ctx, `UPDATE store_rating_snapshots SET name = 'stolen' WHERE org_id = $1`, orgA)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 0 {
			return fmt.Errorf("org B updated %d", tag.RowsAffected())
		}
		tag, err = tx.Exec(ctx, `DELETE FROM store_rating_snapshots WHERE org_id = $1`, orgA)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 0 {
			return fmt.Errorf("org B deleted %d", tag.RowsAffected())
		}
		return expectExecFail(ctx, tx, `
			INSERT INTO store_rating_snapshots
			    (org_id, store_id, rating_key, name, value_type, status, synced_at)
			VALUES ($1, $2::uuid, 'rating_stolen', '', '', 'UNKNOWN', $3)`, orgA, storeA, now)
	})
	if err != nil {
		t.Fatal(err)
	}

	err = InTx(ctx, pool, Staff(), func(tx pgx.Tx) error {
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM store_rating_snapshots`).Scan(&n); err != nil {
			return err
		}
		if n != 0 {
			return fmt.Errorf("staff sees %d", n)
		}
		return expectExecFail(ctx, tx, `
			INSERT INTO store_rating_snapshots
			    (org_id, store_id, rating_key, name, value_type, status, synced_at)
			VALUES ($1, $2::uuid, 'rating_staff', '', '', 'UNKNOWN', $3)`, orgA, storeA, now)
	})
	if err != nil {
		t.Fatal(err)
	}

	bare, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer bare.Rollback(ctx)
	if _, err := bare.Exec(ctx, `SELECT set_config('role', $1, true)`, tenantx.RoleApp); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := bare.QueryRow(ctx, `SELECT count(*) FROM store_rating_snapshots`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("missing guc sees %d %v", n, err)
	}
	if _, err := bare.Exec(ctx, `
		INSERT INTO store_rating_snapshots
		    (org_id, store_id, rating_key, name, value_type, status, synced_at)
		VALUES ($1, $2::uuid, 'rating_bare', '', '', 'UNKNOWN', $3)`, orgA, storeA, now); err == nil {
		t.Fatal("missing guc inserted a snapshot")
	}
}

type txBegin func(context.Context) (pgx.Tx, error)

// freshBegin opens a new session for every transaction. Custom GUCs are
// session-scoped placeholders: after one transaction mentions them,
// current_setting reports an empty string instead of NULL.
type freshBegin struct{ dsn string }

func (f freshBegin) Begin(ctx context.Context) (pgx.Tx, error) {
	conn, err := pgx.Connect(ctx, f.dsn)
	if err != nil {
		return nil, err
	}
	tx, err := conn.Begin(ctx)
	if err != nil {
		_ = conn.Close(ctx)
		return nil, err
	}
	return &ownedTx{Tx: tx, own: &ownedConn{conn: conn}}, nil
}

type ownedConn struct {
	conn *pgx.Conn
	once sync.Once
}

func (o *ownedConn) close(ctx context.Context) {
	o.once.Do(func() { _ = o.conn.Close(ctx) })
}

type ownedTx struct {
	pgx.Tx
	own *ownedConn
}

func (t *ownedTx) Commit(ctx context.Context) error {
	err := t.Tx.Commit(ctx)
	t.own.close(ctx)
	return err
}

func (t *ownedTx) Rollback(ctx context.Context) error {
	err := t.Tx.Rollback(ctx)
	t.own.close(ctx)
	return err
}

func expectExecFail(ctx context.Context, tx pgx.Tx, sql string, args ...any) error {
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

// oldStaff is admin BeginStaff: role, then the staff flag. No org.
func oldStaff(ctx context.Context, begin txBegin) (pgx.Tx, error) {
	tx, err := begin(ctx)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.staff_access', '1', true)`); err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	return tx, nil
}

// oldObserver is the digest and catalog-list open: role and observer id.
func oldObserver(ctx context.Context, begin txBegin, userID int64) (pgx.Tx, error) {
	tx, err := begin(ctx)
	if err != nil {
		return nil, err
	}
	_, err = tx.Exec(ctx,
		`SELECT set_config('role', 'podhub_app', true), set_config('app.platform_observer_id', $1, true)`,
		strconv.FormatInt(userID, 10))
	if err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	return tx, nil
}

// oldWallet is billing withWallet's two statements, without the later role reset.
func oldWallet(ctx context.Context, begin txBegin, orgID, userID int64) (pgx.Tx, error) {
	tx, err := begin(ctx)
	if err != nil {
		return nil, err
	}
	_, err = tx.Exec(ctx,
		`SELECT set_config('app.current_org_id', $1, true), set_config('app.current_wallet_user_id', $2, true)`,
		strconv.FormatInt(orgID, 10), strconv.FormatInt(userID, 10))
	if err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('role', $1, true)`, tenantx.RoleApp); err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	return tx, nil
}

// oldSupplier is supplier withTx when both ids are set: BeginApp, then the supplier GUC.
func oldSupplier(ctx context.Context, begin txBegin, orgID, userID int64) (pgx.Tx, error) {
	tx, err := tenantx.BeginApp(ctx, begin, orgID)
	if err != nil {
		return nil, err
	}
	_, err = tx.Exec(ctx, `SELECT set_config('app.current_supplier_user_id', $1, true)`, strconv.FormatInt(userID, 10))
	if err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	return tx, nil
}

// oldGrant is mcp scopeGrant.
func oldGrant(ctx context.Context, begin txBegin, grantID string) (pgx.Tx, error) {
	tx, err := begin(ctx)
	if err != nil {
		return nil, err
	}
	_, err = tx.Exec(ctx,
		`SELECT set_config('role', $1, true), set_config('app.automation_grant_id', $2, true)`,
		tenantx.RoleApp, grantID)
	if err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	return tx, nil
}

// oldCatalog is the catalog writer role switch.
func oldCatalog(ctx context.Context, begin txBegin) (pgx.Tx, error) {
	tx, err := begin(ctx)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('role', 'podhub_ozon_catalog', true)`); err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	return tx, nil
}

type snap struct {
	user     string
	org      *string
	staff    *string
	observer *string
	wallet   *string
	supplier *string
	grant    *string
}

func (s snap) equal(o snap) bool {
	return s.user == o.user &&
		sameStr(s.org, o.org) &&
		sameStr(s.staff, o.staff) &&
		sameStr(s.observer, o.observer) &&
		sameStr(s.wallet, o.wallet) &&
		sameStr(s.supplier, o.supplier) &&
		sameStr(s.grant, o.grant)
}

func sameStr(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func (s snap) String() string {
	return fmt.Sprintf("user=%s org=%s staff=%s observer=%s wallet=%s supplier=%s grant=%s",
		s.user, showStr(s.org), showStr(s.staff), showStr(s.observer), showStr(s.wallet), showStr(s.supplier), showStr(s.grant))
}

func showStr(p *string) string {
	if p == nil {
		return "<nil>"
	}
	return strconv.Quote(*p)
}

func readSnap(ctx context.Context, tx pgx.Tx) (snap, error) {
	var s snap
	err := tx.QueryRow(ctx, `
		SELECT current_user,
		       current_setting('app.current_org_id', true),
		       current_setting('app.staff_access', true),
		       current_setting('app.platform_observer_id', true),
		       current_setting('app.current_wallet_user_id', true),
		       current_setting('app.current_supplier_user_id', true),
		       current_setting('app.automation_grant_id', true)`).Scan(
		&s.user, &s.org, &s.staff, &s.observer, &s.wallet, &s.supplier, &s.grant)
	return s, err
}

func strPtr(s string) *string { return &s }

func seedSessionOrg(t *testing.T, ctx context.Context, pool *pgxpool.Pool, userID int64, tag string) (orgID int64, storeUUID string, user int64) {
	t.Helper()
	t.Cleanup(func() {
		dropSessionOrg(context.Background(), pool, orgID, userID)
	})
	if _, err := pool.Exec(ctx, `
		INSERT INTO account_users (id, public_id, email, password_hash, role, name, target, supplier_id, plan, created_at, updated_at)
		VALUES ($1, $2, $3, 'x', 'user', 't', '/workspace', '', 'lite', clock_timestamp(), clock_timestamp())`,
		userID, fmt.Sprintf("sess%d", userID), fmt.Sprintf("sess%d@example.invalid", userID)); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO organizations (owner_user_id, name, plan, created_at, updated_at)
		VALUES ($1, $2, 'lite', clock_timestamp(), clock_timestamp()) RETURNING id`,
		userID, "sess-"+tag).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO organization_members (org_id, user_id, role, status, display_name, created_at, updated_at, join_order)
		VALUES ($1, $2, 'owner', 'active', 't', clock_timestamp(), clock_timestamp(), 1)`, orgID, userID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO organization_stores (org_id, create_order, name)
		VALUES ($1, 1, $2) RETURNING uuid::text`, orgID, "store-"+tag).Scan(&storeUUID); err != nil {
		t.Fatal(err)
	}
	return orgID, storeUUID, userID
}

func dropSessionOrg(ctx context.Context, pool *pgxpool.Pool, orgID, userID int64) {
	if pool == nil || orgID == 0 {
		return
	}
	_, _ = pool.Exec(ctx, `DELETE FROM store_rating_snapshots WHERE org_id = $1`, orgID)
	_, _ = pool.Exec(ctx, `DELETE FROM organization_stores WHERE org_id = $1`, orgID)
	_, _ = pool.Exec(ctx, `DELETE FROM organization_members WHERE org_id = $1`, orgID)
	_, _ = pool.Exec(ctx, `DELETE FROM organizations WHERE id = $1`, orgID)
	_, _ = pool.Exec(ctx, `DELETE FROM account_users WHERE id = $1`, userID)
}

var (
	sessionOnce    sync.Once
	sessionPool    *pgxpool.Pool
	sessionDSN     string
	sessionCleanup func()
	sessionErr     error
)

func TestMain(m *testing.M) {
	code := m.Run()
	if sessionPool != nil {
		sessionPool.Close()
	}
	if sessionCleanup != nil {
		sessionCleanup()
	}
	os.Exit(code)
}

func sessionDB(t *testing.T) (*pgxpool.Pool, context.Context) {
	t.Helper()
	sessionOnce.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		dsn, cleanup, err := testkit.StartPostgres(ctx)
		if err != nil {
			sessionErr = err
			return
		}
		sessionDSN = dsn
		sessionCleanup = cleanup
		cfg := config.Config{DatabaseURL: dsn}
		if err := cfg.CheckDatabase(); err != nil {
			sessionErr = err
			return
		}
		if err := os.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "1"); err != nil {
			sessionErr = err
			return
		}
		pool, err := Connect(ctx, cfg)
		if err != nil {
			sessionErr = err
			return
		}
		if err := Migrate(ctx, pool); err != nil {
			pool.Close()
			sessionErr = err
			return
		}
		sessionPool = pool
	})
	if sessionErr != nil {
		t.Fatal(sessionErr)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	t.Cleanup(cancel)
	return sessionPool, ctx
}
