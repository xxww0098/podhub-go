package integration

import (
	"context"
	"database/sql"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"github.com/xxww0098/podhub-go/db"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/tests/testkit"
)

// TestAllowMissingCatchesUpToFreshSchema replays the two real gaps among
// 00330–00332, 00335–00337, and 00340–00341.
//
// Ratings merged first, so a database can sit at 00337 with neither the
// store-name files nor the error-catalog files. The error-catalog branch
// applied 00340–00341 while 00325–00329 were already present and the other
// two groups were not, so that database sits at 00341. Default Up refuses
// both. db.Migrate catches up, and each catalog matches a fresh database.
func TestAllowMissingCatchesUpToFreshSchema(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	// Gaps are replayed on empty databases and compared with a fresh
	// db.Migrate. The shared template is already at head, and roles created
	// there are cluster-wide, so this stays on a private cluster.
	dsn, cleanup, err := testkit.StartPostgres(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(cleanup)
	t.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "1")

	admin, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = admin.Close() })
	names := []string{"allow_missing_fresh", "allow_missing_at337", "allow_missing_at341"}
	for _, name := range names {
		if _, err := admin.ExecContext(ctx, "DROP DATABASE IF EXISTS "+name); err != nil {
			t.Fatal(err)
		}
		if _, err := admin.ExecContext(ctx, "CREATE DATABASE "+name); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		cctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		for _, name := range names {
			_, _ = admin.ExecContext(cctx, "DROP DATABASE IF EXISTS "+name)
		}
	})

	freshPool := connectMigrate(t, ctx, withDatabase(dsn, names[0]))
	freshVersions := gooseVersionHistogram(t, ctx, freshPool)
	freshFP := schemaFingerprint(t, ctx, freshPool)

	t.Run("00337 before 00330-00332 and 00340-00341", func(t *testing.T) {
		gap := replayGap(t, ctx, dsn, names[1], map[int64]bool{
			330: true, 331: true, 332: true, 340: true, 341: true,
		})
		assertApplied(t, ctx, gap, []int64{335, 336, 337}, []int64{330, 331, 332, 340, 341})
		if !relationExists(t, ctx, gap, "store_rating_snapshots") || columnExists(t, ctx, gap, "organization_stores", "company_short_name") || policyExists(t, ctx, gap, "ozon_error_catalog_sample_prune") {
			t.Fatal("00337 gap has the wrong catalog before catch-up")
		}
		assertDefaultUpRefuses(t, ctx, gap, []string{"\tversion 330:", "\tversion 331:", "\tversion 332:", "\tversion 340:", "\tversion 341:"}, []string{"\tversion 335:"})
		pool := connectMigrate(t, ctx, withDatabase(dsn, names[1]))
		assertCaughtUp(t, ctx, pool, freshVersions, freshFP, "335,336,337,330,331,332,340,341")
		if !columnExistsPool(t, ctx, pool, "organization_stores", "company_short_name") || !policyExistsPool(t, ctx, pool, "ozon_error_catalog_sample_prune") {
			t.Fatal("00337 catch-up did not apply 00330 and 00341")
		}
	})

	t.Run("00341 before 00330-00332 and 00335-00337", func(t *testing.T) {
		gap := replayGap(t, ctx, dsn, names[2], map[int64]bool{
			330: true, 331: true, 332: true, 335: true, 336: true, 337: true,
		})
		assertApplied(t, ctx, gap, []int64{325, 326, 327, 328, 329, 340, 341}, []int64{330, 331, 332, 335, 336, 337})
		if relationExists(t, ctx, gap, "store_rating_snapshots") || columnExists(t, ctx, gap, "organization_stores", "company_short_name") || !policyExists(t, ctx, gap, "ozon_error_catalog_sample_prune") {
			t.Fatal("00341 gap has the wrong catalog before catch-up")
		}
		assertDefaultUpRefuses(t, ctx, gap, []string{"\tversion 330:", "\tversion 335:", "\tversion 337:"}, []string{"\tversion 340:", "\tversion 341:"})
		pool := connectMigrate(t, ctx, withDatabase(dsn, names[2]))
		assertCaughtUp(t, ctx, pool, freshVersions, freshFP, "340,341,330,331,332,335,336,337")
		if !relationExistsPool(t, ctx, pool, "store_rating_snapshots") || !columnExistsPool(t, ctx, pool, "organization_stores", "company_short_name") {
			t.Fatal("00341 catch-up did not apply 00330 and 00335")
		}
	})
}

