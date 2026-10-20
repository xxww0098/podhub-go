package readhttp

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go/modules/postgres"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
)

func TestListingSnapshotBatchParity(t *testing.T) {
	pool, ctx := listingBatchDB(t)
	traced, trace := tracedPool(t, ctx, pool)
	user := int64(881001)
	org := seedListingOrg(t, ctx, pool, user, "snap-batch")
	card := "c8810010-0000-4000-8000-000000000001"
	insertListingCard(t, ctx, pool, card, org)
	t.Cleanup(func() {
		c := context.Background()
		_, _ = pool.Exec(c, `DELETE FROM listing_rows WHERE org_id = $1`, org)
		_, _ = pool.Exec(c, `DELETE FROM listing_cards WHERE org_id = $1`, org)
		_, _ = pool.Exec(c, `DELETE FROM listing_schema_revisions WHERE schema_revision LIKE 'batch-ef78-%'`)
		_, _ = pool.Exec(c, `DELETE FROM organization_members WHERE org_id = $1`, org)
		_, _ = pool.Exec(c, `DELETE FROM organizations WHERE id = $1`, org)
		_, _ = pool.Exec(c, `DELETE FROM account_users WHERE id = $1`, user)
	})

	rev := func(n int) string { return fmt.Sprintf("batch-ef78-rev-%02d", n) }
	for i := 0; i < 10; i++ {
		insertSchemaRevision(t, ctx, pool, rev(i), fmt.Sprintf(`{"fields":[{"id":"f%d"}]}`, i))
	}
	h := listingHost(traced, org, user)

	t.Run("list bytes match per-row hydrate", func(t *testing.T) {
		_, _ = pool.Exec(ctx, `DELETE FROM listing_rows WHERE org_id = $1`, org)
		rows := []struct {
			id      string
			updated string
			payload string
		}{
			{"a8810010-0000-4000-8000-000000000006", "2026-01-06T00:00:00Z", `{"schemaSnapshot":{"x":1},"schemaRevision":"batch-ef78-rev-00","draft":{"values":{}}}`},
			{"a8810010-0000-4000-8000-000000000005", "2026-01-05T00:00:00Z", `{"schemaRevision":"batch-ef78-rev-01","draft":{"a":1}}`},
			{"a8810010-0000-4000-8000-000000000004", "2026-01-04T00:00:00Z", `{"schemaRevision":"batch-ef78-rev-01","name":"second"}`},
			{"a8810010-0000-4000-8000-000000000003", "2026-01-03T00:00:00Z", `{"draft":{"values":{}}}`},
			{"a8810010-0000-4000-8000-000000000002", "2026-01-02T00:00:00Z", `{"schemaRevision":1,"draft":{}}`},
			{"a8810010-0000-4000-8000-000000000001", "2026-01-01T00:00:00Z", `{"schemaRevision":"","draft":{}}`},
		}
		for _, row := range rows {
			insertPayloadRow(t, ctx, pool, row.id, org, card, row.updated, row.payload)
		}
		trace.reset()
		got := callList(t, h, "/api/listing/rows?limit=100")
		schemaN := trace.count("listing_schema_revisions")
		if got.Code != http.StatusOK {
			t.Fatalf("list %d %s", got.Code, got.Body.String())
		}
		want := listOracle(t, ctx, h, org, 100)
		if got.Body.String() != string(want) {
			t.Fatalf("list bytes\n got %s\nwant %s", got.Body.String(), want)
		}
		if schemaN != 1 {
			t.Fatalf("schema statements %d, want 1 (rows that already have schemaSnapshot are skipped)", schemaN)
		}
		trace.reset()
		one := callGetRow(t, h, rows[1].id)
		if one.Code != http.StatusOK {
			t.Fatalf("get %d %s", one.Code, one.Body.String())
		}
		wantOne := getOracle(t, ctx, h, org, rows[1].id)
		if one.Body.String() != string(wantOne) {
			t.Fatalf("get bytes\n got %s\nwant %s", one.Body.String(), wantOne)
		}
	})

	t.Run("missing snapshot keeps the first revision sentence and the 500 body", func(t *testing.T) {
		_, _ = pool.Exec(ctx, `DELETE FROM listing_rows WHERE org_id = $1`, org)
		insertPayloadRow(t, ctx, pool, "a8810010-0000-4000-8000-000000000013", org, card, "2026-02-03T00:00:00Z", `{"schemaSnapshot":{"x":1},"schemaRevision":"batch-ef78-kept"}`)
		first := "batch-ef78-missing-first"
		second := "batch-ef78-missing-second"
		insertPayloadRow(t, ctx, pool, "a8810010-0000-4000-8000-000000000012", org, card, "2026-02-02T00:00:00Z", `{"schemaRevision":"`+first+`"}`)
		insertPayloadRow(t, ctx, pool, "a8810010-0000-4000-8000-000000000011", org, card, "2026-02-01T00:00:00Z", `{"schemaRevision":"`+second+`"}`)
		scanned := scanOrgRows(t, ctx, h, org)
		batchErr := h.withOrg(ctx, org, func(tx pgx.Tx) error {
			_, err := h.hydrateRows(ctx, tx, scanned)
			return err
		})
		seqErr := h.withOrg(ctx, org, func(tx pgx.Tx) error {
			for _, item := range scanned {
				if _, err := h.withSnapshot(ctx, tx, item); err != nil {
					return err
				}
			}
			return nil
		})
		wantErr := "schema revision " + first + " is not registered; the row payload references a snapshot the registry does not carry"
		if batchErr == nil || batchErr.Error() != wantErr {
			t.Fatalf("batch err %v", batchErr)
		}
		if seqErr == nil || seqErr.Error() != batchErr.Error() {
			t.Fatalf("sequential err %v", seqErr)
		}
		if strings.Contains(batchErr.Error(), second) {
			t.Fatalf("error named the later revision: %v", batchErr)
		}
		trace.reset()
		got := callList(t, h, "/api/listing/rows?limit=100")
		fixture := strings.TrimRight(string(mustRead(t, "testdata/missing-snapshot-500.json")), "\n")
		if got.Code != http.StatusInternalServerError || got.Body.String() != fixture {
			t.Fatalf("500 %d %s", got.Code, got.Body.String())
		}
		if n := trace.count("listing_schema_revisions"); n != 1 {
			t.Fatalf("missing snapshot still one registry read, got %d", n)
		}
	})

	t.Run("100 rows and 10 revisions are one registry read", func(t *testing.T) {
		_, _ = pool.Exec(ctx, `DELETE FROM listing_rows WHERE org_id = $1`, org)
		for i := 0; i < 100; i++ {
			id := fmt.Sprintf("b8810010-0000-4000-8000-%012d", i)
			updated := time.Date(2026, 3, 1, 0, 0, i, 0, time.UTC).Format(time.RFC3339)
			payload := fmt.Sprintf(`{"schemaRevision":"%s"}`, rev(i%10))
			insertPayloadRow(t, ctx, pool, id, org, card, updated, payload)
		}
		trace.reset()
		got := callList(t, h, "/api/listing/rows?limit=100")
		n := trace.count("listing_schema_revisions")
		if got.Code != http.StatusOK {
			t.Fatalf("list %d %s", got.Code, got.Body.String())
		}
		want := listOracle(t, ctx, h, org, 100)
		if got.Body.String() != string(want) {
			t.Fatalf("100-row list bytes differ (len got %d want %d)", got.Body.Len(), len(want))
		}
		t.Logf("schema revision statements for 100 rows / 10 revisions: %d", n)
		if n != 1 {
			t.Fatalf("statements %d", n)
		}
	})

	t.Run("empty page and snapshot-only page issue no registry read", func(t *testing.T) {
		_, _ = pool.Exec(ctx, `DELETE FROM listing_rows WHERE org_id = $1`, org)
		trace.reset()
		got := callList(t, h, "/api/listing/rows?limit=100")
		if got.Code != http.StatusOK || got.Body.String() != `{"data":{"items":[]}}` {
			t.Fatalf("empty %d %s", got.Code, got.Body.String())
		}
		if n := trace.count("listing_schema_revisions"); n != 0 {
			t.Fatalf("empty page queries %d", n)
		}
		insertPayloadRow(t, ctx, pool, "a8810010-0000-4000-8000-000000000021", org, card, "2026-04-01T00:00:00Z", `{"schemaSnapshot":{"x":1},"schemaRevision":"batch-ef78-rev-00"}`)
		trace.reset()
		got = callList(t, h, "/api/listing/rows?limit=100")
		want := listOracle(t, ctx, h, org, 100)
		if got.Body.String() != string(want) {
			t.Fatalf("snapshot-only bytes\n got %s\nwant %s", got.Body.String(), want)
		}
		if n := trace.count("listing_schema_revisions"); n != 0 {
			t.Fatalf("snapshot-only queries %d", n)
		}
	})
}

