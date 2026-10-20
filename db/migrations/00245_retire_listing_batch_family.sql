-- +goose Up
-- declaration 245 RetireListingBatchFamily m20260930_000428_retire_listing_batch_family
-- source: migration/src/retire_listing_batch_family.rs @ a03d735
-- +goose StatementBegin
DROP TABLE public.listing_batch_rows, public.listing_multi_store_upload_plans, public.listing_import_jobs, public.listing_batches;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
