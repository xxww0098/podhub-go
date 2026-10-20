package telemetryrepo

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go/modules/postgres"

	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/telemetry/domain"
)

func TestDedupeClientLogsFirstWins(t *testing.T) {
	rows := []domain.ClientLog{
		{ClientID: "a", Event: "first"},
		{ClientID: "b", Event: "b"},
		{ClientID: "a", Event: "later"},
	}
	got := dedupeClientLogs(9, rows)
	if len(got) != 2 || got[0].Event != "first" || got[1].ClientID != "b" {
		t.Fatalf("%+v", got)
	}
	if err := (&Repo{}).InsertClientLogs(context.Background(), 1, 1, nil); err != nil {
		t.Fatal(err)
	}
	if err := (&Repo{}).InsertClientLogs(context.Background(), 1, 1, []domain.ClientLog{}); err != nil {
		t.Fatal(err)
	}
	if err := (&Repo{}).InsertClientLogs(context.Background(), 1, 1, rows); err == nil || err.Error() != domain.LogsNotWritten().Error() {
		t.Fatalf("nil pool %v", err)
	}
}

func TestInsertClientLogsBatchParity(t *testing.T) {
	pool, ctx := telemetryBatchDB(t)
	traced, trace := telemetryTracedPool(t, ctx, pool)
	user := int64(883001)
	org := seedTelemetryOrg(t, ctx, pool, user)
	t.Cleanup(func() {
		c := context.Background()
		_, _ = pool.Exec(c, `DELETE FROM client_listing_logs WHERE user_id = $1`, user)
		_, _ = pool.Exec(c, `DELETE FROM organization_members WHERE org_id = $1`, org)
		_, _ = pool.Exec(c, `DELETE FROM organizations WHERE id = $1`, org)
		_, _ = pool.Exec(c, `DELETE FROM account_users WHERE id = $1`, user)
	})
	base := time.Date(2026, 6, 1, 12, 0, 0, 0, time.UTC)
	var batch []domain.ClientLog
	for i := 0; i < 35; i++ {
		batch = append(batch, sampleLog(i, base, "batch"))
	}
	for i := 10; i < 15; i++ {
		batch = append(batch, sampleLog(i, base.Add(time.Minute), "later"))
	}
	if len(batch) != 40 {
		t.Fatalf("batch %d", len(batch))
	}
	for i := 0; i < 5; i++ {
		row := sampleLog(i, base.Add(-time.Hour), "seeded")
		row.Module = "seed"
		if err := insertClientLogSequential(ctx, pool, org, user, row); err != nil {
			t.Fatal(err)
		}
	}

	oracleTx, err := tenantx.BeginApp(ctx, pool.Begin, org)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range batch {
		if err := insertClientLogSequentialTx(ctx, oracleTx, org, user, row); err != nil {
			oracleTx.Rollback(ctx)
			t.Fatal(err)
		}
	}
	want := readClientLogs(t, ctx, oracleTx, user)
	oracleTx.Rollback(ctx)

	trace.reset()
	repo := New(traced)
	if err := repo.InsertClientLogs(ctx, org, user, batch); err != nil {
		t.Fatal(err)
	}
	got := readClientLogs(t, ctx, traced, user)
	if len(got) != len(want) {
		t.Fatalf("rows %d want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("row %d\n got %+v\nwant %+v", i, got[i], want[i])
		}
	}
	n := trace.count("INSERT INTO public.client_listing_logs")
	t.Logf("client_listing_logs insert statements for 40 rows (5 conflicts, duplicate client_id): %d", n)
	if n != 1 {
		t.Fatalf("statements %d", n)
	}
	for _, row := range got[:5] {
		if row.Event != "seeded" || row.Module != "seed" {
			t.Fatalf("conflict overwrote %+v", row)
		}
	}
	for _, row := range got {
		if row.Event == "later" {
			t.Fatalf("duplicate client_id replaced the first row %+v", row)
		}
	}

	trace.reset()
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if err := repo.InsertClientLogs(cancelled, org, user, nil); err != nil {
		t.Fatal(err)
	}
	if err := repo.InsertClientLogs(cancelled, org, user, []domain.ClientLog{}); err != nil {
		t.Fatal(err)
	}
	if n := trace.count("client_listing_logs"); n != 0 {
		t.Fatalf("empty batch opened work %d", n)
	}
}

