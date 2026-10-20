-- +goose Up
-- declaration 232 SupplierListingDefaultsRetire m20260927_000414_supplier_listing_defaults_retire
-- source: migration/src/supplier_listing_defaults_retire.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.sc_products DROP COLUMN IF EXISTS listing_defaults;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