func replayGap(t *testing.T, ctx context.Context, dsn, name string, skip map[int64]bool) *sql.DB {
	t.Helper()
	partial := t.TempDir()
	if err := copyMigrationsExcept(partial, skip); err != nil {
		t.Fatal(err)
	}
	applyGoose(t, ctx, withDatabase(dsn, name), partial)
	gap, err := sql.Open("pgx", withDatabase(dsn, name))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = gap.Close() })
	return gap
}

func assertApplied(t *testing.T, ctx context.Context, db *sql.DB, present, absent []int64) {
	t.Helper()
	for _, version := range present {
		var n int
		if err := db.QueryRowContext(ctx, `SELECT count(*) FROM goose_db_version WHERE version_id = $1 AND is_applied`, version).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 1 {
			t.Fatalf("version %d count %d, want 1", version, n)
		}
	}
	for _, version := range absent {
		var n int
		if err := db.QueryRowContext(ctx, `SELECT count(*) FROM goose_db_version WHERE version_id = $1`, version).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 0 {
			t.Fatalf("version %d was recorded on the gapped database", version)
		}
	}
}

func assertDefaultUpRefuses(t *testing.T, ctx context.Context, db *sql.DB, want, forbid []string) {
	t.Helper()
	goose.SetBaseFS(dbschema.Migrations)
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	err := goose.UpContext(ctx, db, "migrations")
	if err == nil || !strings.Contains(err.Error(), "missing migrations") {
		t.Fatalf("default Up must refuse the gap, got %v", err)
	}
	for _, part := range want {
		if !strings.Contains(err.Error(), part) {
			t.Fatalf("default Up error missing %s: %v", part, err)
		}
	}
	for _, part := range forbid {
		if strings.Contains(err.Error(), part) {
			t.Fatalf("default Up error mentions %s: %v", part, err)
		}
	}
}

func assertCaughtUp(t *testing.T, ctx context.Context, pool *pgxpool.Pool, freshVersions, freshFP, order string) {
	t.Helper()
	if got := gooseVersionHistogram(t, ctx, pool); got != freshVersions {
		t.Fatalf("goose versions\ngap:   %s\nfresh: %s", got, freshVersions)
	}
	var gotOrder string
	if err := pool.QueryRow(ctx, `
		SELECT COALESCE(string_agg(version_id::text, ',' ORDER BY id), '')
		FROM goose_db_version
		WHERE version_id IN (330, 331, 332, 335, 336, 337, 340, 341)`).Scan(&gotOrder); err != nil {
		t.Fatal(err)
	}
	if gotOrder != order {
		t.Fatalf("apply order %s, want %s", gotOrder, order)
	}
	if got := schemaFingerprint(t, ctx, pool); got != freshFP {
		t.Fatal(fingerprintDiff(got, freshFP))
	}
}

func relationExists(t *testing.T, ctx context.Context, db *sql.DB, name string) bool {
	t.Helper()
	var ok bool
	err := db.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM information_schema.tables
			WHERE table_schema = 'public' AND table_name = $1
		)`, name).Scan(&ok)
	if err != nil {
		t.Fatal(err)
	}
	return ok
}

func columnExists(t *testing.T, ctx context.Context, db *sql.DB, table, column string) bool {
	t.Helper()
	var ok bool
	err := db.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM information_schema.columns
			WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
		)`, table, column).Scan(&ok)
	if err != nil {
		t.Fatal(err)
	}
	return ok
}

