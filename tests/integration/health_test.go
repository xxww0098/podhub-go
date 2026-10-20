package integration

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/app"
	httpapi "github.com/xxww0098/podhub-go/internal/app/api"
	"github.com/xxww0098/podhub-go/internal/platform/db/sqlc"
	"github.com/xxww0098/podhub-go/tests/parity"
	"github.com/xxww0098/podhub-go/tests/testkit"
)

func TestMigrationsAndHealth(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	n, err := sqlc.New(pool).CountBannedTags(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if n != 6 {
		t.Fatalf("banned_tags rows = %d, want 6", n)
	}

	before := tableCounts(t, ctx, pool)
	handler := app.Handler(pool)
	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("nosniff missing")
	}
	if err := parity.DiffHTTP(parity.Exchange{Status: rec.Code, Body: rec.Body.Bytes()}, parity.Exchange{
		Status: http.StatusOK,
		Body:   []byte(`{"ok":true,"db":"available","ts":0,"writer_leases":[]}`),
	}); err != nil {
		t.Fatal(err)
	}
	if err := parity.DiffCounts(before, tableCounts(t, ctx, pool)); err != nil {
		t.Fatal(err)
	}
	var body httpapi.HealthResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if !body.Ok || body.Db != httpapi.Available || len(body.WriterLeases) != 0 {
		t.Fatalf("%+v", body)
	}
}

func tableCounts(t *testing.T, ctx context.Context, pool *pgxpool.Pool) map[string]int64 {
	t.Helper()
	rows, err := pool.Query(ctx, `
		SELECT c.relname FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'public' AND c.relkind = 'r'
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
	out := map[string]int64{}
	for _, name := range names {
		var n int64
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM public.`+testkit.QuoteIdent(name)).Scan(&n); err != nil {
			t.Fatal(err)
		}
		out[name] = n
	}
	return out
}
