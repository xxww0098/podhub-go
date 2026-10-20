package integration

import (
	"context"
	"database/sql"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"

	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	queuedomain "github.com/xxww0098/podhub-go/internal/queue/domain"
	"github.com/xxww0098/podhub-go/tests/testkit"
)

// TestResultConsistency compares goose and River output with the Rust head.
// Without Docker it skips, unless PODHUB_PARITY_DSN names a loopback database.
// GitHub Actions ubuntu-latest has Docker, so CI runs it.
//
// This test keeps a private cluster: it creates extra databases, checks goose
// order on an empty server, and raises max_locks_per_transaction. The shared
// template is already migrated and uses the image defaults.
func TestResultConsistency(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	dsn := os.Getenv("PODHUB_PARITY_DSN")
	if dsn == "" {
		if !testkit.DockerAvailable() {
			t.Skip("docker daemon is not available")
		}
		container, err := postgres.Run(ctx, "postgres:16-alpine",
			postgres.WithDatabase("podhub"),
			postgres.WithUsername("postgres"),
			postgres.WithPassword("postgres"),
			postgres.BasicWaitStrategies(),
			// One claim locks up to 128 per-user advisory locks. The image
			// default of 64 is an average, not a per-transaction ceiling, but
			// the shared lock table is sized from it. Append the setting; do
			// not replace the entrypoint.
			testcontainers.WithCmdArgs("-c", "max_locks_per_transaction=256"),
		)
		if err != nil {
			t.Fatalf("postgres: %v", err)
		}
		t.Cleanup(func() { _ = container.Terminate(context.Background()) })
		dsn, err = container.ConnectionString(ctx, "sslmode=disable")
		if err != nil {
			t.Fatal(err)
		}
	} else if err := (config.Config{DatabaseURL: dsn}).CheckDatabase(); err != nil {
		t.Fatal(err)
	}

	t.Run("goose declaration order", func(t *testing.T) {
		testGooseOrder(t, ctx, dsn)
	})

	cfg := config.Config{DatabaseURL: dsn}
	_ = os.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "1")
	pool, err := db.Connect(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := db.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	// Earlier subtests insert rows. Drop them before the fingerprint so a
	// rerun on the same database still has the head row counts.
	if err := purgeParityFixtures(ctx, pool); err != nil {
		t.Fatal(err)
	}

	t.Run("schema diff", func(t *testing.T) { testSchemaDiff(t, ctx, pool) })
	t.Run("river state is not the business state", func(t *testing.T) { testRiverEnum(t, ctx, pool) })
	t.Run("lease case", func(t *testing.T) { testLeaseCase(t, ctx, pool) })
	t.Run("requeue", func(t *testing.T) { testRequeue(t, ctx, pool) })
	t.Run("idempotency", func(t *testing.T) { testIdempotency(t, ctx, pool) })
	t.Run("wake notify", func(t *testing.T) { testWake(t, ctx, pool) })
	t.Run("lock order", func(t *testing.T) { testLockOrder(t, ctx, pool) })
	t.Run("function and trigger bodies", func(t *testing.T) { testRoutineBodies(t, ctx, pool) })
	t.Run("jobs kernel rows", func(t *testing.T) { testKernelRows(t, ctx, pool) })
	t.Run("queue head counters", func(t *testing.T) { testQueueHeadCounters(t, ctx, pool) })
	t.Run("quota functions", func(t *testing.T) { testQuotaFunctions(t, ctx, pool) })
	t.Run("claim fairness and cap", func(t *testing.T) { testClaimFairness(t, ctx, pool) })
	t.Run("claim lock order", func(t *testing.T) { testClaimLockOrder(t, ctx, pool) })
	t.Run("reconciler seat", func(t *testing.T) { testReconcilerSeat(t, ctx, pool) })
	t.Run("banned tag rules", func(t *testing.T) { testBannedTagRules(t, ctx, pool) })
}

