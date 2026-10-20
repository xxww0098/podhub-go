-- +goose Up
-- declaration 229 DropProductPush m20260926_000411_drop_product_push
-- source: migration/src/drop_product_push.rs @ a03d735
-- +goose StatementBegin
DROP TABLE public.store_product_dirty;
DROP TABLE public.store_push_tokens;

ALTER TABLE public.store_product_sync
    DROP CONSTRAINT store_product_sync_calls_purpose_shape,
    DROP CONSTRAINT store_product_sync_calls_nonneg,
    DROP COLUMN calls_refresh,
    DROP COLUMN push_last_ping_at_ms,
    DROP COLUMN push_last_event_at_ms,
    DROP COLUMN push_enabled,
    ADD CONSTRAINT store_product_sync_calls_purpose_shape CHECK (
        (calls_day IS NULL) = (calls_reconcile = 0 AND calls_manual = 0)
    ),
    ADD CONSTRAINT store_product_sync_calls_nonneg CHECK (
        calls_reconcile >= 0 AND calls_manual >= 0
    );
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
