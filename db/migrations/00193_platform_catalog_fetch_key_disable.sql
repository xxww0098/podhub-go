-- +goose Up
-- declaration 193 PlatformCatalogFetchKeyDisable m20260918_000332_platform_catalog_fetch_key_disable
-- source: migration/src/platform_catalog_fetch_key_disable.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.platform_catalog_fetch_keys
    ADD COLUMN IF NOT EXISTS disabled_at_ms bigint;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
