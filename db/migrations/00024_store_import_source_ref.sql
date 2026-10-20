-- +goose Up
-- +goose NO TRANSACTION
-- declaration 24 StoreImportSourceRef m20260805_000052_store_import_source_ref
-- source: migration/src/store_import_source_ref.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.organization_stores
    ADD COLUMN IF NOT EXISTS import_source_ref character varying(128);
-- +goose StatementEnd
-- +goose StatementBegin
CREATE UNIQUE INDEX CONCURRENTLY "uq_organization_stores_import_source" ON "public"."organization_stores" ("org_id", "import_source_ref") WHERE import_source_ref IS NOT NULL;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
