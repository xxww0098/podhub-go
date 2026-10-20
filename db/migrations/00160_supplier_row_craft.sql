-- +goose Up
-- declaration 160 SupplierRowCraft m20260914_000304_supplier_row_craft
-- source: migration/src/supplier_row_craft.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.sc_products
    ADD COLUMN IF NOT EXISTS craft text NOT NULL DEFAULT '';
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
