-- +goose Up
-- declaration 102 AiPriceQwenFlashRetail m20260904_000262_ai_price_qwen_flash_retail
-- source: migration/src/ai_price_qwen_flash_retail.rs @ a03d735
-- +goose StatementBegin
INSERT INTO public.ai_price_schedules
    (model, billing_mode,
     input_microfen_per_million, cached_input_microfen_per_million,
     output_microfen_per_million, reasoning_microfen_per_million,
     per_request_microfen, max_request_microfen,
     effective_from, created_by_user_id)
VALUES
    ('qwen3.7-flash', 'token',
     40000000, 20000000,
     160000000, 160000000,
     0, 50000000,
     clock_timestamp(), NULL)
ON CONFLICT (model) DO UPDATE SET
    billing_mode = EXCLUDED.billing_mode,
    input_microfen_per_million = EXCLUDED.input_microfen_per_million,
    cached_input_microfen_per_million = EXCLUDED.cached_input_microfen_per_million,
    output_microfen_per_million = EXCLUDED.output_microfen_per_million,
    reasoning_microfen_per_million = EXCLUDED.reasoning_microfen_per_million,
    per_request_microfen = EXCLUDED.per_request_microfen,
    max_request_microfen = EXCLUDED.max_request_microfen,
    effective_from = clock_timestamp(),
    created_by_user_id = NULL;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
