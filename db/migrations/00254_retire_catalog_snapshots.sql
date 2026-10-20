-- +goose Up
-- declaration 254 RetireCatalogSnapshots m20260930_000437_retire_catalog_snapshots
-- source: migration/src/retire_catalog_snapshots.rs @ a03d735
-- +goose StatementBegin
DROP TABLE public.image_snapshots, public.listing_category_snapshots;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
