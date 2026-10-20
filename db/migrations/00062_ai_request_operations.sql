-- +goose Up
-- +goose NO TRANSACTION
-- declaration 62 AiRequestOperations m20260822_000225_ai_request_operations
-- source: migration/src/ai_request_operations.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.ai_requests
    ADD COLUMN IF NOT EXISTS operation character varying(32) NOT NULL DEFAULT 'ai_token';

ALTER TABLE public.ai_requests
    DROP CONSTRAINT IF EXISTS ai_requests_operation_known;

ALTER TABLE public.ai_requests
    ADD CONSTRAINT ai_requests_operation_known
    CHECK (operation IN ('ai_token', 'ocr'));
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX CONCURRENTLY "ix_ai_requests_ocr_month" ON "public"."ai_requests" ("org_id", "created_at") WHERE operation = 'ocr' AND status IN ('held', 'dispatching', 'settled', 'unbilled_unknown');
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
