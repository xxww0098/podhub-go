-- +goose Up
ALTER TABLE public.supplier_ozon_configs
    ADD COLUMN complex_values jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD CONSTRAINT supplier_ozon_configs_complex_values_array CHECK (jsonb_typeof(complex_values) = 'array');

WITH groups AS (
    SELECT c.product_id, split_part(e.key, ':', 3)::bigint AS complex_id,
           jsonb_object_agg(e.key, e.value) AS values
    FROM public.supplier_ozon_configs c
    CROSS JOIN LATERAL jsonb_each(c.values) e
    WHERE e.key ~ '^attribute:[0-9]+:[1-9][0-9]*$'
    GROUP BY c.product_id, split_part(e.key, ':', 3)::bigint
), migrated AS (
    SELECT product_id, jsonb_agg(jsonb_build_object('complex_id', complex_id,
        'items', jsonb_build_array(jsonb_build_object('item_id', gen_random_uuid()::text, 'values', values))) ORDER BY complex_id) AS complex_values
    FROM groups GROUP BY product_id
)
UPDATE public.supplier_ozon_configs c SET complex_values=m.complex_values,
    values=(SELECT COALESCE(jsonb_object_agg(e.key,e.value), '{}'::jsonb) FROM jsonb_each(c.values) e WHERE e.key !~ '^attribute:[0-9]+:[1-9][0-9]*$')
FROM migrated m WHERE m.product_id=c.product_id;

UPDATE public.supplier_ozon_configs SET state='needs_reconfiguration', validated_catalog_digest=NULL,
    issues='[{"issue":"legacy_configuration_requires_review"}]'::jsonb, revision=revision+1;

-- +goose Down
SELECT 1 / 0; -- Repeated items cannot be flattened without losing data.
