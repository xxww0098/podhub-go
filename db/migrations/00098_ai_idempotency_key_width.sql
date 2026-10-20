-- +goose Up
-- declaration 98 AiIdempotencyKeyWidth m20260903_000261_ai_idempotency_key_width
-- source: migration/src/ai_idempotency_key_width.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.ai_requests
    ALTER COLUMN idempotency_key TYPE character varying(512);

ALTER TABLE public.team_ai_wallet_ledger
    ALTER COLUMN idempotency_key TYPE character varying(512);
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
