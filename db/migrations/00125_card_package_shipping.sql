-- +goose Up
-- declaration 125 CardPackageShipping m20260906_000285_card_package_shipping
-- source: migration/src/card_package_shipping.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.card_packages
    ADD COLUMN IF NOT EXISTS shipping_requirement jsonb;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
