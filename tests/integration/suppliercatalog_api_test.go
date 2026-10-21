package integration

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/platform/db"

	"github.com/xxww0098/podhub-go/internal/suppliercatalog/contract"
	catalogrepo "github.com/xxww0098/podhub-go/internal/suppliercatalog/repo"
)

// These tests drive the catalogue manager repo directly, on a real database,
// with db.CatalogManager sessions. That is the only way to prove the thing that
// matters: the authorization is the RLS arm in 00365, not a WHERE clause. A
// repo test with a superuser pool would pass even if every policy were dropped.

// TestSupplierCatalogRowLifecycle walks create -> read -> update -> publish
// refusal -> archive.
//
// Every step runs as the manager, so each statement is filtered by RLS. The
// publish step is asserted to FAIL: the readiness gates include prompt,
// fixedTags and ozonConfig, which are staff-owned, so a manager-created row is
// not publishable on its own. That is the intended shape of the role, and a
// test that expected success there would be encoding the wrong model.
func TestSupplierCatalogRowLifecycle(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)

	manager, source := seedCatalogManager(t, ctx, pool, 960001, "lifecycle")
	repo := catalogrepo.Repo{Pool: pool}
	const now = int64(1_700_000_000_000)

	created, err := repo.CreateRow(ctx, manager, source, contract.RowInput{
		Title:         "Test row",
		PlatformCode:  "ozon-1",
		Size:          "M",
		CostCents:     ptrInt64(4200),
		ShippingCents: ptrInt64(300),
	}, now)
	if err != nil {
		t.Fatalf("create row: %v", err)
	}
	if created.ProductID == "" || created.SKUID == "" {
		t.Fatalf("created row has empty ids: %+v", created)
	}
	if created.Published {
		t.Fatalf("a new row must not be published")
	}
	if created.Readiness.Ready() {
		t.Fatalf("a manager-created row is missing staff-owned gates; readiness must be false: %+v", created.Readiness)
	}

	// costCents must not appear in the response shape at all.
	if created.PlatformPriceCents != nil {
		t.Fatalf("a new row already has a platform price: %v", *created.PlatformPriceCents)
	}

	// Read it back, and check the cost is not exposed.
	read, err := repo.Row(ctx, manager, source, created.ProductID)
	if err != nil {
		t.Fatalf("read row: %v", err)
	}
	if read.Title != "Test row" || read.PlatformCode != "ozon-1" {
		t.Fatalf("read back %+v, want the created values", read)
	}

	// The manager can change the cost: that column IS in its write grant.
	read.Title = "Renamed"
	updated, err := repo.UpdateRow(ctx, manager, source, created.ProductID, contract.RowInput{
		Title:            "Renamed",
		PlatformCode:     "ozon-1",
		Size:             "M",
		CostCents:        ptrInt64(5000),
		ShippingCents:    ptrInt64(350),
		ExpectedRevision: ptrInt64(read.Revision),
	}, now+1)
	if err != nil {
		t.Fatalf("update row: %v", err)
	}
	if updated.Title != "Renamed" {
		t.Fatalf("update did not apply: %+v", updated.Title)
	}
	if updated.Revision != read.Revision+1 {
		t.Fatalf("revision went %d -> %d, want +1", read.Revision, updated.Revision)
	}

	// A stale revision must be refused.
	if _, err := repo.UpdateRow(ctx, manager, source, created.ProductID, contract.RowInput{
		Title:            "Nope",
		PlatformCode:     "ozon-1",
		ExpectedRevision: ptrInt64(read.Revision),
	}, now+2); err == nil {
		t.Fatalf("a stale revision was accepted; optimistic concurrency is gone")
	}

	// Publishing must be refused while the staff-owned gates are unmet.
	_, err = repo.SetPublished(ctx, manager, source, created.ProductID, true, now+3)
	if err == nil {
		t.Fatalf("a manager published a row with unmet readiness gates")
	}
	f, ok := contract.AsFault(err)
	if !ok || f.Status != 400 || len(f.Missing) == 0 {
		t.Fatalf("publish refusal should be a 400 listing the missing keys, got %v", err)
	}

	// Archive is the delete, and it is soft: the row disappears from the list
	// but the product row survives.
	if err := repo.DeleteRow(ctx, manager, source, created.ProductID, now+4); err != nil {
		t.Fatalf("delete row: %v", err)
	}
	list, err := repo.Rows(ctx, manager, source)
	if err != nil {
		t.Fatalf("list after delete: %v", err)
	}
	for _, row := range list.Rows {
		if row.ProductID == created.ProductID {
			t.Fatalf("an archived row is still listed")
		}
	}
	var archived bool
	if err := pool.QueryRow(ctx, `SELECT archived FROM sc_products WHERE product_id = $1`, created.ProductID).Scan(&archived); err != nil {
		t.Fatalf("reread archived: %v", err)
	}
	if !archived {
		t.Fatalf("the row was hard-deleted, not archived")
	}
}

