-- +goose Up
-- declaration 173 SupplierRowContents m20260915_000004_supplier_row_contents
-- source: migration/src/supplier_row_contents.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.sc_products
    ADD COLUMN IF NOT EXISTS contents text NOT NULL DEFAULT '';
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
