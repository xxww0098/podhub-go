package integration

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	dbschema "github.com/xxww0098/podhub-go/db"
)

func TestSupplierComplexMigrationPreservesLegacyValuesAndRevokesOldValidation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	const product = "scp_complex_migration"
	if _, err = tx.Exec(ctx, `INSERT INTO sc_products(product_id,title,created_at_ms,updated_at_ms,created_by_account_uuid) VALUES($1,'Legacy config',1,1,'migration-test')`, product); err != nil {
		t.Fatal(err)
	}
	values := `{"fixed:width":[{"kind":"integer","value":10}],"attribute:8790:8788":[{"kind":"text","value":"https://example.com/manual.pdf"}],"attribute:8789:8788":[{"kind":"text","value":"Manual"}],"attribute:21841:100001":[{"kind":"text","value":"https://example.com/video.mp4"}]}`
	if _, err = tx.Exec(ctx, `INSERT INTO supplier_ozon_configs(product_id,description_category_id,type_id,values,revision,state,validated_catalog_digest,created_at_ms,updated_at_ms,created_by_account_uuid,updated_by_account_uuid,prompt_text,fixed_tags) VALUES($1,1,2,$2,7,'valid','sha256:'||repeat('0',64),1,1,'migration-test','migration-test','Retained facts','["#tag"]')`, product, values); err != nil {
		t.Fatal(err)
	}
	// Recreate the pre-migration shape inside a rollback-only transaction.
	if _, err = tx.Exec(ctx, `ALTER TABLE supplier_ozon_configs DROP COLUMN complex_values`); err != nil {
		t.Fatal(err)
	}
	migration, err := dbschema.Migrations.ReadFile("migrations/00017_supplier_complex_values.sql")
	if err != nil {
		t.Fatal(err)
	}
	up, _, _ := strings.Cut(string(migration), "-- +goose Down")
	if _, err = tx.Exec(ctx, up); err != nil {
		t.Fatal(err)
	}
	var plain, complex, tags []byte
	var state, prompt string
	var digest *string
	var revision int64
	if err = tx.QueryRow(ctx, `SELECT values,complex_values,fixed_tags,prompt_text,state,validated_catalog_digest,revision FROM supplier_ozon_configs WHERE product_id=$1`, product).Scan(&plain, &complex, &tags, &prompt, &state, &digest, &revision); err != nil {
		t.Fatal(err)
	}
	var groups []struct {
		ID    int64 `json:"complex_id"`
		Items []struct {
			ID     string                     `json:"item_id"`
			Values map[string]json.RawMessage `json:"values"`
		} `json:"items"`
	}
	if err = json.Unmarshal(complex, &groups); err != nil {
		t.Fatal(err)
	}
	recovered := map[string]json.RawMessage{}
	if err = json.Unmarshal(plain, &recovered); err != nil {
		t.Fatal(err)
	}
	if len(recovered) != 1 || len(groups) != 2 || groups[0].ID != 8788 || groups[1].ID != 100001 {
		t.Fatalf("wrong grouping: %s %s", plain, complex)
	}
	for _, group := range groups {
		if len(group.Items) != 1 {
			t.Fatal("legacy group was split")
		}
		if _, err = uuid.Parse(group.Items[0].ID); err != nil {
			t.Fatal("missing stable item ID", err)
		}
		for key, value := range group.Items[0].Values {
			recovered[key] = value
		}
	}
	var before, after any
	_ = json.Unmarshal([]byte(values), &before)
	raw, _ := json.Marshal(recovered)
	_ = json.Unmarshal(raw, &after)
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("migration lost values: %s", raw)
	}
	if state != "needs_reconfiguration" || digest != nil || revision != 8 || prompt != "Retained facts" || string(tags) != `["#tag"]` {
		t.Fatalf("validation stamp or sibling config lost: state=%s revision=%d prompt=%s tags=%s", state, revision, prompt, tags)
	}
}