// TestSupplierCatalogManagerIsolationAcrossSources asserts the 00365 arms on
// the manager surface: two managers, two sources, and neither can read or
// write the other's rows.
//
// The important half is the WRITE attempt. A read filtered by RLS returning 0
// rows proves the SELECT arm; only a refused write proves the INSERT / UPDATE
// arms, and a missing write arm is the silent failure that would let one
// factory's manager edit another's catalogue.
func TestSupplierCatalogManagerIsolationAcrossSources(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)

	managerA, sourceA := seedCatalogManager(t, ctx, pool, 960010, "iso-a")
	managerB, sourceB := seedCatalogManager(t, ctx, pool, 960011, "iso-b")
	repo := catalogrepo.Repo{Pool: pool}
	const now = int64(1_700_000_000_000)

	rowA, err := repo.CreateRow(ctx, managerA, sourceA, contract.RowInput{
		Title: "A", PlatformCode: "a-1", CostCents: ptrInt64(100),
	}, now)
	if err != nil {
		t.Fatalf("create A: %v", err)
	}

	// B cannot read A's source.
	if _, err := repo.Rows(ctx, managerB, sourceA); err == nil {
		t.Fatalf("manager B listed source A; the manager arm is source-wide")
	}
	if _, err := repo.Row(ctx, managerB, sourceA, rowA.ProductID); err == nil {
		t.Fatalf("manager B read a row of source A")
	}

	// B cannot write into A's source.
	if _, err := repo.CreateRow(ctx, managerB, sourceA, contract.RowInput{
		Title: "stolen", PlatformCode: "b-9", CostCents: ptrInt64(100),
	}, now); err == nil {
		t.Fatalf("manager B created a row in source A")
	}
	if _, err := repo.UpdateRow(ctx, managerB, sourceA, rowA.ProductID, contract.RowInput{
		Title: "hijacked", PlatformCode: "a-1", ExpectedRevision: ptrInt64(rowA.Revision),
	}, now); err == nil {
		t.Fatalf("manager B updated a row of source A")
	}
	if err := repo.DeleteRow(ctx, managerB, sourceA, rowA.ProductID, now); err == nil {
		t.Fatalf("manager B archived a row of source A")
	}

	// Control: A still sees its own row, untouched.
	rows, err := repo.Rows(ctx, managerA, sourceA)
	if err != nil {
		t.Fatalf("manager A list: %v", err)
	}
	if len(rows.Rows) != 1 || rows.Rows[0].Title != "A" {
		t.Fatalf("manager A sees %+v, want its own untouched row", rows.Rows)
	}

	// And B's own source is empty, so the refusals above were not an accident
	// of B having no source at all.
	rowsB, err := repo.Rows(ctx, managerB, sourceB)
	if err != nil {
		t.Fatalf("manager B list own source: %v", err)
	}
	if len(rowsB.Rows) != 0 {
		t.Fatalf("manager B's own source has %d rows, want 0", len(rowsB.Rows))
	}
}

