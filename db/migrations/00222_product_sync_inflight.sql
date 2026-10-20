-- +goose Up
-- declaration 222 StoreProductSyncInflight m20260924_000404_product_sync_inflight
-- source: migration/src/store_product_sync_inflight.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.store_product_sync
    ADD COLUMN inflight_token uuid,
    ADD COLUMN inflight_until_ms bigint,
    ADD CONSTRAINT store_product_sync_inflight_shape CHECK (
        (inflight_token IS NULL) = (inflight_until_ms IS NULL)
    );
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
