-- +goose Up
-- declaration 165 SupplierOzonConfigs m20260914_000308_supplier_ozon_configs
-- source: migration/src/supplier_ozon_configs.rs @ a03d735
-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS public.supplier_ozon_configs (
    product_id text PRIMARY KEY
        REFERENCES public.sc_products (product_id) ON DELETE CASCADE,
    description_category_id bigint NOT NULL,
    type_id bigint NOT NULL,
    language character varying(16) NOT NULL DEFAULT 'default',
    values jsonb NOT NULL DEFAULT '{}'::jsonb,
    fixed_tags jsonb NOT NULL DEFAULT '[]'::jsonb,
    prompt_text text NOT NULL DEFAULT '',
    ai_output jsonb NOT NULL DEFAULT '{"title":true,"description":true,"tags":true}'::jsonb,
    revision bigint NOT NULL DEFAULT 1,
    state character varying(32) NOT NULL DEFAULT 'needs_reconfiguration',
    validated_catalog_digest character varying(71),
    issues jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    created_by_account_uuid text NOT NULL,
    updated_by_account_uuid text NOT NULL,
    CONSTRAINT supplier_ozon_configs_coordinate_positive
        CHECK (description_category_id > 0 AND type_id > 0),
    CONSTRAINT supplier_ozon_configs_language_known
        CHECK (language IN ('default', 'ru', 'en', 'tr', 'zh_hans')),
    CONSTRAINT supplier_ozon_configs_values_object
        CHECK (jsonb_typeof(values) = 'object'),
    CONSTRAINT supplier_ozon_configs_fixed_tags_array
        CHECK (jsonb_typeof(fixed_tags) = 'array'),
    CONSTRAINT supplier_ozon_configs_ai_output_object
        CHECK (jsonb_typeof(ai_output) = 'object'),
    CONSTRAINT supplier_ozon_configs_revision_positive CHECK (revision > 0),
    CONSTRAINT supplier_ozon_configs_state_known
        CHECK (state IN ('valid', 'needs_reconfiguration')),
    CONSTRAINT supplier_ozon_configs_digest_shape
        CHECK (validated_catalog_digest IS NULL OR
               validated_catalog_digest ~ '^sha256:[0-9a-f]{64}$'),
    CONSTRAINT supplier_ozon_configs_issues_array
        CHECK (jsonb_typeof(issues) = 'array'),
    CONSTRAINT supplier_ozon_configs_valid_has_current_stamp
        CHECK (state <> 'valid' OR
               (validated_catalog_digest IS NOT NULL AND issues = '[]'::jsonb))
);

CREATE INDEX IF NOT EXISTS ix_supplier_ozon_configs_coordinate
    ON public.supplier_ozon_configs
       (description_category_id, type_id, language);

-- The old WorkflowCategoryDraft JSON is not the typed AdminValues contract and
-- is therefore never guessed into `values`. Coordinates, prompt and tags have
-- unambiguous meanings, but every imported row remains a repair draft until an
-- administrator saves it against the current catalogue through the new API.
INSERT INTO public.supplier_ozon_configs (
    product_id, description_category_id, type_id, language, values,
    fixed_tags, prompt_text, ai_output, revision, state,
    validated_catalog_digest, issues, created_at_ms, updated_at_ms,
    created_by_account_uuid, updated_by_account_uuid
)
SELECT product_id, description_category_id, type_id, 'default', '{}'::jsonb,
       CASE WHEN jsonb_typeof(fixed_tags) = 'array' THEN fixed_tags ELSE '[]'::jsonb END,
       prompt_content,
       '{"title":true,"description":true,"tags":true}'::jsonb,
       1, 'needs_reconfiguration', NULL,
       '[{"issue":"legacy_configuration_requires_review"}]'::jsonb,
       created_at_ms, updated_at_ms, created_by_account_uuid, created_by_account_uuid
FROM public.sc_products
WHERE description_category_id > 0 AND type_id > 0
ON CONFLICT (product_id) DO NOTHING;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
