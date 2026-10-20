package db

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

// orgAtom is how pg_get_expr prints an RLS comparison against the org GUC.
var orgAtom = regexp.MustCompile(`\(([a-z_]+(?:\.[a-z_]+)?) = \(NULLIF\(current_setting\('` +
	regexp.QuoteMeta(tenantx.GUCCurrentOrgID) + `'::text, true\), ''::text\)\)::bigint\)`)

// orgPolicyShapes are the only policy expressions allowed to read the org
// GUC, with each comparison replaced by <ORG:column>. Every shape combines
// the comparison with AND, an IN subquery, or independent OR terms. Under SQL three-valued
// logic such an expression gives the same verdict whether the comparison
// is false (org GUC "0", org_id <> 0) or null (org GUC unset). A new shape
// fails TestOrgPoliciesUseEqualityOnly and has to be reviewed here.
var orgPolicyShapes = map[string]bool{
	// 00342: public references and staff access are independent of the org GUC;
	// owner_org_id references organizations, so it cannot be zero.
	`((owner_org_id IS NULL) OR <ORG:owner_org_id> OR (current_setting('app.staff_access'::text, true) = '1'::text))`: true,
	`<ORG:org_id>`: true,
	`((org_id IS NOT NULL) AND <ORG:org_id>)`:                                                                              true,
	`(set_id IN ( SELECT s.id FROM automation_asset_sets s WHERE <ORG:s.org_id>))`:                                         true,
	`((user_id = (NULLIF(current_setting('app.current_wallet_user_id'::text, true), ''::text))::bigint) AND <ORG:org_id>)`: true,
}

// orgZeroUnguarded are policy tables whose org_id has neither a foreign key
// to organizations nor CHECK (org_id > 0). Only these could hold an org_id 0
// row, which the org GUC "0" would match and an unset GUC would not. This
// list may only shrink.
var orgZeroUnguarded = []string{
	"automation_asset_sets",
	"automation_runtimes",
	"browser_commands",
	"delegate_dispatch_assets",
	"execution_permits",
	"listing_card_cursors",
	"listing_row_events",
}

func TestSupplierSessionRejectsUnsetUser(t *testing.T) {
	for _, id := range []int64{0, -1} {
		begin := &failBegin{}
		err := InTx(context.Background(), begin, Supplier(id), func(pgx.Tx) error { return nil })
		if !errors.Is(err, tenantx.ErrUserUnset) || begin.calls != 0 {
			t.Fatalf("Supplier(%d): err %v calls %d", id, err, begin.calls)
		}
	}
}

func TestSupplierSessionMatchesOrgZeroPathExceptOrg(t *testing.T) {
	_, ctx := sessionDB(t)
	const userID int64 = 88031
	fresh := freshBegin{dsn: sessionDSN}
	oldTx, err := oldSupplier(ctx, fresh.Begin, 0, userID)
	if err != nil {
		t.Fatal(err)
	}
	defer oldTx.Rollback(ctx)
	gotOld, err := readSnap(ctx, oldTx)
	if err != nil {
		t.Fatal(err)
	}
	var gotNew snap
	if err := InTx(ctx, fresh, Supplier(userID), func(tx pgx.Tx) error {
		var readErr error
		gotNew, readErr = readSnap(ctx, tx)
		return readErr
	}); err != nil {
		t.Fatal(err)
	}
	uid := strPtr(strconv.FormatInt(userID, 10))
	if want := (snap{user: tenantx.RoleApp, org: strPtr("0"), supplier: uid}); !gotOld.equal(want) {
		t.Fatalf("old path %s want %s", gotOld, want)
	}
	if want := (snap{user: tenantx.RoleApp, supplier: uid}); !gotNew.equal(want) {
		t.Fatalf("new path %s want %s", gotNew, want)
	}
}