func testGooseOrder(t *testing.T, ctx context.Context, dsn string) {
	t.Helper()
	admin, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	for _, name := range []string{"goose_version_sort", "goose_declaration"} {
		if _, err := admin.ExecContext(ctx, "DROP DATABASE IF EXISTS "+name); err != nil {
			t.Fatal(err)
		}
		if _, err := admin.ExecContext(ctx, "CREATE DATABASE "+name); err != nil {
			t.Fatal(err)
		}
	}

	versionDir := t.TempDir()
	writeMigration(t, versionDir, "00054_facts.sql", `
CREATE TABLE order_log (seq serial PRIMARY KEY, name text NOT NULL);
INSERT INTO order_log (name) VALUES ('facts');
`)
	writeMigration(t, versionDir, "00055_banned.sql", `INSERT INTO order_log (name) VALUES ('banned');`)
	dupDir := t.TempDir()
	writeMigration(t, dupDir, "00055_banned.sql", `SELECT 1;`)
	writeMigration(t, dupDir, "00055_occupancy.sql", `SELECT 1;`)
	if _, err := goose.NewProvider(goose.DialectPostgres, admin, os.DirFS(dupDir)); err == nil || !strings.Contains(err.Error(), "duplicate migration version 55") {
		t.Fatalf("shared stamp must be rejected, got %v", err)
	}

	applyGoose(t, ctx, withDatabase(dsn, "goose_version_sort"), versionDir)
	got := gooseLog(t, ctx, withDatabase(dsn, "goose_version_sort"))
	if strings.Join(got, ",") != "facts,banned" {
		t.Fatalf("version sort ran %v; declaration wants banned before facts", got)
	}

	declDir := t.TempDir()
	writeMigration(t, declDir, "00280_banned.sql", `
CREATE TABLE order_log (seq serial PRIMARY KEY, name text NOT NULL);
INSERT INTO order_log (name) VALUES ('banned');
`)
	writeMigration(t, declDir, "00281_facts.sql", `INSERT INTO order_log (name) VALUES ('facts');`)
	writeMigration(t, declDir, "00282_occupancy.sql", `INSERT INTO order_log (name) VALUES ('occupancy');`)
	applyGoose(t, ctx, withDatabase(dsn, "goose_declaration"), declDir)
	got = gooseLog(t, ctx, withDatabase(dsn, "goose_declaration"))
	if strings.Join(got, ",") != "banned,facts,occupancy" {
		t.Fatalf("declaration renumber ran %v", got)
	}
}

func writeMigration(t *testing.T, dir, name, body string) {
	t.Helper()
	sqlText := "-- +goose Up\n" + body + "\n-- +goose Down\nSELECT 1;\n"
	if err := os.WriteFile(filepath.Join(dir, name), []byte(sqlText), 0o644); err != nil {
		t.Fatal(err)
	}
}

func applyGoose(t *testing.T, ctx context.Context, dsn, dir string) {
	t.Helper()
	sqlDB, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer sqlDB.Close()
	provider, err := goose.NewProvider(goose.DialectPostgres, sqlDB, os.DirFS(dir))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := provider.Up(ctx); err != nil {
		t.Fatal(err)
	}
}

func gooseLog(t *testing.T, ctx context.Context, dsn string) []string {
	t.Helper()
	sqlDB, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer sqlDB.Close()
	rows, err := sqlDB.QueryContext(ctx, "SELECT name FROM order_log ORDER BY seq")
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
	return names
}

func withDatabase(dsn, name string) string {
	u, err := url.Parse(dsn)
	if err != nil {
		panic(err)
	}
	u.Path = "/" + name
	return u.String()
}

