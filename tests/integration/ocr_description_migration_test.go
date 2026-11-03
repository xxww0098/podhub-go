package integration

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	dbschema "github.com/xxww0098/podhub-go/db"
	ai "github.com/xxww0098/podhub-go/internal/ai/contract"
)

func TestOCRDescriptionMigrationKeepsFactsAndOtherConfiguration(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	cases := []struct {
		input   string
		changed bool
	}{
		{`{"product_type_ru":"Кружка","facts_ru":"330 мл","description_ru":"Керамическая кружка."}`, true},
		{`{"product_type_ru":"Кружка","facts_ru":"330 мл","description_ru":""}`, true},
		{`{"product_type_ru":"Кружка","facts_ru":"330 мл"}`, false},
		{`Товар: Кружка`, false},
		{`["description_ru"]`, false},
	}
	for i, tc := range cases {
		id := fmt.Sprintf("ocr-description-%d", i)
		if _, err = tx.Exec(ctx, `INSERT INTO sc_products(product_id,title,prompt_content,created_at_ms,updated_at_ms,created_by_account_uuid) VALUES($1,$1,$2,1,1,'migration-test')`, id, tc.input); err != nil {
			t.Fatal(err)
		}
		if _, err = tx.Exec(ctx, `INSERT INTO supplier_ozon_configs(product_id,description_category_id,type_id,prompt_text,fixed_tags,revision,created_at_ms,updated_at_ms,created_by_account_uuid,updated_by_account_uuid) VALUES($1,11,101,$2,'["#кружка"]',7,1,1,'migration-test','migration-test')`, id, tc.input); err != nil {
			t.Fatal(err)
		}
		if _, err = tx.Exec(ctx, `INSERT INTO category_prompts(prompt_id,description_category_id,type_id,name,file_name,content,created_at_ms,updated_at_ms,created_by_account_uuid) VALUES($1,11,101,$1,'facts.json',$2,1,1,'migration-test')`, id, tc.input); err != nil {
			t.Fatal(err)
		}
	}
	migration, err := dbschema.Migrations.ReadFile("migrations/00035_remove_ocr_description.sql")
	if err != nil {
		t.Fatal(err)
	}
	up, _, _ := strings.Cut(string(migration), "-- +goose Down")
	// A second run must leave revisions and untouched legacy text unchanged.
	for range 2 {
		if _, err = tx.Exec(ctx, up); err != nil {
			t.Fatal(err)
		}
	}
	for i, tc := range cases {
		id := fmt.Sprintf("ocr-description-%d", i)
		var supplier, category, product, tags string
		var revision, productRevision int64
		if err = tx.QueryRow(ctx, `SELECT c.prompt_text,p.content,s.prompt_content,c.fixed_tags::text,c.revision,s.revision FROM supplier_ozon_configs c JOIN sc_products s USING(product_id) JOIN category_prompts p ON p.prompt_id=c.product_id WHERE c.product_id=$1`, id).Scan(&supplier, &category, &product, &tags, &revision, &productRevision); err != nil {
			t.Fatal(err)
		}
		wantRevision, wantProductRevision := int64(7), int64(1)
		if tc.changed {
			wantRevision++
			wantProductRevision++
		}
		if revision != wantRevision || productRevision != wantProductRevision || tags != `["#кружка"]` {
			t.Fatalf("sibling config changed: revisions %d/%d, tags %s", revision, productRevision, tags)
		}
		for _, raw := range []string{supplier, category, product} {
			if !tc.changed {
				if raw != tc.input {
					t.Fatalf("untouched facts changed: %q", raw)
				}
				continue
			}
			profile, err := ai.ParseProductProfile(raw)
			if err != nil || profile.TitleBase() != "Кружка 330 мл" {
				t.Fatalf("facts lost: %q, %v", raw, err)
			}
		}
	}
}
