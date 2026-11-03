package integration

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	dbschema "github.com/xxww0098/podhub-go/db"
)

func TestUserPSDBackupMigrationKeepsImageStorage(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	org := insertMediaOrg(t, ctx, pool, 97610, "psd-retirement@example.invalid", "PSD retirement", uuid.NewString())
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	// Recreate only the retired state needed to test the cleanup, then roll back.
	if _, err = tx.Exec(ctx, `
		CREATE TABLE workspace_psd_templates (id uuid PRIMARY KEY);
		INSERT INTO workspace_psd_templates VALUES (gen_random_uuid());
		ALTER TABLE organizations ADD COLUMN psd_upload_enabled boolean DEFAULT false NOT NULL;
		ALTER TABLE storage_object_refs DROP CONSTRAINT storage_object_refs_owner_kind_check;
		ALTER TABLE storage_uploads DROP CONSTRAINT storage_uploads_purpose_kind_check;
		ALTER TABLE storage_object_refs ADD CONSTRAINT storage_object_refs_owner_kind_check CHECK (owner_kind IN ('psd_template','delegate_asset'));
		ALTER TABLE storage_uploads ADD CONSTRAINT storage_uploads_purpose_kind_check CHECK (purpose_kind IN ('org_template','source'));
	`); err != nil {
		t.Fatal(err)
	}
	var objectID string
	if err = tx.QueryRow(ctx, `INSERT INTO storage_objects
		(bucket,bucket_identity,object_key,dedupe_scope,owner_org_id,sha256,byte_length,content_type,extension)
		VALUES ('private',repeat('1',64),'legacy/template.psd',$1,$2,decode(repeat('a',64),'hex'),32,'application/octet-stream','psd')
		RETURNING id::text`, "org:1:template", org).Scan(&objectID); err != nil {
		t.Fatal(err)
	}
	var imageID string
	if err = tx.QueryRow(ctx, `INSERT INTO storage_objects
		(bucket,bucket_identity,object_key,dedupe_scope,owner_org_id,sha256,byte_length,content_type,extension)
		VALUES ('private',repeat('1',64),'delegate/image.png','org:1:file',$1,decode(repeat('b',64),'hex'),32,'image/png','png')
		RETURNING id::text`, org).Scan(&imageID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `
		INSERT INTO storage_object_refs(object_id,owner_kind,owner_id,owner_org_id)
		VALUES ($1::uuid,'psd_template','template',$2),($3::uuid,'delegate_asset','image',$2);
	`, objectID, org, imageID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO storage_uploads
		(actor_id,org_id,purpose_kind,purpose_id,bucket,bucket_identity,object_key,dedupe_scope,sha256,byte_length,content_type,extension,expires_at)
		VALUES (97610,$1,'org_template','template','private',repeat('1',64),'legacy/template.psd','org:1:template',decode(repeat('a',64),'hex'),32,'application/octet-stream','psd',now()+interval '1 hour'),
		       (97610,$1,'source','source','assets',repeat('2',64),'source/image.jpg','source:source',decode(repeat('b',64),'hex'),32,'image/jpeg','jpg',now()+interval '1 hour')`, org); err != nil {
		t.Fatal(err)
	}
	migration, err := dbschema.Migrations.ReadFile("migrations/00028_drop_user_psd_backups.sql")
	if err != nil {
		t.Fatal(err)
	}
	up, _, _ := strings.Cut(string(migration), "-- +goose Down")
	if _, err = tx.Exec(ctx, up); err != nil {
		t.Fatal(err)
	}
	var tableGone, flagGone bool
	var templateRefs, imageRefs, templateUploads, imageUploads, inventory int
	if err = tx.QueryRow(ctx, `SELECT
		to_regclass('public.workspace_psd_templates') IS NULL,
		NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='organizations' AND column_name='psd_upload_enabled'),
		(SELECT count(*) FROM storage_object_refs WHERE object_id=$1::uuid AND owner_kind='psd_template'),
		(SELECT count(*) FROM storage_object_refs WHERE object_id=$3::uuid AND owner_kind='delegate_asset'),
		(SELECT count(*) FROM storage_uploads WHERE org_id=$2 AND purpose_kind='org_template'),
		(SELECT count(*) FROM storage_uploads WHERE org_id=$2 AND purpose_kind='source'),
		(SELECT count(*) FROM storage_objects WHERE id IN ($1::uuid,$3::uuid))`, objectID, org, imageID).
		Scan(&tableGone, &flagGone, &templateRefs, &imageRefs, &templateUploads, &imageUploads, &inventory); err != nil {
		t.Fatal(err)
	}
	if !tableGone || !flagGone || templateRefs != 0 || templateUploads != 0 || imageRefs != 1 || imageUploads != 1 || inventory != 2 {
		t.Fatalf("table gone=%t, template refs/uploads=%d/%d, image refs/uploads=%d/%d, inventory=%d",
			tableGone, templateRefs, templateUploads, imageRefs, imageUploads, inventory)
	}
}