func testSchemaDiff(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	testkit.CompareHeadFingerprint(t, ctx, pool)
	var rivers int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname LIKE 'river_%'`).Scan(&rivers); err != nil {
		t.Fatal(err)
	}
	if rivers == 0 {
		t.Fatal("river schema was not migrated")
	}
}

func testRiverEnum(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	labels := queryStrings(t, ctx, pool, `
		SELECT e.enumlabel FROM pg_enum e
		JOIN pg_type t ON t.oid = e.enumtypid
		WHERE t.typname = 'river_job_state' ORDER BY e.enumsortorder`)
	joined := strings.Join(labels, ",")
	for _, missing := range []string{"queued", "retry_wait", "uncertain", "succeeded", "failed"} {
		if strings.Contains(joined, missing) {
			t.Fatalf("river enum must not gain jobs state %s (%s)", missing, joined)
		}
	}
	var def string
	if err := pool.QueryRow(ctx, `
		SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
		JOIN pg_class rel ON rel.oid = c.conrelid
		WHERE rel.relname = 'river_job' AND c.conname = 'priority_in_range'`).Scan(&def); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(def, ">= 1") || !strings.Contains(def, "<= 4") {
		t.Fatalf("river priority constraint %s", def)
	}
	if queuedomain.DefaultBusinessPriority < 1 || queuedomain.DefaultBusinessPriority > 4 {
		// The business default is outside River's range on purpose.
	} else {
		t.Fatal("business priority must stay outside river_job's 1..4 check")
	}
}

func testLeaseCase(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	inputs := []queuedomain.LeaseInput{
		{Kind: "listing.submit", Executor: "cloud", Attempt: 1, MaxAttempts: 8, LastError: "old"},
		{Kind: "listing.submit", Executor: "cloud", Attempt: 8, MaxAttempts: 8, LastError: "old"},
		{Kind: "listing.submit.batch", Executor: "cloud", Attempt: 1, MaxAttempts: 8, Intents: 2},
		{Kind: "listing.submit.batch", Executor: "cloud", Attempt: 1, MaxAttempts: 8, Intents: 0, LastError: "keep"},
		{Kind: "ai.recognize", Executor: "browser", Attempt: 8, MaxAttempts: 8, LastError: "old"},
		{Kind: "store.product_sync", Executor: "cloud", Attempt: 8, MaxAttempts: 8},
		{Kind: "store.product_sync", Executor: "browser", Attempt: 9, MaxAttempts: 8, LastError: "keep"},
		{Kind: "media.render", Executor: "browser", Attempt: 1, MaxAttempts: 8, LastError: "old"},
	}
	const q = `
		SELECT
			CASE
				WHEN kind = 'listing.submit' THEN 'failed'
				WHEN kind = 'listing.submit.batch' AND COALESCE(intents, 0) > 0 THEN 'failed'
				WHEN kind IN ('ai.recognize', 'media.render', 'media.upload') THEN 'uncertain'
				WHEN executor IS DISTINCT FROM 'browser' AND attempt >= max_attempts THEN 'failed'
				ELSE 'retry_wait'
			END,
			CASE
				WHEN kind IN ('ai.recognize', 'media.render', 'media.upload') THEN 'attempt_uncertain'
				WHEN executor IS DISTINCT FROM 'browser' AND attempt >= max_attempts THEN 'max_attempts_exhausted'
				ELSE last_error
			END,
			NOT (kind IN ('ai.recognize', 'media.render', 'media.upload'))
		FROM (VALUES ($1::text, $2::text, $3::int, $4::int, $5::int, $6::text))
			AS j(kind, executor, attempt, max_attempts, intents, last_error)`
	for _, in := range inputs {
		var state, errCode string
		var clear bool
		if err := pool.QueryRow(ctx, q, in.Kind, in.Executor, in.Attempt, in.MaxAttempts, in.Intents, in.LastError).Scan(&state, &errCode, &clear); err != nil {
			t.Fatal(err)
		}
		got := queuedomain.LeaseCase(in)
		if got.State != state || got.LastError != errCode || got.ClearLease != clear {
			t.Fatalf("%s: go %+v sql state=%s err=%s clear=%v", in.Kind, got, state, errCode, clear)
		}
		swept := queuedomain.ReclaimExpired(in)
		if in.Kind == "media.render" || in.Kind == "media.upload" {
			if !swept.Untouched || swept.State != "running" {
				t.Fatalf("sweeper %+v", swept)
			}
		}
	}
}

func testRequeue(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	const q = `
		SELECT
			CASE WHEN NOT $1 AND $2::int >= $3::int THEN 'failed' ELSE 'retry_wait' END,
			CASE WHEN $1 THEN GREATEST($2::int - 1, 0) ELSE $2::int END`
	for _, reason := range []queuedomain.RequeueReason{queuedomain.ReasonStoreBusy, queuedomain.ReasonSafeToRetry, queuedomain.ReasonRateLimited, queuedomain.ReasonLockBusy} {
		for _, attempt := range []int32{1, 8} {
			var state string
			var next int32
			if err := pool.QueryRow(ctx, q, reason.WithdrawAttempt(), attempt, 8).Scan(&state, &next); err != nil {
				t.Fatal(err)
			}
			got := queuedomain.Requeue(attempt, 8, reason)
			if got.State != state || got.Attempt != next || got.ErrorCode != string(reason) {
				t.Fatalf("%s attempt %d: go %+v sql %s/%d", reason, attempt, got, state, next)
			}
		}
	}
}

func testIdempotency(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	if _, err := pool.Exec(ctx, `
		DROP TABLE IF EXISTS parity_jobs;
		CREATE TABLE parity_jobs (
			id uuid PRIMARY KEY,
			org_id bigint NOT NULL,
			kind text NOT NULL,
			idempotency_key text NOT NULL,
			payload jsonb NOT NULL,
			updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
			UNIQUE (org_id, kind, idempotency_key)
		)`); err != nil {
		t.Fatal(err)
	}
	const insert = `
		INSERT INTO parity_jobs (id, org_id, kind, idempotency_key, payload)
		VALUES ($1::uuid, 7, 'listing.submit', 'same-key', $2::jsonb)
		ON CONFLICT (org_id, kind, idempotency_key) DO UPDATE
			SET updated_at = parity_jobs.updated_at
		RETURNING id::text, payload::text`
	var id, payload string
	if err := pool.QueryRow(ctx, insert, "00000000-0000-4000-8000-000000000001", `{"n":1}`).Scan(&id, &payload); err != nil {
		t.Fatal(err)
	}
	var id2, payload2 string
	if err := pool.QueryRow(ctx, insert, "00000000-0000-4000-8000-000000000002", `{"n":2}`).Scan(&id2, &payload2); err != nil {
		t.Fatal(err)
	}
	if id2 != id || payload2 != `{"n": 1}` && payload2 != `{"n":1}` {
		t.Fatalf("replay changed the row: id %s->%s payload %s", id, id2, payload2)
	}
	var n int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM parity_jobs").Scan(&n); err != nil || n != 1 {
		t.Fatalf("rows %d err %v", n, err)
	}
}

func testWake(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	// The trigger and function come from the goose chain (jobs_wake_notify).
	// Payloads without "/sha256/" pass the media-reference guard.
	if _, err := pool.Exec(ctx, `
		INSERT INTO account_users (id, public_id, email, password_hash, role, name, target, supplier_id, plan, created_at, updated_at)
		VALUES (91001, 'wake-user', 'wake@example.invalid', 'x', 'user', 'Wake', '/workspace', '', 'lite', clock_timestamp(), clock_timestamp())
		ON CONFLICT (id) DO NOTHING;
		INSERT INTO organizations (owner_user_id, name, plan, created_at, updated_at)
		SELECT 91001, 'wake', 'lite', clock_timestamp(), clock_timestamp()
		WHERE NOT EXISTS (SELECT 1 FROM organizations WHERE owner_user_id = 91001)`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM jobs WHERE idempotency_key IN ('browser-1', 'cloud-1')`); err != nil {
		t.Fatal(err)
	}
	listen, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer listen.Release()
	if _, err := listen.Exec(ctx, "LISTEN ozon_jobs_wake"); err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	insertJob := `
		INSERT INTO jobs (id, org_id, kind, aggregate_type, aggregate_id, input_revision, idempotency_key, state, payload, lane, submitter_user_id)
		VALUES ($1::uuid, (SELECT id FROM organizations WHERE owner_user_id = 91001), $2, 'listing_row', gen_random_uuid(), 1, $3, 'queued', $4::jsonb, $2, 91001)`
	if _, err := tx.Exec(ctx, insertJob, "00000000-0000-4000-8000-0000000000b1", "ai.recognize", "browser-1", `{"executor":"browser"}`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, insertJob, "00000000-0000-4000-8000-0000000000b2", "listing.submit", "cloud-1", `{}`); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	note := waitNote(t, ctx, listen)
	if note != "listing.submit" {
		t.Fatalf("notify payload %q", note)
	}
	quiet, cancel := context.WithTimeout(ctx, 200*time.Millisecond)
	defer cancel()
	if _, err := listen.Conn().WaitForNotification(quiet); err == nil {
		t.Fatal("browser insert or a second payload was notified")
	}
	if _, err := pool.Exec(ctx, `UPDATE jobs SET state = 'running' WHERE id = '00000000-0000-4000-8000-0000000000b2'`); err != nil {
		t.Fatal(err)
	}
	quiet2, cancel2 := context.WithTimeout(ctx, 200*time.Millisecond)
	defer cancel2()
	if _, err := listen.Conn().WaitForNotification(quiet2); err == nil {
		t.Fatal("UPDATE must not notify")
	}
}

