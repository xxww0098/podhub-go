-- +goose Up
-- declaration 179 ListingSubmissionReceipt m20260911_000285_listing_submission_receipt
-- source: migration/src/listing_submission_receipt.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.submission_intents
    ADD COLUMN submission_receipt jsonb;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
