-- +goose Up
-- declaration 104 ListingPromptBindings m20260905_000264_listing_prompt_bindings
-- source: migration/src/listing_prompt_bindings.rs @ a03d735
-- +goose StatementBegin
WITH matches AS (
    SELECT c.id, min(p.prompt_id) AS prompt_id
    FROM public.listing_cards c JOIN public.category_prompts p
      ON c.payload->>'descriptionCategoryId' = p.description_category_id::text
     AND c.payload->>'typeId' = p.type_id::text
     AND c.payload->>'aiPrompt' = p.content
    WHERE COALESCE(c.payload->>'aiPromptId', '') = ''
      AND COALESCE(c.payload->>'aiPrompt', '') <> ''
    GROUP BY c.id HAVING count(*) = 1
)
UPDATE public.listing_cards c
SET payload = jsonb_set(c.payload, '{aiPromptId}', to_jsonb(m.prompt_id)),
    revision = revision + 1, updated_at = clock_timestamp()
FROM matches m WHERE c.id = m.id;

WITH matches AS (
    SELECT c.id, min(p.prompt_id) AS prompt_id
    FROM public.card_packages c JOIN public.category_prompts p
      ON c.payload->>'descriptionCategoryId' = p.description_category_id::text
     AND c.payload->>'typeId' = p.type_id::text
     AND c.payload->>'aiPrompt' = p.content
    WHERE COALESCE(c.payload->>'aiPromptId', '') = ''
      AND COALESCE(c.payload->>'aiPrompt', '') <> ''
    GROUP BY c.id HAVING count(*) = 1
)
UPDATE public.card_packages c
SET payload = jsonb_set(c.payload, '{aiPromptId}', to_jsonb(m.prompt_id)),
    updated_at_ms = (extract(epoch from clock_timestamp()) * 1000)::bigint, updated_at = clock_timestamp()
FROM matches m WHERE c.id = m.id;

UPDATE public.listing_rows r SET revision = revision + 1, updated_at = clock_timestamp()
WHERE EXISTS (
    SELECT 1 FROM public.jobs j WHERE j.org_id = r.org_id AND j.aggregate_id = r.id
      AND j.aggregate_type = 'listing_row' AND j.kind = 'ai.recognize'
      AND j.input_revision = r.revision AND j.payload->>'executor' = 'browser'
      AND j.state IN ('queued', 'retry_wait', 'running', 'failed')
      AND NOT (j.payload ? 'recognitionPrompt')
);
UPDATE public.jobs SET state = 'cancelled', cancel_requested_at = clock_timestamp(),
    lease_owner = NULL, lease_until = NULL, updated_at = clock_timestamp(),
    last_error_code = 'recognition_prompt_snapshot_required'
WHERE kind = 'ai.recognize' AND payload->>'executor' = 'browser'
  AND state IN ('queued', 'retry_wait', 'running')
  AND NOT (payload ? 'recognitionPrompt');
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
