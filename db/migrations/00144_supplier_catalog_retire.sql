-- +goose Up
-- declaration 144 SupplierCatalogRetire m20260911_000002_supplier_catalog_retire
-- source: migration/src/supplier_dbs_retire.rs @ a03d735
-- +goose StatementBegin
DROP TABLE IF EXISTS public.supplier_skus;
DROP TABLE IF EXISTS public.supplier_channels;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