func policyExists(t *testing.T, ctx context.Context, db *sql.DB, name string) bool {
	t.Helper()
	var ok bool
	err := db.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM pg_policy WHERE polname = $1)`, name).Scan(&ok)
	if err != nil {
		t.Fatal(err)
	}
	return ok
}

func relationExistsPool(t *testing.T, ctx context.Context, pool *pgxpool.Pool, name string) bool {
	t.Helper()
	var ok bool
	err := pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM information_schema.tables
			WHERE table_schema = 'public' AND table_name = $1
		)`, name).Scan(&ok)
	if err != nil {
		t.Fatal(err)
	}
	return ok
}

func columnExistsPool(t *testing.T, ctx context.Context, pool *pgxpool.Pool, table, column string) bool {
	t.Helper()
	var ok bool
	err := pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM information_schema.columns
			WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
		)`, table, column).Scan(&ok)
	if err != nil {
		t.Fatal(err)
	}
	return ok
}

func policyExistsPool(t *testing.T, ctx context.Context, pool *pgxpool.Pool, name string) bool {
	t.Helper()
	var ok bool
	err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_policy WHERE polname = $1)`, name).Scan(&ok)
	if err != nil {
		t.Fatal(err)
	}
	return ok
}

func copyMigrationsExcept(dst string, skip map[int64]bool) error {
	entries, err := fs.ReadDir(dbschema.Migrations, "migrations")
	if err != nil {
		return err
	}
	skipped := map[int64]bool{}
	for _, entry := range entries {
		version, err := goose.NumericComponent(entry.Name())
		if err != nil {
			return err
		}
		if skip[version] {
			skipped[version] = true
			continue
		}
		body, err := fs.ReadFile(dbschema.Migrations, path.Join("migrations", entry.Name()))
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(dst, entry.Name()), body, 0o644); err != nil {
			return err
		}
	}
	for version := range skip {
		if !skipped[version] {
			return fmt.Errorf("migration version %d is not in the embedded directory", version)
		}
	}
	return nil
}

func connectMigrate(t *testing.T, ctx context.Context, dsn string) *pgxpool.Pool {
	t.Helper()
	pool, err := db.Connect(ctx, config.Config{DatabaseURL: dsn})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := db.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	return pool
}

