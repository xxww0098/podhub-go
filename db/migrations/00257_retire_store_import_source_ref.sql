-- +goose Up
-- declaration 257 RetireStoreImportSourceRef m20260930_000440_retire_store_import_source_ref
-- source: migration/src/retire_store_import_source_ref.rs @ a03d735
-- +goose StatementBegin
DROP INDEX IF EXISTS public.uq_organization_stores_live_import_source;

ALTER TABLE public.organization_stores
    DROP COLUMN IF EXISTS import_source_ref;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
