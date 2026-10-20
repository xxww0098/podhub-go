-- +goose Up
-- +goose NO TRANSACTION
-- declaration 42 StoreLiveImportSourceUidx m20260818_000206_store_live_import_source_uidx
-- source: migration/src/store_live_import_source_uidx.rs @ a03d735
-- +goose StatementBegin
CREATE UNIQUE INDEX CONCURRENTLY "uq_organization_stores_live_import_source" ON "public"."organization_stores" ("org_id", "import_source_ref") WHERE import_source_ref IS NOT NULL AND deleted_at_ms IS NULL;
-- +goose StatementEnd
-- +goose StatementBegin
DROP INDEX CONCURRENTLY IF EXISTS "public"."uq_organization_stores_import_source";
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
