-- +goose Up
-- declaration 200 StoreProductVerifyStamp m20260921_000337_store_product_verify_stamp
-- source: migration/src/store_product_verify_stamp.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.store_product_sync
    ADD COLUMN IF NOT EXISTS last_verify_at_ms bigint,
    ADD COLUMN IF NOT EXISTS last_verify_digest text;

-- The stamp is a pair or nothing: a timestamp without its digest (or the
-- reverse) would dedup a batch nobody can identify.
ALTER TABLE public.store_product_sync
    ADD CONSTRAINT store_product_sync_verify_shape CHECK (
        (last_verify_at_ms IS NULL) = (last_verify_digest IS NULL)
    );
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