func BenchmarkInsertClientLogs(b *testing.B) {
	pool, ctx := telemetryBatchDB(b)
	user := int64(883002)
	org := seedTelemetryOrg(b, ctx, pool, user)
	b.Cleanup(func() {
		c := context.Background()
		_, _ = pool.Exec(c, `DELETE FROM client_listing_logs WHERE user_id = $1`, user)
		_, _ = pool.Exec(c, `DELETE FROM organization_members WHERE org_id = $1`, org)
		_, _ = pool.Exec(c, `DELETE FROM organizations WHERE id = $1`, org)
		_, _ = pool.Exec(c, `DELETE FROM account_users WHERE id = $1`, user)
	})
	repo := New(pool)
	base := time.Date(2026, 6, 2, 0, 0, 0, 0, time.UTC)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		b.StopTimer()
		_, _ = pool.Exec(ctx, `DELETE FROM client_listing_logs WHERE user_id = $1`, user)
		batch := make([]domain.ClientLog, 40)
		for n := 0; n < 40; n++ {
			batch[n] = sampleLog(i*40+n, base, "bench")
		}
		b.StartTimer()
		if err := repo.InsertClientLogs(ctx, org, user, batch); err != nil {
			b.Fatal(err)
		}
	}
}

type clientLogRow struct {
	ClientID, SessionID, Version, Level, Module, Event string
	LoggedAt                                           time.Time
	Duration                                           sql.NullInt32
	BatchID, RowID, OfferID, IntentID, JobID, PsdID    sql.NullString
	ErrorCode, ErrorMessage                            sql.NullString
	Fields                                             string
}

func sampleLog(i int, at time.Time, event string) domain.ClientLog {
	row := domain.ClientLog{
		ClientID:  fmt.Sprintf("00000000-0000-4000-8000-%012d", i),
		SessionID: "00000000-0000-4000-8000-0000000000aa",
		Version:   "1.2.3",
		LoggedAt:  at,
		Level:     "info",
		Module:    "listing",
		Event:     event,
		Fields:    `{"rows":1}`,
	}
	if i%2 == 0 {
		d := int32(i + 1)
		row.DurationMS = &d
		msg := fmt.Sprintf("m-%d", i)
		row.ErrorMessage = &msg
		code := "ok"
		row.ErrorCode = &code
	}
	return row
}

type logQuery interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

