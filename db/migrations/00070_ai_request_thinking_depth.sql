-- +goose Up
-- declaration 70 AiRequestThinkingDepth m20260823_000232_ai_request_thinking_depth
-- source: migration/src/ai_request_thinking_depth.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.ai_requests
    ADD COLUMN IF NOT EXISTS thinking_depth character varying(16);

ALTER TABLE public.ai_requests
    DROP CONSTRAINT IF EXISTS ai_requests_thinking_depth_known;

ALTER TABLE public.ai_requests
    ADD CONSTRAINT ai_requests_thinking_depth_known
    CHECK (thinking_depth IS NULL OR thinking_depth IN ('low', 'medium', 'high'));
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
