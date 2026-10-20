-- +goose Up
-- declaration 79 ListingSaasP4 m20260826_000241_listing_saas_p4_intent_lifecycle
-- source: migration/src/listing_saas_p4.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.submission_intents
    ADD COLUMN IF NOT EXISTS reconciliation_outcome jsonb;

ALTER TABLE public.submission_intents
    DROP CONSTRAINT IF EXISTS submission_intents_state_known;

ALTER TABLE public.submission_intents
    ADD CONSTRAINT submission_intents_state_known CHECK (state IN (
        'queued', 'submitting', 'unknown', 'accepted', 'rejected', 'cancelled',
        'reconciled', 'conflict', 'operator_attested'
    ));
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