func TestOrgPoliciesUseEqualityOnly(t *testing.T) {
	pool, ctx := sessionDB(t)
	rows, err := pool.Query(ctx, `
		SELECT tablename::text, policyname::text, coalesce(qual, ''), coalesce(with_check, '')
		  FROM pg_policies
		 WHERE schemaname = 'public'
		 ORDER BY tablename, policyname`)
	if err != nil {
		t.Fatal(err)
	}
	type target struct{ table, column string }
	targets := map[target]bool{}
	policies := 0
	for rows.Next() {
		var table, name, qual, check string
		if err := rows.Scan(&table, &name, &qual, &check); err != nil {
			t.Fatal(err)
		}
		uses := false
		for _, expr := range []string{qual, check} {
			if !strings.Contains(expr, tenantx.GUCCurrentOrgID) {
				continue
			}
			uses = true
			for _, m := range orgAtom.FindAllStringSubmatch(expr, -1) {
				tbl, col := table, m[1]
				if alias, c, ok := strings.Cut(m[1], "."); ok {
					if alias != "s" || !strings.Contains(expr, "FROM automation_asset_sets s") {
						t.Fatalf("%s.%s: unknown alias in %q", table, name, m[0])
					}
					tbl, col = "automation_asset_sets", c
				}
				targets[target{tbl, col}] = true
			}
			shape := strings.Join(strings.Fields(orgAtom.ReplaceAllString(expr, "<ORG:$1>")), " ")
			if strings.Contains(shape, tenantx.GUCCurrentOrgID) {
				t.Errorf("%s.%s reads the org GUC outside an equality: %s", table, name, shape)
				continue
			}
			if !orgPolicyShapes[shape] {
				t.Errorf("%s.%s has an unreviewed org GUC shape: %s", table, name, shape)
			}
		}
		if uses {
			policies++
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if policies < 50 {
		t.Fatalf("only %d policies read the org GUC; the query missed them", policies)
	}

	var unguarded []string
	for tg := range targets {
		var guarded bool
		if err := pool.QueryRow(ctx, orgGuardSQL, tg.table, tg.column).Scan(&guarded); err != nil {
			t.Fatal(err)
		}
		if !guarded {
			unguarded = append(unguarded, tg.table)
		}
	}
	sort.Strings(unguarded)
	if strings.Join(unguarded, ",") != strings.Join(orgZeroUnguarded, ",") {
		t.Fatalf("tables without an org_id > 0 guard: %v, want %v", unguarded, orgZeroUnguarded)
	}
	var seqMin int64
	if err := pool.QueryRow(ctx, `
		SELECT s.seqmin FROM pg_sequence s
		 WHERE s.seqrelid = pg_get_serial_sequence('organizations', 'id')::regclass`).Scan(&seqMin); err != nil {
		t.Fatal(err)
	}
	if seqMin < 1 {
		t.Fatalf("organizations.id sequence minimum %d can issue 0", seqMin)
	}

	// Outside policies, only billing_consume_redeem_code reads the org GUC.
	// It compares with IS DISTINCT FROM p_org. Its only caller runs it under
	// App(org), which rejects org <= 0, so the GUC there is never "0" or unset.
	var others []string
	rows, err = pool.Query(ctx, `
		SELECT 'function ' || p.oid::regprocedure::text
		  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
		 WHERE n.nspname = 'public' AND p.prosrc LIKE '%' || $1 || '%'
		UNION ALL
		SELECT 'default ' || d.adrelid::regclass::text FROM pg_attrdef d
		 WHERE pg_get_expr(d.adbin, d.adrelid) LIKE '%' || $1 || '%'
		UNION ALL
		SELECT 'constraint ' || c.conname FROM pg_constraint c
		 WHERE pg_get_constraintdef(c.oid) LIKE '%' || $1 || '%'
		UNION ALL
		SELECT 'view ' || c.relname FROM pg_class c
		 WHERE c.relkind IN ('v', 'm') AND pg_get_viewdef(c.oid) LIKE '%' || $1 || '%'
		UNION ALL
		SELECT 'index ' || i.indexrelid::regclass::text FROM pg_index i
		 WHERE pg_get_indexdef(i.indexrelid) LIKE '%' || $1 || '%'
		ORDER BY 1`, tenantx.GUCCurrentOrgID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			t.Fatal(err)
		}
		others = append(others, s)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	want := "function billing_consume_redeem_code(bigint,bigint,bigint,bigint)"
	if strings.Join(others, ";") != want {
		t.Fatalf("org GUC readers outside policies: %v, want [%s]", others, want)
	}
	callers := goFilesMentioning(t, "billing_consume_redeem_code")
	if strings.Join(callers, ",") != "internal/billing/repo/redeem.go" {
		t.Fatalf("billing_consume_redeem_code callers: %v", callers)
	}
}

// orgGuardSQL reports whether column of table can only hold an existing
// organizations.id, directly or through foreign keys, or has CHECK (col > 0).
const orgGuardSQL = `
WITH RECURSIVE fk(rel, col, frel, fcol) AS (
	SELECT c.conrelid, a.attname, c.confrelid, fa.attname
	  FROM pg_constraint c
	 CROSS JOIN LATERAL unnest(c.conkey, c.confkey) AS k(src, dst)
	  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.src
	  JOIN pg_attribute fa ON fa.attrelid = c.confrelid AND fa.attnum = k.dst
	 WHERE c.contype = 'f'
), guarded(rel, col) AS (
	SELECT 'organizations'::regclass::oid, 'id'::name
	UNION
	SELECT fk.rel, fk.col FROM fk JOIN guarded g ON g.rel = fk.frel AND g.col = fk.fcol
)
SELECT EXISTS (SELECT 1 FROM guarded WHERE rel = $1::regclass AND col = $2::name)
    OR EXISTS (
	SELECT 1 FROM pg_constraint c
	 WHERE c.conrelid = $1::regclass AND c.contype = 'c'
	   AND pg_get_constraintdef(c.oid) = 'CHECK ((' || $2 || ' > 0))')`

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

// TestSupplierOrgZeroMatchesUnset runs the old supplier open (org GUC "0")
// and Supplier side by side on seeded rows of two orgs and two suppliers.
// Every RLS table must give the same row count, and the same writes must
// succeed or fail.
func TestSupplierOrgZeroMatchesUnset(t *testing.T) {
	pool, ctx := sessionDB(t)
	orgA, storeA, _ := seedSessionOrg(t, ctx, pool, 770031, "za")
	orgB, storeB, _ := seedSessionOrg(t, ctx, pool, 770032, "zb")
	seedSessionRatings(t, ctx, pool, orgA, storeA, orgB, storeB)
	const (
		userA int64 = 880331
		userB int64 = 880332
	)
	seedSessionSupplier(t, ctx, pool, userA, "src-za")
	seedSessionSupplier(t, ctx, pool, userB, "src-zb")

	tables := rlsTables(t, ctx, pool)
	for _, user := range []int64{userA, userB} {
		oldCounts := countAll(t, ctx, func(fn func(pgx.Tx) error) error {
			tx, err := oldSupplier(ctx, pool.Begin, 0, user)
			if err != nil {
				return err
			}
			defer tx.Rollback(ctx)
			return fn(tx)
		}, tables)
		newCounts := countAll(t, ctx, func(fn func(pgx.Tx) error) error {
			return InTx(ctx, pool, Supplier(user), fn)
		}, tables)
		for _, tbl := range tables {
			if oldCounts[tbl] != newCounts[tbl] {
				t.Errorf("user %d %s: org \"0\" %s, unset %s", user, tbl, oldCounts[tbl], newCounts[tbl])
			}
		}
		if oldCounts["supplier_wallets"] != "1" || oldCounts["store_rating_snapshots"] != "0" {
			t.Fatalf("user %d seed not visible as expected: %v", user, oldCounts)
		}
	}

	now := time.Date(2026, 10, 17, 0, 0, 0, 0, time.UTC)
	writes := []struct {
		name string
		sql  string
		args []any
	}{
		{"insert org row", `
			INSERT INTO store_rating_snapshots
			    (org_id, store_id, rating_key, name, value_type, status, synced_at)
			VALUES ($1, $2::uuid, 'zero_probe', '', '', 'UNKNOWN', $3)`, []any{orgA, storeA, now}},
		{"update org rows", `UPDATE store_rating_snapshots SET name = 'zero' WHERE org_id IN ($1, $2)`, []any{orgA, orgB}},
		{"delete org rows", `DELETE FROM store_rating_snapshots WHERE org_id IN ($1, $2)`, []any{orgA, orgB}},
		{"update own wallet", `UPDATE supplier_wallets SET updated_at_ms = 2 WHERE source_id = 'src-za'`, nil},
		{"update other wallet", `UPDATE supplier_wallets SET updated_at_ms = 2 WHERE source_id = 'src-zb'`, nil},
		{"insert other wallet ledger", `
			INSERT INTO supplier_wallet_ledger
			    (source_id, entry_type, idempotency_key, amount_microfen, held_delta_microfen,
			     balance_after_microfen, held_after_microfen, created_at_ms)
			VALUES ('src-zb', 'credit', 'zero_probe', 1, 0, 1, 0, 1)`, nil},
		{"insert own wallet ledger", `
			INSERT INTO supplier_wallet_ledger
			    (source_id, entry_type, idempotency_key, amount_microfen, held_delta_microfen,
			     balance_after_microfen, held_after_microfen, created_at_ms)
			VALUES ('src-za', 'credit', 'zero_probe', 1, 0, 1, 0, 1)`, nil},
	}
	for _, w := range writes {
		oldOut := probeWrite(ctx, func(fn func(pgx.Tx) error) error {
			tx, err := oldSupplier(ctx, pool.Begin, 0, userA)
			if err != nil {
				return err
			}
			defer tx.Rollback(ctx)
			return fn(tx)
		}, w.sql, w.args)
		newOut := probeWrite(ctx, func(fn func(pgx.Tx) error) error {
			return InTx(ctx, pool, Supplier(userA), func(tx pgx.Tx) error {
				if err := fn(tx); err != nil {
					return err
				}
				return errRollback
			})
		}, w.sql, w.args)
		if oldOut != newOut {
			t.Errorf("%s: org \"0\" %s, unset %s", w.name, oldOut, newOut)
		}
	}
}

// TestSupplierSessionIsolatesSuppliers is the two-tenant case on Supplier:
// one supplier user cannot read or change another supplier's rows, and
// sees no org rows.
func TestSupplierSessionIsolatesSuppliers(t *testing.T) {
	pool, ctx := sessionDB(t)
	orgA, storeA, _ := seedSessionOrg(t, ctx, pool, 770041, "sa")
	orgB, storeB, _ := seedSessionOrg(t, ctx, pool, 770042, "sb")
	seedSessionRatings(t, ctx, pool, orgA, storeA, orgB, storeB)
	const (
		userA int64 = 880441
		userB int64 = 880442
	)
	seedSessionSupplier(t, ctx, pool, userA, "src-sa")
	seedSessionSupplier(t, ctx, pool, userB, "src-sb")

	err := InTx(ctx, pool, Supplier(userA), func(tx pgx.Tx) error {
		for _, q := range []struct {
			sql  string
			want string
		}{
			{`SELECT string_agg(source_id, ',' ORDER BY source_id) FROM supplier_wallets`, "src-sa"},
			{`SELECT string_agg(source_id, ',' ORDER BY source_id) FROM supplier_withdrawals`, "src-sa"},
			{`SELECT string_agg(source_id, ',' ORDER BY source_id) FROM sc_source_members`, "src-sa"},
			{`SELECT coalesce(string_agg(org_id::text, ','), '') FROM store_rating_snapshots`, ""},
		} {
			var got *string
			if err := tx.QueryRow(ctx, q.sql).Scan(&got); err != nil {
				return err
			}
			if got == nil || *got != q.want {
				return fmt.Errorf("%s: got %v, want %q", q.sql, got, q.want)
			}
		}
		for _, sql := range []string{
			`UPDATE supplier_wallets SET balance_microfen = 0 WHERE source_id = 'src-sb'`,
			`DELETE FROM supplier_withdrawals WHERE source_id = 'src-sb'`,
			`UPDATE sc_source_members SET status = 'removed' WHERE source_id = 'src-sb'`,
			`DELETE FROM store_rating_snapshots`,
		} {
			tag, err := tx.Exec(ctx, sql)
			if err != nil {
				return fmt.Errorf("%s: %w", sql, err)
			}
			if tag.RowsAffected() != 0 {
				return fmt.Errorf("%s touched %d rows", sql, tag.RowsAffected())
			}
		}
		return expectExecFail(ctx, tx, `
			INSERT INTO supplier_withdrawals
			    (source_id, amount_cents, amount_microfen, channel, account, real_name, status, requested_at_ms)
			VALUES ('src-sb', 1, 1000000, 'alipay', 'x', 'x', 'requested', 9)`)
	})
	if err != nil {
		t.Fatal(err)
	}
	var balance int64
	if err := pool.QueryRow(ctx, `SELECT balance_microfen FROM supplier_wallets WHERE source_id = 'src-sb'`).Scan(&balance); err != nil || balance != 100 {
		t.Fatalf("supplier B wallet %d %v", balance, err)
	}
}

var errRollback = errors.New("probe rollback")

func rlsTables(t *testing.T, ctx context.Context, pool *pgxpool.Pool) []string {
	t.Helper()
	rows, err := pool.Query(ctx, `
		SELECT c.relname::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		 WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
		 ORDER BY 1`)
	if err != nil {
		t.Fatal(err)
	}
	tables, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		t.Fatal(err)
	}
	if len(tables) < 50 {
		t.Fatalf("only %d RLS tables", len(tables))
	}
	return tables
}

// countAll reads count(*) of every table in one transaction. A table the
// role cannot read records its SQLSTATE instead of a count.
func countAll(t *testing.T, ctx context.Context, open func(func(pgx.Tx) error) error, tables []string) map[string]string {
	t.Helper()
	out := map[string]string{}
	err := open(func(tx pgx.Tx) error {
		for _, tbl := range tables {
			if _, err := tx.Exec(ctx, `SAVEPOINT c`); err != nil {
				return err
			}
			var n int64
			err := tx.QueryRow(ctx, `SELECT count(*) FROM `+pgx.Identifier{tbl}.Sanitize()).Scan(&n)
			out[tbl] = strconv.FormatInt(n, 10)
			if err != nil {
				out[tbl] = "error " + sqlState(err)
			}
			if _, err := tx.Exec(ctx, `ROLLBACK TO SAVEPOINT c`); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func probeWrite(ctx context.Context, open func(func(pgx.Tx) error) error, sql string, args []any) string {
	var out string
	err := open(func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, sql, args...)
		if err != nil {
			out = "error " + sqlState(err)
			return nil
		}
		out = fmt.Sprintf("%d rows", tag.RowsAffected())
		return nil
	})
	if err != nil && !errors.Is(err, errRollback) {
		return "open error " + err.Error()
	}
	return out
}

func sqlState(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code
	}
	return err.Error()
}

func seedSessionRatings(t *testing.T, ctx context.Context, pool *pgxpool.Pool, orgA int64, storeA string, orgB int64, storeB string) {
	t.Helper()
	if _, err := pool.Exec(ctx, `
		INSERT INTO store_rating_snapshots
		    (org_id, store_id, rating_key, name, value_type, status, synced_at)
		VALUES ($1, $2::uuid, 'seed', '', '', 'UNKNOWN', clock_timestamp()),
		       ($3, $4::uuid, 'seed', '', '', 'UNKNOWN', clock_timestamp())`, orgA, storeA, orgB, storeB); err != nil {
		t.Fatal(err)
	}
}

func seedSessionSupplier(t *testing.T, ctx context.Context, pool *pgxpool.Pool, userID int64, sourceID string) {
	t.Helper()
	t.Cleanup(func() {
		bg := context.Background()
		for _, sql := range []string{
			`DELETE FROM supplier_withdrawals WHERE source_id = $1`,
			`DELETE FROM supplier_wallet_ledger WHERE source_id = $1`,
			`DELETE FROM supplier_wallets WHERE source_id = $1`,
			`DELETE FROM sc_source_members WHERE source_id = $1`,
			`DELETE FROM sc_sources WHERE source_id = $1`,
		} {
			_, _ = pool.Exec(bg, sql, sourceID)
		}
		_, _ = pool.Exec(bg, `DELETE FROM account_users WHERE id = $1`, userID)
	})
	for _, s := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO account_users (id, public_id, email, password_hash, role, name, target, supplier_id, plan, created_at, updated_at)
		  VALUES ($1, $2, $3, 'x', 'user', 't', '/workspace', '', 'lite', clock_timestamp(), clock_timestamp())`,
			[]any{userID, fmt.Sprintf("sup%d", userID), fmt.Sprintf("sup%d@example.invalid", userID)}},
		{`INSERT INTO sc_sources (source_id, name, created_at_ms, updated_at_ms) VALUES ($1, $1, 1, 1)`, []any{sourceID}},
		{`INSERT INTO sc_source_members (source_id, user_id, created_by, created_at_ms) VALUES ($1, $2, $2, 1)`, []any{sourceID, userID}},
		{`INSERT INTO supplier_wallets (source_id, balance_microfen, held_microfen, updated_at_ms) VALUES ($1, 100, 0, 1)`, []any{sourceID}},
		{`INSERT INTO supplier_withdrawals
		      (source_id, amount_cents, amount_microfen, channel, account, real_name, status, requested_at_ms)
		  VALUES ($1, 1, 1000000, 'alipay', 'a', 'n', 'requested', 1)`, []any{sourceID}},
	} {
		if _, err := pool.Exec(ctx, s.sql, s.args...); err != nil {
			t.Fatal(err)
		}
	}
}
