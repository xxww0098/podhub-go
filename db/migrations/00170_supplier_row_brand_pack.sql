-- +goose Up
-- declaration 170 SupplierRowBrandPack m20260915_000001_supplier_row_brand_pack
-- source: migration/src/supplier_row_brand_pack.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.sc_products
    ADD COLUMN IF NOT EXISTS brand text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS pack_width_mm bigint,
    ADD COLUMN IF NOT EXISTS pack_height_mm bigint,
    ADD COLUMN IF NOT EXISTS pack_depth_mm bigint,
    ADD COLUMN IF NOT EXISTS pack_weight_g bigint;

ALTER TABLE public.sc_products
    DROP CONSTRAINT IF EXISTS ck_sc_products_pack_width;
ALTER TABLE public.sc_products
    DROP CONSTRAINT IF EXISTS ck_sc_products_pack_height;
ALTER TABLE public.sc_products
    DROP CONSTRAINT IF EXISTS ck_sc_products_pack_depth;
ALTER TABLE public.sc_products
    DROP CONSTRAINT IF EXISTS ck_sc_products_pack_weight;
ALTER TABLE public.sc_products
    ADD CONSTRAINT ck_sc_products_pack_width
        CHECK (pack_width_mm IS NULL OR pack_width_mm > 0) NOT VALID,
    ADD CONSTRAINT ck_sc_products_pack_height
        CHECK (pack_height_mm IS NULL OR pack_height_mm > 0) NOT VALID,
    ADD CONSTRAINT ck_sc_products_pack_depth
        CHECK (pack_depth_mm IS NULL OR pack_depth_mm > 0) NOT VALID,
    ADD CONSTRAINT ck_sc_products_pack_weight
        CHECK (pack_weight_g IS NULL OR pack_weight_g > 0) NOT VALID;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
