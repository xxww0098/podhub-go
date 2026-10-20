-- +goose Up
-- declaration 88 AiPriceCurrentRow m20260829_000247_ai_price_current_row
-- source: migration/src/ai_price_current_row.rs @ a03d735
-- +goose StatementBegin
UPDATE public.ai_requests r
SET price_schedule_id = keep.id
FROM public.ai_price_schedules src, (
    SELECT DISTINCT ON (model) id, model
    FROM public.ai_price_schedules
    ORDER BY model, effective_from <= clock_timestamp() DESC, effective_from DESC, version DESC
) keep
WHERE src.id = r.price_schedule_id
  AND src.model = keep.model
  AND src.id <> keep.id;

DELETE FROM public.ai_price_schedules
WHERE id NOT IN (
    SELECT DISTINCT ON (model) id
    FROM public.ai_price_schedules
    ORDER BY model, effective_from <= clock_timestamp() DESC, effective_from DESC, version DESC
);

ALTER TABLE public.ai_requests
    DROP COLUMN price_version;

ALTER TABLE public.ai_price_schedules
    DROP CONSTRAINT ai_price_schedules_model_version_key,
    DROP CONSTRAINT ai_price_schedules_version_positive,
    DROP CONSTRAINT ai_price_schedules_window_ordered,
    DROP COLUMN version,
    DROP COLUMN effective_to,
    ADD CONSTRAINT ai_price_schedules_model_key UNIQUE (model);
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
