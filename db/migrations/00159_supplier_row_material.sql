-- +goose Up
-- declaration 159 SupplierRowMaterial m20260914_000303_supplier_row_material
-- source: migration/src/supplier_row_material.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.sc_products
    ADD COLUMN IF NOT EXISTS material text NOT NULL DEFAULT '';
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
