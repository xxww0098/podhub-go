package integration

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/platform/db"
	catalogrepo "github.com/xxww0098/podhub-go/internal/suppliercatalog/repo"
)

// TestCatalogManagerIsolation is the 00365 acceptance test: two catalog
// managers, each active on a different source, must not see each other's
// source. The gate is the RLS arm, not a WHERE clause, so this also proves
// db.CatalogManager sets app.current_org_user_id.
func TestCatalogManagerIsolation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)

	var userA, userB, stranger int64
	if err := pool.QueryRow(ctx, `INSERT INTO account_users (id, public_id, email, password_hash, role, name, target, supplier_id, plan, created_at, updated_at)
		VALUES (910001, 'mgr-a@test.example', 'mgr-a@test.example', 'x', 'user', 'M', '/workspace', '', 'free', clock_timestamp(), clock_timestamp())
		RETURNING id`).Scan(&userA); err != nil {
		t.Fatalf("insert manager A: %v", err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO account_users (id, public_id, email, password_hash, role, name, target, supplier_id, plan, created_at, updated_at)
		VALUES (910002, 'mgr-b@test.example', 'mgr-b@test.example', 'x', 'user', 'M', '/workspace', '', 'free', clock_timestamp(), clock_timestamp())
		RETURNING id`).Scan(&userB); err != nil {
		t.Fatalf("insert manager B: %v", err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO account_users (id, public_id, email, password_hash, role, name, target, supplier_id, plan, created_at, updated_at)
		VALUES (910003, 'stranger@test.example', 'stranger@test.example', 'x', 'user', 'M', '/workspace', '', 'free', clock_timestamp(), clock_timestamp())
		RETURNING id`).Scan(&stranger); err != nil {
		t.Fatalf("insert stranger: %v", err)
	}

	for _, s := range []struct {
		source string
		user   int64
	}{{"src_mgr_a", userA}, {"src_mgr_b", userB}} {
		if _, err := pool.Exec(ctx, `INSERT INTO sc_sources (source_id, name, created_at_ms, updated_at_ms) VALUES ($1, $1, 1, 1)`, s.source); err != nil {
			t.Fatalf("insert source %s: %v", s.source, err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO sc_catalog_managers (source_id, user_id, created_at_ms) VALUES ($1, $2, 1)`, s.source, s.user); err != nil {
			t.Fatalf("insert manager %s: %v", s.source, err)
		}
	}

	repo := catalogrepo.Repo{Pool: pool}

	dataA, err := repo.Sources(ctx, userA)
	if err != nil {
		t.Fatalf("sources A: %v", err)
	}
	if len(dataA.Sources) != 1 || dataA.Sources[0].SourceID != "src_mgr_a" {
		t.Fatalf("manager A sees %+v, want exactly src_mgr_a", dataA.Sources)
	}
	dataB, err := repo.Sources(ctx, userB)
	if err != nil {
		t.Fatalf("sources B: %v", err)
	}
	if len(dataB.Sources) != 1 || dataB.Sources[0].SourceID != "src_mgr_b" {
		t.Fatalf("manager B sees %+v, want exactly src_mgr_b", dataB.Sources)
	}

	data, err := repo.Sources(ctx, stranger)
	if err != nil {
		t.Fatalf("sources stranger: %v", err)
	}
	if len(data.Sources) != 0 {
		t.Fatalf("stranger sees %+v, want none", data.Sources)
	}

	// The manager session must NOT carry staff access: a bare sc_products
	// read is filtered by the published arm, not waved through.
	var visible int
	if err := db.InTx(ctx, pool, db.CatalogManager(userA), func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT count(*) FROM sc_products`).Scan(&visible)
	}); err != nil {
		t.Fatalf("count products as manager: %v", err)
	}
	if visible != 0 {
		t.Fatalf("manager sees %d unpublished products, want 0", visible)
	}
}
