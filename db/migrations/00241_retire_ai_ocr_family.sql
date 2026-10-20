-- +goose Up
-- declaration 241 RetireAiOcrFamily m20260930_000424_retire_ai_ocr_family
-- source: migration/src/retire_ai_ocr_family.rs @ a03d735
-- +goose StatementBegin
DROP TABLE public.ai_prompts, public.ocr_category_prompt_maps, public.ocr_mapping_rules;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
