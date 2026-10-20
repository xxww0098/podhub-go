-- +goose Up
-- declaration 166 ListingTasks m20260914_000309_listing_tasks
-- source: migration/src/listing_tasks.rs @ a03d735
-- +goose StatementBegin
CREATE TABLE public.listing_tasks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id bigint NOT NULL REFERENCES public.organizations(id),
    store_id uuid REFERENCES public.organization_stores(uuid),
    supplier_product_id text NOT NULL REFERENCES public.sc_products(product_id),
    source_asset_id uuid NOT NULL REFERENCES public.media_lib_assets(id),
    source_identity jsonb NOT NULL,
    product_image_asset_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
    product_images jsonb NOT NULL DEFAULT '[]'::jsonb,
    user_psd_asset_id uuid REFERENCES public.media_lib_assets(id),
    user_psd jsonb,
    price_kopecks bigint,
    old_price_kopecks bigint,
    preparation jsonb NOT NULL DEFAULT
        '{"ai":"pending","render":"pending","upload":"pending","content":{"tags":[]}}'::jsonb,
    state character varying(16) NOT NULL DEFAULT 'draft',
    revision bigint NOT NULL DEFAULT 1,
    idempotency_key character varying(200) NOT NULL,
    input_digest character varying(71) NOT NULL,
    batch_index smallint NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT listing_tasks_source_identity_object
        CHECK (jsonb_typeof(source_identity) = 'object'),
    CONSTRAINT listing_tasks_product_asset_ids_array
        CHECK (jsonb_typeof(product_image_asset_ids) = 'array'),
    CONSTRAINT listing_tasks_product_images_array
        CHECK (jsonb_typeof(product_images) = 'array'),
    CONSTRAINT listing_tasks_user_psd_object
        CHECK (user_psd IS NULL OR jsonb_typeof(user_psd) = 'object'),
    CONSTRAINT listing_tasks_preparation_object
        CHECK (jsonb_typeof(preparation) = 'object'),
    CONSTRAINT listing_tasks_state_known
        CHECK (state IN ('draft', 'preparing', 'ready')),
    CONSTRAINT listing_tasks_revision_positive CHECK (revision > 0),
    CONSTRAINT listing_tasks_price_positive
        CHECK (price_kopecks IS NULL OR price_kopecks > 0),
    CONSTRAINT listing_tasks_old_price_requires_price
        CHECK (old_price_kopecks IS NULL OR
               (price_kopecks IS NOT NULL AND old_price_kopecks > price_kopecks)),
    CONSTRAINT listing_tasks_ready_complete
        CHECK (state <> 'ready' OR
               (store_id IS NOT NULL AND price_kopecks IS NOT NULL AND
                jsonb_array_length(product_images) > 0 AND
                preparation->>'ai' = 'succeeded' AND
                preparation->>'render' = 'succeeded' AND
                preparation->>'upload' = 'succeeded' AND
                COALESCE(length(btrim(preparation->'content'->>'title')), 0) > 0 AND
                COALESCE(length(btrim(preparation->'content'->>'description')), 0) > 0 AND
                COALESCE(jsonb_array_length(preparation->'content'->'tags'), 0) > 0)),
    CONSTRAINT listing_tasks_idempotency_not_blank
        CHECK (length(btrim(idempotency_key)) > 0),
    CONSTRAINT listing_tasks_input_digest_shape
        CHECK (input_digest ~ '^sha256:[0-9a-f]{64}$'),
    CONSTRAINT listing_tasks_batch_index_bound
        CHECK (batch_index >= 0 AND batch_index < 100),
    CONSTRAINT listing_tasks_create_slot_unique
        UNIQUE (org_id, idempotency_key, batch_index)
);

CREATE INDEX listing_tasks_org_updated_idx
    ON public.listing_tasks (org_id, updated_at_ms DESC, id DESC);
CREATE INDEX listing_tasks_supplier_product_idx
    ON public.listing_tasks (supplier_product_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.listing_tasks
    TO podhub_app, podhub_worker;
GRANT SELECT ON TABLE public.sc_sources, public.sc_products, public.sc_skus,
    public.supplier_ozon_configs, public.ozon_category_current,
    public.ozon_dictionary_current, public.organization_stores,
    public.organization_members
    TO podhub_app, podhub_worker;
-- PostgreSQL requires some UPDATE privilege for SELECT ... FOR SHARE. Limit it
-- to the non-business timestamp while `load_current_schema` locks the parent.
GRANT UPDATE (updated_at) ON TABLE public.ozon_category_current
    TO podhub_app, podhub_worker;

ALTER TABLE public.listing_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listing_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.listing_tasks
    FOR ALL TO podhub_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint);
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
