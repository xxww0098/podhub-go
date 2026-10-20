-- +goose Up
-- declaration 92 ListingRowsSubmissionCancelled m20260902_000251_listing_rows_submission_cancelled
-- source: migration/src/listing_rows_submission_cancelled.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.listing_rows
    DROP CONSTRAINT IF EXISTS listing_rows_submission_state_known;

ALTER TABLE public.listing_rows
    ADD CONSTRAINT listing_rows_submission_state_known CHECK (submission_state IN (
        'none', 'queued', 'submitting', 'unknown', 'accepted', 'rejected', 'cancelled'
    )) NOT VALID;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
