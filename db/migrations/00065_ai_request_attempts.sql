-- +goose Up
-- declaration 65 AiRequestAttempts m20260822_000228_ai_request_attempts
-- source: migration/src/ai_request_attempts.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.ai_requests
    DROP CONSTRAINT IF EXISTS ai_requests_org_idempotency_key;
DROP INDEX IF EXISTS public.ai_requests_org_idempotency_live_uidx;
CREATE UNIQUE INDEX ai_requests_org_idempotency_live_uidx
    ON public.ai_requests (org_id, idempotency_key)
    WHERE status <> 'failed';
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