// TestSupplierCatalogCostIsWriteOnly pins doc 8.3: the manager may WRITE the
// supply cost but must never read it back. The wire type has no field for it,
// so this test asserts the cheaper, stronger property: the value really lands
// in the column (a superuser read proves the write worked) while the row the
// manager gets back carries no cost at all.
func TestSupplierCatalogCostIsWriteOnly(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)

	manager, source := seedCatalogManager(t, ctx, pool, 960020, "cost")
	repo := catalogrepo.Repo{Pool: pool}
	const now = int64(1_700_000_000_000)

	row, err := repo.CreateRow(ctx, manager, source, contract.RowInput{
		Title: "C", PlatformCode: "c-1",
		CostCents: ptrInt64(1234), ShippingCents: ptrInt64(56),
	}, now)
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	var cost, ship int64
	if err := pool.QueryRow(ctx, `SELECT cost_cents, shipping_cost_cents FROM sc_source_offers WHERE sku_id = $1`, row.SKUID).Scan(&cost, &ship); err != nil {
		t.Fatalf("the manager's cost did not reach the column: %v", err)
	}
	if cost != 1234 || ship != 56 {
		t.Fatalf("stored cost=%d shipping=%d, want 1234/56", cost, ship)
	}

	// The response shape has no cost fields. Marshalling and scanning the JSON
	// for the names is the assertion a struct-shape check cannot make: it
	// catches a field that was added with a json tag.
	blob, err := json.Marshal(row)
	if err != nil {
		t.Fatalf("marshal row: %v", err)
	}
	for _, banned := range []string{"costCents", "shippingCostCents", "cost_cents", "shipping_cost_cents"} {
		if strings.Contains(string(blob), banned) {
			t.Fatalf("the manager row response contains %q; doc 8.3 makes the cost write-only: %s", banned, blob)
		}
	}
}

// TestSupplierCatalogCampaignRequiresCost pins the create-time cost gate: a
// row without an offer would render as CNY 0.00 in the seller portal, because
// sellerRowSQL LEFT JOINs sc_source_offers.
func TestSupplierCatalogCreateRequiresCost(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)

	manager, source := seedCatalogManager(t, ctx, pool, 960030, "nocost")
	repo := catalogrepo.Repo{Pool: pool}

	if _, err := repo.CreateRow(ctx, manager, source, contract.RowInput{
		Title: "No cost", PlatformCode: "nc-1",
	}, int64(1_700_000_000_000)); err == nil {
		t.Fatalf("a row was created without a supply cost; the seller would see CNY 0.00")
	}
}

func ptrInt64(v int64) *int64 { return &v }

