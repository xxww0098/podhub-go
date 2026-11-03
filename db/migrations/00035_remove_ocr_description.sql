-- +goose Up
-- +goose StatementBegin
CREATE FUNCTION pg_temp.remove_ocr_description(raw text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    facts jsonb;
BEGIN
    BEGIN
        facts := raw::jsonb;
    EXCEPTION WHEN invalid_text_representation THEN
        RETURN raw;
    END;
    IF jsonb_typeof(facts) = 'object' AND facts ? 'description_ru' THEN
        RETURN (facts - 'description_ru')::text;
    END IF;
    RETURN raw;
END;
$$;
-- +goose StatementEnd

UPDATE public.supplier_ozon_configs
SET prompt_text = pg_temp.remove_ocr_description(prompt_text),
    revision = revision + 1,
    updated_at_ms = (extract(epoch FROM clock_timestamp()) * 1000)::bigint
WHERE prompt_text IS DISTINCT FROM pg_temp.remove_ocr_description(prompt_text);

UPDATE public.category_prompts
SET content = pg_temp.remove_ocr_description(content),
    updated_at_ms = (extract(epoch FROM clock_timestamp()) * 1000)::bigint
WHERE content IS DISTINCT FROM pg_temp.remove_ocr_description(content);

UPDATE public.sc_products
SET prompt_content = pg_temp.remove_ocr_description(prompt_content),
    revision = revision + 1,
    updated_at_ms = (extract(epoch FROM clock_timestamp()) * 1000)::bigint
WHERE prompt_content IS DISTINCT FROM pg_temp.remove_ocr_description(prompt_content);

DROP FUNCTION pg_temp.remove_ocr_description(text);

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
    RAISE EXCEPTION 'Removed OCR descriptions cannot be reconstructed; restore the pre-migration backup';
END $$;
-- +goose StatementEnd
