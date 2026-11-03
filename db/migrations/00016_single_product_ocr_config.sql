-- +goose Up
UPDATE public.supplier_ozon_configs c
SET prompt_text = r.brief, fixed_tags = r.fixed_tags, ai_output = r.ai_output
FROM (
    SELECT DISTINCT ON (product_id) product_id, brief, fixed_tags, ai_output
    FROM public.prompt_revisions ORDER BY product_id, revision DESC
) r
WHERE r.product_id = c.product_id;

ALTER TABLE public.supplier_ozon_configs
    DROP CONSTRAINT supplier_ozon_configs_published_revision_fk,
    DROP COLUMN published_revision;
DROP TABLE public.prompt_revisions;
DROP FUNCTION public.prompt_revisions_append_only();

-- +goose Down
SELECT 1 / 0; -- Removed OCR history cannot be reconstructed.
