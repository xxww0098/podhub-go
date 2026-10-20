-- +goose Up
-- declaration 72 AiRequestApiFormat m20260823_000234_ai_request_api_format
-- source: migration/src/ai_request_api_format.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.ai_requests
    ADD COLUMN IF NOT EXISTS api_format character varying(32);

ALTER TABLE public.ai_requests
    DROP CONSTRAINT IF EXISTS ai_requests_api_format_known;

ALTER TABLE public.ai_requests
    ADD CONSTRAINT ai_requests_api_format_known
    CHECK (api_format IS NULL OR api_format IN ('chat_completions', 'responses', 'anthropic_messages'));
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
