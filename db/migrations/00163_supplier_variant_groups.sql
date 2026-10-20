-- +goose Up
-- declaration 163 SupplierVariantGroups m20260914_000001_supplier_variant_groups
-- source: migration/src/supplier_variant_groups.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.sc_products
    ADD COLUMN IF NOT EXISTS variant_group text NOT NULL DEFAULT '';

ALTER TABLE public.sc_products
    DROP CONSTRAINT IF EXISTS ck_sc_products_variant_group_size;
ALTER TABLE public.sc_products
    ADD CONSTRAINT ck_sc_products_variant_group_size
    CHECK (variant_group = '' OR btrim(size) <> '');

CREATE UNIQUE INDEX IF NOT EXISTS ux_sc_products_variant_group_size
    ON public.sc_products (source_id, variant_group, size)
    WHERE variant_group <> '' AND archived = false;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
