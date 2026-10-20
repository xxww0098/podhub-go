-- +goose Up
-- declaration 281 StoreProductVariantFacts m20261014_000054_store_product_variant_facts
-- source: migration/src/store_product_variant_facts.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.store_products
    ADD COLUMN IF NOT EXISTS model_id bigint,
    ADD COLUMN IF NOT EXISTS model_count bigint,
    ADD COLUMN IF NOT EXISTS description_category_id bigint,
    ADD COLUMN IF NOT EXISTS type_id bigint,
    ADD COLUMN IF NOT EXISTS variant_attributes jsonb,
    ADD COLUMN IF NOT EXISTS variant_observed_at_ms bigint,
    ADD COLUMN IF NOT EXISTS variant_observed_revision bigint,
    ADD COLUMN IF NOT EXISTS variant_source text;

-- Normalization happens at the write boundary: a Seller payload that omits a
-- field, or reports Ozon's own zero placeholder, is stored as NULL (unknown).
-- The CHECK is the durable half of that rule — a persisted 0 would read as a
-- fact ("model 0", "category 0") and is rejected here.
ALTER TABLE public.store_products
    ADD CONSTRAINT store_products_group_facts_positive CHECK (
        (model_id IS NULL OR model_id > 0)
        AND (model_count IS NULL OR model_count > 0)
        AND (description_category_id IS NULL OR description_category_id > 0)
        AND (type_id IS NULL OR type_id > 0)),
    ADD CONSTRAINT store_products_variant_observation_complete CHECK (
        (variant_observed_at_ms IS NULL) = (variant_source IS NULL)
        AND (variant_source IS NULL OR variant_source IN ('attributes'))),
    ADD CONSTRAINT store_products_variant_attributes_array CHECK (
        variant_attributes IS NULL OR jsonb_typeof(variant_attributes) = 'array');

-- "Every member of model X in this store" is the one new lookup; it must not
-- degrade into a scan of the store's catalog. Partial: an ungrouped row has
-- nothing to find and stays out of the index.
CREATE INDEX IF NOT EXISTS store_products_model_idx
    ON public.store_products (store_pk, model_id)
    WHERE model_id IS NOT NULL;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
