-- +goose Up
-- declaration 157 SupplierRowPackage m20260913_000301_supplier_row_package
-- source: migration/src/supplier_row_package.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.sc_products
    ADD COLUMN IF NOT EXISTS size text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS gross_weight_g bigint;

ALTER TABLE public.sc_source_offers
    ALTER COLUMN cost_cents DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS shipping_cost_cents bigint;

ALTER TABLE public.sc_products
    DROP CONSTRAINT IF EXISTS ck_sc_products_gross_weight;
ALTER TABLE public.sc_products
    ADD CONSTRAINT ck_sc_products_gross_weight
        CHECK (gross_weight_g IS NULL OR gross_weight_g > 0) NOT VALID;

ALTER TABLE public.sc_source_offers
    DROP CONSTRAINT IF EXISTS ck_sc_source_offers_cost,
    DROP CONSTRAINT IF EXISTS ck_sc_source_offers_shipping,
    DROP CONSTRAINT IF EXISTS ck_sc_source_offers_nonempty;
ALTER TABLE public.sc_source_offers
    ADD CONSTRAINT ck_sc_source_offers_cost
        CHECK (cost_cents IS NULL OR cost_cents > 0) NOT VALID,
    ADD CONSTRAINT ck_sc_source_offers_shipping
        CHECK (shipping_cost_cents IS NULL OR shipping_cost_cents > 0) NOT VALID,
    ADD CONSTRAINT ck_sc_source_offers_nonempty
        CHECK (cost_cents IS NOT NULL OR shipping_cost_cents IS NOT NULL) NOT VALID;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
