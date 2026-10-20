-- +goose Up
-- declaration 137 StoreProductQuota m20260911_000285_store_product_quota
-- source: migration/src/store_product_quota.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.organization_stores
    ADD COLUMN IF NOT EXISTS product_quota jsonb;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
