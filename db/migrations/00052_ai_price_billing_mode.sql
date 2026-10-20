-- +goose Up
-- declaration 52 AiPriceBillingMode m20260820_000215_ai_price_billing_mode
-- source: migration/src/ai_price_billing_mode.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.ai_price_schedules
    ADD COLUMN billing_mode text NOT NULL DEFAULT 'token',
    ADD COLUMN per_request_microfen bigint NOT NULL DEFAULT 0,
    ADD CONSTRAINT ai_price_schedules_billing_mode_shape CHECK (
        (billing_mode = 'token' AND per_request_microfen = 0)
        OR (billing_mode = 'per_request' AND per_request_microfen > 0)
    );

ALTER TABLE public.ai_requests
    ADD COLUMN billing_mode text NOT NULL DEFAULT 'token',
    ADD COLUMN per_request_microfen bigint NOT NULL DEFAULT 0,
    DROP CONSTRAINT ai_requests_total_is_sum,
    ADD CONSTRAINT ai_requests_total_is_sum CHECK (
        (billing_mode = 'token'
            AND total_microfen = uncached_input_microfen + cached_input_microfen
                               + output_microfen + reasoning_microfen)
        OR (billing_mode = 'per_request'
            AND uncached_input_microfen = 0 AND cached_input_microfen = 0
            AND output_microfen = 0 AND reasoning_microfen = 0
            AND (total_microfen = 0 OR total_microfen = per_request_microfen))
    );
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
