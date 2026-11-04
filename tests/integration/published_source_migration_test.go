package integration

import (
	"context"
	"strings"
	"testing"
	"time"

	dbschema "github.com/xxww0098/podhub-go/db"
)

func TestPublishedSourceMigrationOnlyExposesPublishedProducts(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())

	cases := []struct {
		name                   string
		product, sku, archived bool
		want                   bool
	}{
		{"published", true, true, false, true},
		{"draft", false, true, false, false},
		{"unpublished_sku", true, false, false, false},
		{"archived", true, true, true, false},
	}
	for _, tc := range cases {
		source, product, sku := "src_migration_"+tc.name, "prod_migration_"+tc.name, "sku_migration_"+tc.name
		if _, err := tx.Exec(ctx, `INSERT INTO sc_sources(source_id,name,listed,created_at_ms,updated_at_ms) VALUES($1,$1,false,1,1)`, source); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO sc_products(product_id,source_id,title,published,archived,created_at_ms,updated_at_ms,created_by_account_uuid) VALUES($1,$2,$1,$3,$4,1,1,'test')`, product, source, tc.product, tc.archived); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO sc_skus(sku_id,product_id,platform_code,title,published,created_at_ms,updated_at_ms,created_by_account_uuid) VALUES($1,$2,$1,$1,$3,1,1,'test')`, sku, product, tc.sku); err != nil {
			t.Fatal(err)
		}
	}
	migration, err := dbschema.Migrations.ReadFile("migrations/00043_publish_sources_with_products.sql")
	if err != nil {
		t.Fatal(err)
	}
	up, _, _ := strings.Cut(string(migration), "-- +goose Down")
	for attempt := 0; attempt < 2; attempt++ {
		if _, err := tx.Exec(ctx, up); err != nil {
			t.Fatal(err)
		}
		for _, tc := range cases {
			var listed bool
			var revision int
			if err := tx.QueryRow(ctx, `SELECT listed, revision FROM sc_sources WHERE source_id=$1`, "src_migration_"+tc.name).Scan(&listed, &revision); err != nil {
				t.Fatal(err)
			}
			wantRevision := 1
			if tc.want {
				wantRevision = 2
			}
			if listed != tc.want || revision != wantRevision {
				t.Fatalf("%s: listed=%v revision=%d", tc.name, listed, revision)
			}
		}
	}
}
