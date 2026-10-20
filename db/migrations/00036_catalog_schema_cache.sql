-- +goose Up
-- declaration 36 CatalogSchemaCache m20260817_000200_catalog_schema_cache
-- source: migration/src/catalog_schema_cache.rs @ a03d735
-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS public.catalog_schema_cache (
    description_category_id bigint NOT NULL,
    type_id bigint NOT NULL,
    language text NOT NULL,
    payload bytea NOT NULL,
    fetched_at_ms bigint NOT NULL,
    byte_size bigint NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (description_category_id, type_id, language)
);
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
