-- +goose Up
-- declaration 34 CatalogTreeCache m20260815_000100_catalog_tree_cache
-- source: migration/src/catalog_tree_cache.rs @ a03d735
-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS public.catalog_tree_cache (
    language text PRIMARY KEY,
    payload bytea NOT NULL,
    fetched_at_ms bigint NOT NULL,
    byte_size bigint NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
