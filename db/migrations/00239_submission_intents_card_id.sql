-- +goose Up
-- declaration 239 SubmissionIntentsCardId m20260930_000421_submission_intents_card_id
-- source: migration/src/submission_intents_card_id.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.submission_intents
    ADD COLUMN card_id uuid;

CREATE INDEX submission_intents_org_card_idx
    ON public.submission_intents (org_id, card_id)
    WHERE card_id IS NOT NULL;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
