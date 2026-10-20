-- +goose Up
-- declaration 249 RetireSellerStoresFamily m20260930_000432_retire_seller_stores_family
-- source: migration/src/retire_seller_stores_family.rs @ a03d735
-- +goose StatementBegin
DROP TABLE public.seller_store_api_keys, public.seller_store_category_warehouses, public.seller_store_warehouses, public.seller_stores;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