func BenchmarkListSchemaSnapshots(b *testing.B) {
	pool, ctx := listingBatchDB(b)
	traced, _ := tracedPool(b, ctx, pool)
	user := int64(881002)
	org := seedListingOrg(b, ctx, pool, user, "snap-bench")
	card := "c8810020-0000-4000-8000-000000000001"
	insertListingCard(b, ctx, pool, card, org)
	b.Cleanup(func() {
		c := context.Background()
		_, _ = pool.Exec(c, `DELETE FROM listing_rows WHERE org_id = $1`, org)
		_, _ = pool.Exec(c, `DELETE FROM listing_cards WHERE org_id = $1`, org)
		_, _ = pool.Exec(c, `DELETE FROM listing_schema_revisions WHERE schema_revision LIKE 'batch-ef78-bench-%'`)
		_, _ = pool.Exec(c, `DELETE FROM organization_members WHERE org_id = $1`, org)
		_, _ = pool.Exec(c, `DELETE FROM organizations WHERE id = $1`, org)
		_, _ = pool.Exec(c, `DELETE FROM account_users WHERE id = $1`, user)
	})
	for i := 0; i < 10; i++ {
		insertSchemaRevision(b, ctx, pool, fmt.Sprintf("batch-ef78-bench-%02d", i), fmt.Sprintf(`{"fields":[{"id":"b%d"}]}`, i))
	}
	for i := 0; i < 100; i++ {
		id := fmt.Sprintf("d8810020-0000-4000-8000-%012d", i)
		updated := time.Date(2026, 5, 1, 0, 0, i, 0, time.UTC).Format(time.RFC3339)
		payload := fmt.Sprintf(`{"schemaRevision":"batch-ef78-bench-%02d"}`, i%10)
		insertPayloadRow(b, ctx, pool, id, org, card, updated, payload)
	}
	h := listingHost(traced, org, user)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		rec := callList(b, h, "/api/listing/rows?limit=100")
		if rec.Code != http.StatusOK {
			b.Fatalf("%d %s", rec.Code, rec.Body.String())
		}
	}
}

