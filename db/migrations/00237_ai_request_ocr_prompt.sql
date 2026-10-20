-- +goose Up
-- declaration 237 AiRequestOcrPrompt m20260929_000419_ai_request_ocr_prompt
-- source: migration/src/ai_request_ocr_prompt.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.ai_requests
    ADD COLUMN IF NOT EXISTS ocr_prompt jsonb;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