func readClientLogs(t *testing.T, ctx context.Context, q logQuery, user int64) []clientLogRow {
	t.Helper()
	rows, err := q.Query(ctx, `
		SELECT client_id, session_id, version, logged_at, level, module, event,
		       duration_ms, batch_id, row_id, offer_id, intent_id, job_id, psd_id,
		       error_code, error_message, fields::text
		  FROM client_listing_logs
		 WHERE user_id = $1
		 ORDER BY client_id`, user)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []clientLogRow
	for rows.Next() {
		var row clientLogRow
		if err := rows.Scan(&row.ClientID, &row.SessionID, &row.Version, &row.LoggedAt, &row.Level, &row.Module, &row.Event,
			&row.Duration, &row.BatchID, &row.RowID, &row.OfferID, &row.IntentID, &row.JobID, &row.PsdID,
			&row.ErrorCode, &row.ErrorMessage, &row.Fields); err != nil {
			t.Fatal(err)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func insertClientLogSequential(ctx context.Context, pool *pgxpool.Pool, org, user int64, row domain.ClientLog) error {
	tx, err := tenantx.BeginApp(ctx, pool.Begin, org)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := insertClientLogSequentialTx(ctx, tx, org, user, row); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func insertClientLogSequentialTx(ctx context.Context, tx pgx.Tx, org, user int64, row domain.ClientLog) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO public.client_listing_logs (
		    org_id, user_id, client_id, session_id, version, logged_at, level, module, event,
		    duration_ms, batch_id, row_id, offer_id, intent_id, job_id, psd_id, error_code,
		    error_message, fields
		) VALUES (
		    $1, $2, $3, $4, $5, $6, $7, $8, $9,
		    $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb
		)
		ON CONFLICT (user_id, client_id) DO NOTHING`,
		org, user, row.ClientID, row.SessionID, row.Version, row.LoggedAt, row.Level, row.Module, row.Event,
		row.DurationMS, row.BatchID, row.RowID, row.OfferID, row.IntentID, row.JobID, row.PsdID, row.ErrorCode,
		row.ErrorMessage, row.Fields)
	return err
}

func seedTelemetryOrg(t telemetryFail, ctx context.Context, pool *pgxpool.Pool, user int64) int64 {
	t.Helper()
	if _, err := pool.Exec(ctx, `
		INSERT INTO account_users (id, public_id, email, password_hash, role, name, target, supplier_id, plan, created_at, updated_at)
		VALUES ($1, $2, $3, 'x', 'user', 't', '/workspace', '', 'lite', clock_timestamp(), clock_timestamp())
		ON CONFLICT (id) DO NOTHING`, user, fmt.Sprintf("tel%d", user), fmt.Sprintf("tel%d@example.invalid", user)); err != nil {
		t.Fatal(err)
	}
	var org int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO organizations (owner_user_id, name, plan, created_at, updated_at)
		VALUES ($1, $2, 'lite', clock_timestamp(), clock_timestamp()) RETURNING id`, user, fmt.Sprintf("tel-org-%d", user)).Scan(&org); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO organization_members (org_id, user_id, role, status, display_name, created_at, updated_at, join_order)
		VALUES ($1, $2, 'owner', 'active', 't', clock_timestamp(), clock_timestamp(), 1)`, org, user); err != nil {
		t.Fatal(err)
	}
	return org
}

type telemetryFail interface {
	Helper()
	Fatal(args ...any)
	Skip(args ...any)
	Cleanup(func())
}

var (
	telemetryOnce sync.Once
	telemetryPool *pgxpool.Pool
	telemetryErr  error
)

func telemetryBatchDB(t telemetryFail) (*pgxpool.Pool, context.Context) {
	t.Helper()
	dsn := os.Getenv("PODHUB_PARITY_DSN")
	if dsn == "" {
		if _, err := os.Stat("/var/run/docker.sock"); err != nil {
			t.Skip("docker daemon is not available")
		}
	}
	telemetryOnce.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		if dsn == "" {
			container, err := postgres.Run(ctx, "postgres:16-alpine",
				postgres.WithDatabase("podhub"),
				postgres.WithUsername("postgres"),
				postgres.WithPassword("postgres"),
				postgres.BasicWaitStrategies(),
			)
			if err != nil {
				telemetryErr = err
				return
			}
			dsn, err = container.ConnectionString(ctx, "sslmode=disable")
			if err != nil {
				telemetryErr = err
				return
			}
		}
		cfg := config.Config{DatabaseURL: dsn}
		if err := cfg.CheckDatabase(); err != nil {
			telemetryErr = err
			return
		}
		_ = os.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "1")
		pool, err := db.Connect(ctx, cfg)
		if err != nil {
			telemetryErr = err
			return
		}
		if err := db.Migrate(ctx, pool); err != nil {
			pool.Close()
			telemetryErr = err
			return
		}
		telemetryPool = pool
	})
	if telemetryErr != nil {
		t.Fatal(telemetryErr)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	t.Cleanup(cancel)
	return telemetryPool, ctx
}

type telemetryTrace struct {
	mu   sync.Mutex
	sqls []string
}

func (s *telemetryTrace) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	s.mu.Lock()
	s.sqls = append(s.sqls, data.SQL)
	s.mu.Unlock()
	return ctx
}

func (s *telemetryTrace) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func (s *telemetryTrace) reset() {
	s.mu.Lock()
	s.sqls = nil
	s.mu.Unlock()
}

func (s *telemetryTrace) count(part string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, sql := range s.sqls {
		if strings.Contains(sql, part) {
			n++
		}
	}
	return n
}

func telemetryTracedPool(t telemetryFail, ctx context.Context, base *pgxpool.Pool) (*pgxpool.Pool, *telemetryTrace) {
	t.Helper()
	cfg := base.Config().Copy()
	tr := &telemetryTrace{}
	cfg.ConnConfig.Tracer = tr
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool, tr
}