func gooseVersionHistogram(t *testing.T, ctx context.Context, pool *pgxpool.Pool) string {
	t.Helper()
	rows, err := pool.Query(ctx, `
		SELECT version_id::text || ':' || count(*)::text
		FROM goose_db_version
		GROUP BY version_id
		ORDER BY version_id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var lines []string
	for rows.Next() {
		var line string
		if err := rows.Scan(&line); err != nil {
			t.Fatal(err)
		}
		lines = append(lines, line)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return strings.Join(lines, "\n")
}

const schemaFingerprintSQL = `
SELECT COALESCE(string_agg(line, E'\n' ORDER BY line), '') FROM (
  SELECT format('relation %s relkind=%s rls=%s force=%s', c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity) AS line
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
  UNION ALL
  SELECT format('column %s.%s ord=%s type=%s null=%s ident=%s gen=%s default=%s',
    c.relname, a.attname, a.attnum,
    pg_catalog.format_type(a.atttypid, a.atttypmod),
    NOT a.attnotnull, a.attidentity, a.attgenerated,
    COALESCE(pg_catalog.pg_get_expr(ad.adbin, ad.adrelid), ''))
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
  UNION ALL
  SELECT format('sequence %s type=%s start=%s inc=%s', c.relname, pg_catalog.format_type(s.seqtypid, NULL), s.seqstart, s.seqincrement)
  FROM pg_sequence s
  JOIN pg_class c ON c.oid = s.seqrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
  UNION ALL
  SELECT format('index %s', pg_catalog.pg_get_indexdef(i.indexrelid))
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
  UNION ALL
  SELECT format('constraint %s.%s %s validated=%s', c.relname, con.conname, pg_catalog.pg_get_constraintdef(con.oid), con.convalidated)
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
  UNION ALL
  SELECT format('policy %s.%s cmd=%s perm=%s roles=%s using=%s check=%s',
    c.relname, pol.polname, pol.polcmd, pol.polpermissive,
    COALESCE((
      SELECT string_agg(COALESCE(r.rolname, 'public'), ',' ORDER BY COALESCE(r.rolname, 'public'))
      FROM unnest(pol.polroles) AS u(oid)
      LEFT JOIN pg_roles r ON r.oid = u.oid
    ), ''),
    COALESCE(pg_catalog.pg_get_expr(pol.polqual, pol.polrelid), ''),
    COALESCE(pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid), ''))
  FROM pg_policy pol
  JOIN pg_class c ON c.oid = pol.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
  UNION ALL
  SELECT format('acl %s %s %s grantable=%s', c.relname, COALESCE(grantee.rolname, 'public'), priv.privilege_type, priv.is_grantable)
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(c.relacl) AS priv
  LEFT JOIN pg_roles grantee ON grantee.oid = priv.grantee
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S') AND c.relacl IS NOT NULL
  UNION ALL
  SELECT format('colacl %s.%s %s %s grantable=%s', c.relname, a.attname, COALESCE(grantee.rolname, 'public'), priv.privilege_type, priv.is_grantable)
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(a.attacl) AS priv
  LEFT JOIN pg_roles grantee ON grantee.oid = priv.grantee
  WHERE n.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
  UNION ALL
  SELECT format('func %s', pg_catalog.pg_get_functiondef(p.oid))
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prokind = 'f'
  UNION ALL
  SELECT format('trigger %s', pg_catalog.pg_get_triggerdef(t.oid, true))
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND NOT t.tgisinternal
) s`

func schemaFingerprint(t *testing.T, ctx context.Context, pool *pgxpool.Pool) string {
	t.Helper()
	var structure string
	if err := pool.QueryRow(ctx, schemaFingerprintSQL).Scan(&structure); err != nil {
		t.Fatal(err)
	}
	rows, err := pool.Query(ctx, `
		SELECT c.relname FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
		  AND c.relname <> 'goose_db_version'
		  AND c.relname NOT LIKE 'river_%'
		ORDER BY 1`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var names []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		names = append(names, name)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(structure, "\n")
	for _, name := range names {
		var n int64
		q := "SELECT count(*) FROM public." + testkit.QuoteIdent(name)
		if err := pool.QueryRow(ctx, q).Scan(&n); err != nil {
			t.Fatal(err)
		}
		lines = append(lines, "rows "+name+" "+strconv.FormatInt(n, 10))
	}
	sort.Strings(lines)
	return strings.Join(lines, "\n")
}

func fingerprintDiff(gap, fresh string) string {
	gset := map[string]int{}
	for _, line := range strings.Split(gap, "\n") {
		gset[line]++
	}
	fset := map[string]int{}
	for _, line := range strings.Split(fresh, "\n") {
		fset[line]++
	}
	var onlyGap, onlyFresh []string
	for line, n := range gset {
		if fset[line] != n {
			onlyGap = append(onlyGap, line)
		}
	}
	for line, n := range fset {
		if gset[line] != n {
			onlyFresh = append(onlyFresh, line)
		}
	}
	sort.Strings(onlyGap)
	sort.Strings(onlyFresh)
	trim := func(lines []string) string {
		if len(lines) > 20 {
			lines = append(append([]string{}, lines[:20]...), "... "+strconv.Itoa(len(lines)-20)+" more")
		}
		return strings.Join(lines, "\n")
	}
	return "schema fingerprint mismatch\nonly gap:\n" + trim(onlyGap) + "\nonly fresh:\n" + trim(onlyFresh)
}