func waitNote(t *testing.T, ctx context.Context, listen *pgxpool.Conn) string {
	t.Helper()
	wctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	note, err := listen.Conn().WaitForNotification(wctx)
	if err != nil {
		t.Fatal(err)
	}
	if note.Channel != queuedomain.WakeChannel {
		t.Fatalf("channel %s", note.Channel)
	}
	return note.Payload
}

func testLockOrder(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	order := queuedomain.LockOrder()
	if order[0] != "account_queue_head" || order[1] != "execution_quota" {
		t.Fatalf("order %v", order)
	}
	holder, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Release()
	tx, err := holder.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `
		INSERT INTO account_queue_head(user_id, lane) VALUES (1, 'listing.submit')
		ON CONFLICT (user_id, lane) DO UPDATE SET lane = EXCLUDED.lane`); err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	finished := make(chan error, 1)
	go func() {
		close(started)
		cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		conn, err := pool.Acquire(cctx)
		if err != nil {
			finished <- err
			return
		}
		defer conn.Release()
		_, err = conn.Exec(cctx, `
			INSERT INTO account_queue_head(user_id, lane) VALUES (1, 'listing.submit')
			ON CONFLICT (user_id, lane) DO UPDATE SET lane = EXCLUDED.lane`)
		if err != nil {
			finished <- err
			return
		}
		_, err = conn.Exec(cctx, `
			INSERT INTO execution_quota(class, user_id, hard_limit) VALUES ('all_execution', 1, 1)
			ON CONFLICT (class, user_id) DO UPDATE SET class = EXCLUDED.class`)
		finished <- err
	}()
	<-started
	deadline := time.Now().Add(2 * time.Second)
	for {
		var waiting int
		if err := pool.QueryRow(ctx, `
			SELECT count(*) FROM pg_stat_activity
			WHERE pid <> pg_backend_pid()
			  AND wait_event_type = 'Lock'
			  AND query LIKE '%account_queue_head%'`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting >= 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("waiter did not block on account_queue_head")
		}
		time.Sleep(20 * time.Millisecond)
	}
	quota, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer quota.Release()
	qtx, err := quota.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer qtx.Rollback(ctx)
	if _, err := qtx.Exec(ctx, `SET LOCAL lock_timeout = '500ms'`); err != nil {
		t.Fatal(err)
	}
	if _, err := qtx.Exec(ctx, `
		INSERT INTO execution_quota(class, user_id, hard_limit) VALUES ('all_execution', 1, 1)
		ON CONFLICT (class, user_id) DO UPDATE SET class = EXCLUDED.class`); err != nil {
		t.Fatalf("quota lock should be free while the waiter is blocked on the head: %v", err)
	}
	if err := qtx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
}

func testRoutineBodies(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	testkit.CompareRoutineBodies(t, ctx, pool)
}

func queryStrings(t *testing.T, ctx context.Context, pool *pgxpool.Pool, q string) []string {
	t.Helper()
	rows, err := pool.Query(ctx, q)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			t.Fatal(err)
		}
		out = append(out, s)
	}
	return out
}

// Keep stdlib imported for the pgx driver registration used by database/sql.
var _ = stdlib.OpenDB
