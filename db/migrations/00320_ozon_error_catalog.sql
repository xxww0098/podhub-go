-- +goose Up
-- declaration 320 OzonErrorCatalog
-- Post-Rust append. Does not alter migrations 00001-00315.
-- Global rows have no org, offer, or credential. Org rows are counts for
-- that org only. A repeated task_id+offer does not increment again.
-- +goose StatementBegin
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'podhub_ozon_catalog') THEN
        CREATE ROLE podhub_ozon_catalog NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
    END IF;
END
$$;

GRANT podhub_ozon_catalog TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;

CREATE TABLE public.ozon_error_catalog (
    source text NOT NULL,
    code text NOT NULL,
    attribute_id bigint NOT NULL,
    description_category_id bigint NOT NULL,
    type_id bigint NOT NULL,
    level text NOT NULL DEFAULT '',
    state text NOT NULL DEFAULT '',
    field text NOT NULL DEFAULT '',
    attribute_name text NOT NULL DEFAULT '',
    sample_description text NOT NULL DEFAULT '',
    occurrences bigint NOT NULL,
    first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT ozon_error_catalog_pkey PRIMARY KEY (
        source, code, attribute_id, description_category_id, type_id
    ),
    CONSTRAINT ozon_error_catalog_source CHECK (
        source IN ('ozon_import_info', 'ozon_request', 'docs_seed')
    ),
    CONSTRAINT ozon_error_catalog_code_len CHECK (char_length(code) BETWEEN 1 AND 128),
    CONSTRAINT ozon_error_catalog_ids CHECK (
        attribute_id >= 0 AND description_category_id >= 0 AND type_id >= 0
    ),
    CONSTRAINT ozon_error_catalog_text_len CHECK (
        char_length(level) <= 32
        AND char_length(state) <= 64
        AND char_length(field) <= 128
        AND char_length(attribute_name) <= 200
        AND char_length(sample_description) <= 500
    ),
    CONSTRAINT ozon_error_catalog_clean CHECK (
        code !~* '(fixture-api-key|api[-_]?key|bearer |sk-|client[-_]?id|signature=|x-amz-)'
        AND field !~* '(fixture-api-key|api[-_]?key|bearer |sk-|client[-_]?id|signature=|x-amz-)'
        AND attribute_name !~* '(fixture-api-key|api[-_]?key|bearer |sk-|client[-_]?id|signature=|x-amz-)'
        AND level !~* '(fixture-api-key|api[-_]?key|bearer |sk-|client[-_]?id|signature=|x-amz-)'
        AND state !~* '(fixture-api-key|api[-_]?key|bearer |sk-|client[-_]?id|signature=|x-amz-)'
        AND sample_description !~* '(fixture-api-key|api[-_]?key|bearer |sk-|client[-_]?id|signature=|x-amz-)'
    ),
    CONSTRAINT ozon_error_catalog_count CHECK (occurrences >= 0),
    CONSTRAINT ozon_error_catalog_span CHECK (first_seen_at <= last_seen_at)
);

CREATE TABLE public.ozon_error_observation (
    org_id bigint NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
    source text NOT NULL,
    code text NOT NULL,
    attribute_id bigint NOT NULL,
    description_category_id bigint NOT NULL,
    type_id bigint NOT NULL,
    level text NOT NULL DEFAULT '',
    state text NOT NULL DEFAULT '',
    field text NOT NULL DEFAULT '',
    attribute_name text NOT NULL DEFAULT '',
    sample_description text NOT NULL DEFAULT '',
    occurrences bigint NOT NULL,
    first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT ozon_error_observation_pkey PRIMARY KEY (
        org_id, source, code, attribute_id, description_category_id, type_id
    ),
    CONSTRAINT ozon_error_observation_source CHECK (
        source IN ('ozon_import_info', 'ozon_request')
    ),
    CONSTRAINT ozon_error_observation_code_len CHECK (char_length(code) BETWEEN 1 AND 128),
    CONSTRAINT ozon_error_observation_ids CHECK (
        org_id > 0 AND attribute_id >= 0 AND description_category_id >= 0 AND type_id >= 0
    ),
    CONSTRAINT ozon_error_observation_text_len CHECK (
        char_length(level) <= 32
        AND char_length(state) <= 64
        AND char_length(field) <= 128
        AND char_length(attribute_name) <= 200
        AND char_length(sample_description) <= 500
    ),
    CONSTRAINT ozon_error_observation_clean CHECK (
        code !~* '(fixture-api-key|api[-_]?key|bearer |sk-|client[-_]?id|signature=|x-amz-)'
        AND field !~* '(fixture-api-key|api[-_]?key|bearer |sk-|client[-_]?id|signature=|x-amz-)'
        AND attribute_name !~* '(fixture-api-key|api[-_]?key|bearer |sk-|client[-_]?id|signature=|x-amz-)'
        AND level !~* '(fixture-api-key|api[-_]?key|bearer |sk-|client[-_]?id|signature=|x-amz-)'
        AND state !~* '(fixture-api-key|api[-_]?key|bearer |sk-|client[-_]?id|signature=|x-amz-)'
        AND sample_description !~* '(fixture-api-key|api[-_]?key|bearer |sk-|client[-_]?id|signature=|x-amz-)'
    ),
    CONSTRAINT ozon_error_observation_count CHECK (occurrences > 0),
    CONSTRAINT ozon_error_observation_span CHECK (first_seen_at <= last_seen_at)
);

