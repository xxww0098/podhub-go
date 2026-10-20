-- +goose Up
-- declaration 134 ListingIntentSuperseded m20260910_000282_listing_intent_superseded
-- source: migration/src/listing_intent_superseded.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.submission_intents
    DROP CONSTRAINT IF EXISTS submission_intents_state_known;

ALTER TABLE public.submission_intents
    ADD CONSTRAINT submission_intents_state_known CHECK (state IN (
        'queued', 'submitting', 'unknown', 'accepted', 'rejected', 'cancelled',
        'reconciled', 'conflict', 'operator_attested', 'superseded'
    ));
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
