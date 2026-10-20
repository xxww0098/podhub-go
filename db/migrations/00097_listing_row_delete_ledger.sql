-- +goose Up
-- declaration 97 ListingRowDeleteLedger m20260902_000260_listing_row_delete_ledger
-- source: migration/src/listing_row_delete_ledger.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.submission_intents
    DROP CONSTRAINT IF EXISTS submission_intents_listing_row_id_fkey;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
