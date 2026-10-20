-- +goose Up
-- declaration 147 AgwRequestMoneyOptional m20260912_000292_agw_request_money_optional
-- source: migration/src/agw_request_money_optional.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.ai_requests
    ALTER COLUMN price_schedule_id DROP NOT NULL,
    ALTER COLUMN input_microfen_per_million SET DEFAULT 0,
    ALTER COLUMN cached_input_microfen_per_million SET DEFAULT 0,
    ALTER COLUMN output_microfen_per_million SET DEFAULT 0,
    ALTER COLUMN reasoning_microfen_per_million SET DEFAULT 0,
    ALTER COLUMN held_microfen SET DEFAULT 0;

ALTER TABLE public.ai_requests
    DROP CONSTRAINT IF EXISTS ai_requests_hold_positive;

ALTER TABLE public.ai_requests
    ADD CONSTRAINT ai_requests_hold_nonneg CHECK (held_microfen >= 0) NOT VALID;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