// seedCatalogManager creates one platform account that actively manages one
// fresh source, and returns both.
func seedCatalogManager(t *testing.T, ctx context.Context, pool *pgxpool.Pool, userID int64, tag string) (int64, string) {
	t.Helper()
	source := "src_sccat_" + tag
	email := "sccat-" + tag + "@test.example"
	if _, err := pool.Exec(ctx, `INSERT INTO account_users (id, public_id, email, password_hash, role, name, target, supplier_id, plan, account_kind, created_at, updated_at)
		VALUES ($1, $2, $2, 'x', 'user', 'M', '/workspace', '', 'free', 'platform', clock_timestamp(), clock_timestamp())`, userID, email); err != nil {
		t.Fatalf("insert manager %s: %v", tag, err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO sc_sources (source_id, name, created_at_ms, updated_at_ms) VALUES ($1, $1, 1, 1)`, source); err != nil {
		t.Fatalf("insert source %s: %v", tag, err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO sc_catalog_managers (source_id, user_id, status, created_by, created_at_ms) VALUES ($1, $2, 'active', $2, 1)`, source, userID); err != nil {
		t.Fatalf("insert manager grant %s: %v", tag, err)
	}
	return userID, source
}

// TestSupplierCatalogRLSScopesRowsBySource is the raw-policy test that the repo
// tests cannot be: it talks to the tables directly inside a db.CatalogManager
// transaction, so no Go-side guard can hide a broken policy arm.
//
// This exists because an earlier draft of the isolation test passed even after
// the manager arms in 00365 were widened to "any active manager": the repo's
// own requireManaged check answered first. A test that a policy mutation cannot
// fail is not testing the policy.
func TestSupplierCatalogRLSScopesRowsBySource(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)

	managerA, sourceA := seedCatalogManager(t, ctx, pool, 960040, "rls-a")
	_, sourceB := seedCatalogManager(t, ctx, pool, 960041, "rls-b")

	if _, err := pool.Exec(ctx, `INSERT INTO sc_products (product_id, source_id, title, created_at_ms, updated_at_ms, created_by_account_uuid)
		VALUES ('prod_rls_a', $1, 'A', 1, 1, 'x'), ('prod_rls_b', $2, 'B', 1, 1, 'x')`, sourceA, sourceB); err != nil {
		t.Fatalf("seed products: %v", err)
	}
	for _, s := range []struct{ sku, product string }{
		{"sku_rls_a", "prod_rls_a"}, {"sku_rls_b", "prod_rls_b"},
	} {
		if _, err := pool.Exec(ctx, `INSERT INTO sc_skus (sku_id, product_id, platform_code, title, created_at_ms, updated_at_ms, created_by_account_uuid)
			VALUES ($1, $2, $1, 'S', 1, 1, 'x')`, s.sku, s.product); err != nil {
			t.Fatalf("seed sku %s: %v", s.sku, err)
		}
	}

	// Read: the manager must see exactly the products and skus of its own
	// source. sc_sources is deliberately NOT counted here: 00365 makes every
	// listed source readable by any app session, and the migration seeds
	// src_unassigned, so a bare count would be 1 + however many rows the
	// fixture set made visible. The source arm is checked by id below instead.
	var seenProducts, seenSkus int
	var seesB bool
	if err := db.InTx(ctx, pool, db.CatalogManager(managerA), func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM sc_products`).Scan(&seenProducts); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM sc_skus`).Scan(&seenSkus); err != nil {
			return err
		}
		return tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM sc_sources WHERE source_id = $1)`, sourceB).Scan(&seesB)
	}); err != nil {
		t.Fatalf("read as manager A: %v", err)
	}
	if seenProducts != 1 || seenSkus != 1 {
		t.Fatalf("manager A sees products=%d skus=%d, want 1/1 (its own source only)",
			seenProducts, seenSkus)
	}
	if seesB {
		t.Fatalf("manager A can see source B; the manager arm on sc_sources is not source-scoped")
	}

	// Write: an UPDATE aimed straight at the other source must affect 0 rows,
	// because the USING arm filters the target before the write happens.
	var touched int64
	if err := db.InTx(ctx, pool, db.CatalogManager(managerA), func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `UPDATE sc_products SET title = 'hijacked' WHERE product_id = 'prod_rls_b'`)
		if err != nil {
			return err
		}
		touched = tag.RowsAffected()
		return nil
	}); err != nil {
		t.Fatalf("update as manager A: %v", err)
	}
	if touched != 0 {
		t.Fatalf("manager A updated %d rows of source B through RLS", touched)
	}

	// Write: an INSERT carrying the other source_id must be refused outright.
	if err := db.InTx(ctx, pool, db.CatalogManager(managerA), func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `INSERT INTO sc_products (product_id, source_id, title, created_at_ms, updated_at_ms, created_by_account_uuid)
			VALUES ('prod_rls_evil', $1, 'evil', 1, 1, 'x')`, sourceB)
		return err
	}); err == nil {
		t.Fatalf("manager A inserted a product into source B; the WITH CHECK arm is missing")
	}

	// Control: the same transaction CAN insert into its own source, so the
	// refusal above was the policy and not a broken session.
	if err := db.InTx(ctx, pool, db.CatalogManager(managerA), func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `INSERT INTO sc_products (product_id, source_id, title, created_at_ms, updated_at_ms, created_by_account_uuid)
			VALUES ('prod_rls_own', $1, 'own', 1, 1, 'x')`, sourceA)
		return err
	}); err != nil {
		t.Fatalf("manager A cannot insert into its own source: %v", err)
	}
}