func listOracle(t testing.TB, ctx context.Context, h Host, org int64, limit int64) []byte {
	t.Helper()
	fetch := limit + 1
	if fetch > 101 {
		fetch = 101
	}
	var items []storedScan
	err := h.withOrg(ctx, org, func(tx pgx.Tx) error {
		listed, err := tx.Query(ctx, `SELECT `+rowColumns+` FROM listing_rows WHERE org_id = $1 ORDER BY updated_at DESC, id DESC LIMIT $2`, org, fetch)
		if err != nil {
			return err
		}
		defer listed.Close()
		var scanned []storedScan
		for listed.Next() {
			item, err := scanStoredRow(listed)
			if err != nil {
				return err
			}
			scanned = append(scanned, item)
		}
		if err := listed.Err(); err != nil {
			return err
		}
		listed.Close()
		for _, item := range scanned {
			item, err = h.withSnapshot(ctx, tx, item)
			if err != nil {
				return err
			}
			items = append(items, item)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	var next *string
	if int64(len(items)) > limit {
		items = items[:limit]
		last := items[len(items)-1]
		cursor := FormatCursor(last.micros, last.row.ID)
		next = &cursor
	}
	views := make([]RowView, 0, len(items))
	for _, item := range items {
		views = append(views, ProjectRow(item.row))
	}
	raw, err := jsonwire.Marshal(struct {
		Data struct {
			Items      []RowView `json:"items"`
			NextCursor *string   `json:"nextCursor,omitempty"`
		} `json:"data"`
	}{Data: struct {
		Items      []RowView `json:"items"`
		NextCursor *string   `json:"nextCursor,omitempty"`
	}{Items: views, NextCursor: next}})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func getOracle(t testing.TB, ctx context.Context, h Host, org int64, id string) []byte {
	t.Helper()
	var item storedScan
	err := h.withOrg(ctx, org, func(tx pgx.Tx) error {
		scanned, err := scanStoredRow(tx.QueryRow(ctx, `SELECT `+rowColumns+` FROM listing_rows WHERE org_id = $1 AND id = $2::uuid`, org, id))
		if err != nil {
			return err
		}
		item, err = h.withSnapshot(ctx, tx, scanned)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := jsonwire.Marshal(struct {
		Data    RowView `json:"data"`
		Created *bool   `json:"created,omitempty"`
	}{Data: ProjectRow(item.row)})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func scanOrgRows(t testing.TB, ctx context.Context, h Host, org int64) []storedScan {
	t.Helper()
	var scanned []storedScan
	err := h.withOrg(ctx, org, func(tx pgx.Tx) error {
		listed, err := tx.Query(ctx, `SELECT `+rowColumns+` FROM listing_rows WHERE org_id = $1 ORDER BY updated_at DESC, id DESC`, org)
		if err != nil {
			return err
		}
		defer listed.Close()
		for listed.Next() {
			item, err := scanStoredRow(listed)
			if err != nil {
				return err
			}
			scanned = append(scanned, item)
		}
		return listed.Err()
	})
	if err != nil {
		t.Fatal(err)
	}
	return scanned
}

func callList(t testing.TB, h Host, path string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	h.listRows(rec, req)
	return rec
}

func callGetRow(t testing.TB, h Host, id string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/listing/rows/"+id, nil)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", id)
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
	h.getRow(rec, req)
	return rec
}

func listingHost(pool *pgxpool.Pool, org, user int64) Host {
	p := access.Principal{UserID: user, OrgID: org, WorkspaceRole: "owner", PlatformRole: "user"}
	return Host{Pool: pool, Access: access.FixedResolver{Principal: &p}}
}

func mustRead(t testing.TB, path string) []byte {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

type testFail interface {
	Helper()
	Fatal(args ...any)
	Skip(args ...any)
	Cleanup(func())
}

func seedListingOrg(t testFail, ctx context.Context, pool *pgxpool.Pool, user int64, tag string) int64 {
	t.Helper()
	if _, err := pool.Exec(ctx, `
		INSERT INTO account_users (id, public_id, email, password_hash, role, name, target, supplier_id, plan, created_at, updated_at)
		VALUES ($1, $2, $3, 'x', 'user', 't', '/workspace', '', 'lite', clock_timestamp(), clock_timestamp())
		ON CONFLICT (id) DO NOTHING`, user, fmt.Sprintf("u%d", user), fmt.Sprintf("u%d@example.invalid", user)); err != nil {
		t.Fatal(err)
	}
	var org int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO organizations (owner_user_id, name, plan, created_at, updated_at)
		VALUES ($1, $2, 'lite', clock_timestamp(), clock_timestamp()) RETURNING id`, user, "org-"+tag).Scan(&org); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO organization_members (org_id, user_id, role, status, display_name, created_at, updated_at, join_order)
		VALUES ($1, $2, 'owner', 'active', 't', clock_timestamp(), clock_timestamp(), 1)`, org, user); err != nil {
		t.Fatal(err)
	}
	return org
}

func insertListingCard(t testFail, ctx context.Context, pool *pgxpool.Pool, id string, org int64) {
	t.Helper()
	if _, err := pool.Exec(ctx, `INSERT INTO listing_cards (id, org_id, title, payload) VALUES ($1::uuid, $2, '卡', '{}'::jsonb)`, id, org); err != nil {
		t.Fatal(err)
	}
}

func insertPayloadRow(t testFail, ctx context.Context, pool *pgxpool.Pool, id string, org int64, card, updated, payload string) {
	t.Helper()
	if _, err := pool.Exec(ctx, `
		INSERT INTO listing_rows (id, org_id, card_id, payload, updated_at)
		VALUES ($1::uuid, $2, $3::uuid, $4::jsonb, $5::timestamptz)`, id, org, card, payload, updated); err != nil {
		t.Fatal(err)
	}
}

func insertSchemaRevision(t testFail, ctx context.Context, pool *pgxpool.Pool, rev, snapshot string) {
	t.Helper()
	if _, err := pool.Exec(ctx, `
		INSERT INTO listing_schema_revisions (schema_revision, snapshot)
		VALUES ($1, $2::jsonb)
		ON CONFLICT (schema_revision) DO UPDATE SET snapshot = EXCLUDED.snapshot`, rev, snapshot); err != nil {
		t.Fatal(err)
	}
}

var (
	listingOnce sync.Once
	listingPool *pgxpool.Pool
	listingErr  error
)

func listingBatchDB(t testFail) (*pgxpool.Pool, context.Context) {
	t.Helper()
	dsn := os.Getenv("PODHUB_PARITY_DSN")
	if dsn == "" {
		if _, err := os.Stat("/var/run/docker.sock"); err != nil {
			t.Skip("docker daemon is not available")
		}
	}
	listingOnce.Do(func() {
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
				listingErr = err
				return
			}
			dsn, err = container.ConnectionString(ctx, "sslmode=disable")
			if err != nil {
				listingErr = err
				return
			}
		}
		cfg := config.Config{DatabaseURL: dsn}
		if err := cfg.CheckDatabase(); err != nil {
			listingErr = err
			return
		}
		_ = os.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "1")
		pool, err := db.Connect(ctx, cfg)
		if err != nil {
			listingErr = err
			return
		}
		if err := db.Migrate(ctx, pool); err != nil {
			pool.Close()
			listingErr = err
			return
		}
		listingPool = pool
	})
	if listingErr != nil {
		t.Fatal(listingErr)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	t.Cleanup(cancel)
	return listingPool, ctx
}

type sqlTrace struct {
	mu   sync.Mutex
	sqls []string
}

func (s *sqlTrace) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	s.mu.Lock()
	s.sqls = append(s.sqls, data.SQL)
	s.mu.Unlock()
	return ctx
}

func (s *sqlTrace) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func (s *sqlTrace) reset() {
	s.mu.Lock()
	s.sqls = nil
	s.mu.Unlock()
}

func (s *sqlTrace) count(part string) int {
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

func tracedPool(t testFail, ctx context.Context, base *pgxpool.Pool) (*pgxpool.Pool, *sqlTrace) {
	t.Helper()
	cfg := base.Config().Copy()
	tr := &sqlTrace{}
	cfg.ConnConfig.Tracer = tr
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool, tr
}
