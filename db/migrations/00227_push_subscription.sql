-- +goose Up
-- declaration 227 StorePushSubscription m20260924_000409_push_subscription
-- source: migration/src/store_push_subscription.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.store_product_sync
    ADD COLUMN push_enabled boolean NOT NULL DEFAULT false;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
