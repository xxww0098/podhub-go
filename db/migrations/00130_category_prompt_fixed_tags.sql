-- +goose Up
-- declaration 130 CategoryPromptFixedTags m20260908_000288_category_prompt_fixed_tags
-- source: migration/src/category_prompt_fixed_tags.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.category_prompts
                 ADD COLUMN IF NOT EXISTS fixed_tags jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE public.listing_rows r SET revision = revision + 1, updated_at = clock_timestamp()
WHERE EXISTS (
    SELECT 1 FROM public.jobs j WHERE j.org_id = r.org_id AND j.aggregate_id = r.id
      AND j.aggregate_type = 'listing_row' AND j.kind = 'ai.recognize'
      AND j.input_revision = r.revision
      AND j.state IN ('queued', 'retry_wait', 'running', 'failed')
      AND j.payload->>'recognitionContractVersion' IS DISTINCT FROM 'browser-image-v1:ocr-fixed16-ai4-v1'
);
UPDATE public.jobs SET state = 'cancelled', cancel_requested_at = clock_timestamp(),
    lease_owner = NULL, lease_until = NULL, updated_at = clock_timestamp(),
    last_error_code = 'recognition_fixed_tags_required'
WHERE kind = 'ai.recognize' AND state IN ('queued', 'retry_wait', 'running')
  AND payload->>'recognitionContractVersion' IS DISTINCT FROM 'browser-image-v1:ocr-fixed16-ai4-v1';
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