CREATE TABLE public.ozon_error_sighting (
    org_id bigint NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
    task_key text NOT NULL,
    offer_key text NOT NULL,
    source text NOT NULL,
    code text NOT NULL,
    attribute_id bigint NOT NULL,
    description_category_id bigint NOT NULL,
    type_id bigint NOT NULL,
    seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT ozon_error_sighting_pkey PRIMARY KEY (
        org_id, task_key, offer_key, source, code, attribute_id, description_category_id, type_id
    ),
    CONSTRAINT ozon_error_sighting_source CHECK (
        source IN ('ozon_import_info', 'ozon_request')
    ),
    CONSTRAINT ozon_error_sighting_lens CHECK (
        org_id > 0
        AND char_length(task_key) BETWEEN 1 AND 80
        AND char_length(offer_key) <= 200
        AND char_length(code) BETWEEN 1 AND 128
        AND attribute_id >= 0
        AND description_category_id >= 0
        AND type_id >= 0
    )
);

INSERT INTO public.ozon_error_catalog (
    source, code, attribute_id, description_category_id, type_id,
    level, state, field, attribute_name, sample_description, occurrences
) VALUES
    ('docs_seed', 'SPU_already_exists', 0, 0, 0, '', '', '', '', '', 0),
    ('docs_seed', 'Invalid_state', 0, 0, 0, '', '', '', '', '', 0),
    ('docs_seed', 'Incorrect_density', 0, 0, 0, '', '', '', '', '密度 0.001–13.55', 0),
    ('docs_seed', 'item_limit_exceeded', 0, 0, 0, '', '', '', '', '', 0),
    ('docs_seed', 'product_is_not_created', 0, 0, 0, '', '', '', '', '', 0),
    ('docs_seed', 'offer_id_not_found', 0, 0, 0, '', '', '', '', '', 0),
    ('docs_seed', 'WAREHOUSE_NOT_FOUND', 0, 0, 0, '', '', '', '', '', 0),
    ('docs_seed', 'FLAMMABLE_ONLY_ON_SELF_OR_PROVIDER_DELIVERY', 0, 0, 0, '', '', '', '', '', 0)
ON CONFLICT DO NOTHING;

CREATE INDEX ozon_error_catalog_occurrences_idx
    ON public.ozon_error_catalog (occurrences DESC, source, code, attribute_id, description_category_id, type_id);
CREATE INDEX ozon_error_catalog_seen_idx
    ON public.ozon_error_catalog (last_seen_at DESC, source, code, attribute_id, description_category_id, type_id);
CREATE INDEX ozon_error_observation_org_occurrences_idx
    ON public.ozon_error_observation (org_id, occurrences DESC, source, code);

REVOKE ALL ON TABLE public.ozon_error_catalog FROM PUBLIC, podhub_app, podhub_worker;
GRANT SELECT ON TABLE public.ozon_error_catalog TO podhub_app;
GRANT SELECT, INSERT, UPDATE ON TABLE public.ozon_error_catalog TO podhub_ozon_catalog;

REVOKE ALL ON TABLE public.ozon_error_observation FROM PUBLIC, podhub_worker;
GRANT SELECT, INSERT, UPDATE ON TABLE public.ozon_error_observation TO podhub_app;

REVOKE ALL ON TABLE public.ozon_error_sighting FROM PUBLIC, podhub_worker;
GRANT SELECT, INSERT ON TABLE public.ozon_error_sighting TO podhub_app;

ALTER TABLE public.ozon_error_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ozon_error_catalog FORCE ROW LEVEL SECURITY;

CREATE POLICY ozon_error_catalog_observe ON public.ozon_error_catalog
    FOR SELECT
    TO podhub_app
    USING (
        EXISTS (
            SELECT 1 FROM public.account_users observer
            WHERE observer.id::text = current_setting('app.platform_observer_id', true)
              AND observer.role = 'super_admin'
              AND observer.disabled_at IS NULL
        )
    );

CREATE POLICY ozon_error_catalog_write ON public.ozon_error_catalog
    FOR ALL
    TO podhub_ozon_catalog
    USING (source IN ('ozon_import_info', 'ozon_request'))
    WITH CHECK (source IN ('ozon_import_info', 'ozon_request'));

ALTER TABLE public.ozon_error_observation ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ozon_error_observation FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.ozon_error_observation
    FOR ALL
    TO podhub_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint);

ALTER TABLE public.ozon_error_sighting ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ozon_error_sighting FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.ozon_error_sighting
    FOR ALL
    TO podhub_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint);
-- +goose StatementEnd

-- +goose Down
-- Destructive rollback is refused. This append follows that shape.
SELECT 1;
