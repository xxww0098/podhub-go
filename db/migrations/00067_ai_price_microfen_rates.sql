-- +goose Up
-- declaration 67 AiPriceMicrofenRates m20260821_000216_ai_price_microfen_rates
-- source: migration/src/ai_price_microfen_rates.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.ai_price_schedules
                             RENAME COLUMN input_fen_per_million TO input_microfen_per_million;

ALTER TABLE public.ai_price_schedules
                             RENAME COLUMN cached_input_fen_per_million TO cached_input_microfen_per_million;

ALTER TABLE public.ai_price_schedules
                             RENAME COLUMN output_fen_per_million TO output_microfen_per_million;

ALTER TABLE public.ai_price_schedules
                             RENAME COLUMN reasoning_fen_per_million TO reasoning_microfen_per_million;

UPDATE public.ai_price_schedules SET input_microfen_per_million = input_microfen_per_million * 1000000, cached_input_microfen_per_million = cached_input_microfen_per_million * 1000000, output_microfen_per_million = output_microfen_per_million * 1000000, reasoning_microfen_per_million = reasoning_microfen_per_million * 1000000;

ALTER TABLE public.ai_requests
                             RENAME COLUMN input_fen_per_million TO input_microfen_per_million;

ALTER TABLE public.ai_requests
                             RENAME COLUMN cached_input_fen_per_million TO cached_input_microfen_per_million;

ALTER TABLE public.ai_requests
                             RENAME COLUMN output_fen_per_million TO output_microfen_per_million;

ALTER TABLE public.ai_requests
                             RENAME COLUMN reasoning_fen_per_million TO reasoning_microfen_per_million;

UPDATE public.ai_requests SET input_microfen_per_million = input_microfen_per_million * 1000000, cached_input_microfen_per_million = cached_input_microfen_per_million * 1000000, output_microfen_per_million = output_microfen_per_million * 1000000, reasoning_microfen_per_million = reasoning_microfen_per_million * 1000000;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
