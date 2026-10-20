-- +goose Up
-- declaration 78 ListingSaasP3 m20260826_000240_listing_saas_p3_rls
-- source: migration/src/listing_saas_p3.rs @ a03d735
-- +goose StatementBegin
DO $$
BEGIN

    BEGIN
        IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ozon_pod_app')
           AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'podhub_app') THEN
            ALTER ROLE ozon_pod_app RENAME TO podhub_app;
        END IF;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
        NULL;
    END;
    BEGIN
        IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'podx_app')
           AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'podhub_app') THEN
            ALTER ROLE podx_app RENAME TO podhub_app;
        END IF;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
        NULL;
    END;
    BEGIN
        CREATE ROLE podhub_app NOINHERIT;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
        NULL;
    END;

    BEGIN
        IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ozon_pod_worker')
           AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'podhub_worker') THEN
            ALTER ROLE ozon_pod_worker RENAME TO podhub_worker;
        END IF;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
        NULL;
    END;
    BEGIN
        IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'podx_worker')
           AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'podhub_worker') THEN
            ALTER ROLE podx_worker RENAME TO podhub_worker;
        END IF;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
        NULL;
    END;
    BEGIN
        CREATE ROLE podhub_worker NOINHERIT BYPASSRLS;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
        NULL;
    END;
END
$$;

-- Migrator / runtime login role must be able to assume both.
GRANT podhub_app TO CURRENT_USER;
GRANT podhub_worker TO CURRENT_USER;

GRANT USAGE ON SCHEMA public TO podhub_app, podhub_worker;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
    public.jobs,
    public.listing_rows,
    public.listing_cards,
    public.submission_intents,
    public.usage_reservations,
    public.outbox_events,
    public.media_blobs,
    public.media_lib_assets,
    public.media_variants,
    public.media_bindings,
    public.media_uploads
TO podhub_app, podhub_worker;

-- Inbox has no org_id; workers only (dedupe ledger).
GRANT SELECT, INSERT ON TABLE public.inbox_receipts TO podhub_worker;

ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.jobs;
CREATE POLICY tenant_isolation ON public.jobs
    FOR ALL
    TO podhub_app
    USING (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    )
    WITH CHECK (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    );

ALTER TABLE public.listing_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listing_rows FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.listing_rows;
CREATE POLICY tenant_isolation ON public.listing_rows
    FOR ALL
    TO podhub_app
    USING (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    )
    WITH CHECK (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    );

ALTER TABLE public.listing_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listing_cards FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.listing_cards;
CREATE POLICY tenant_isolation ON public.listing_cards
    FOR ALL
    TO podhub_app
    USING (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    )
    WITH CHECK (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    );

ALTER TABLE public.submission_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.submission_intents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.submission_intents;
CREATE POLICY tenant_isolation ON public.submission_intents
    FOR ALL
    TO podhub_app
    USING (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    )
    WITH CHECK (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    );

ALTER TABLE public.usage_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_reservations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.usage_reservations;
CREATE POLICY tenant_isolation ON public.usage_reservations
    FOR ALL
    TO podhub_app
    USING (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    )
    WITH CHECK (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    );

ALTER TABLE public.outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outbox_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.outbox_events;
CREATE POLICY tenant_isolation ON public.outbox_events
    FOR ALL
    TO podhub_app
    USING (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    )
    WITH CHECK (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    );

ALTER TABLE public.media_blobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media_blobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.media_blobs;
CREATE POLICY tenant_isolation ON public.media_blobs
    FOR ALL
    TO podhub_app
    USING (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    )
    WITH CHECK (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    );

ALTER TABLE public.media_lib_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media_lib_assets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.media_lib_assets;
CREATE POLICY tenant_isolation ON public.media_lib_assets
    FOR ALL
    TO podhub_app
    USING (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    )
    WITH CHECK (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    );

ALTER TABLE public.media_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media_variants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.media_variants;
CREATE POLICY tenant_isolation ON public.media_variants
    FOR ALL
    TO podhub_app
    USING (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    )
    WITH CHECK (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    );

ALTER TABLE public.media_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media_bindings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.media_bindings;
CREATE POLICY tenant_isolation ON public.media_bindings
    FOR ALL
    TO podhub_app
    USING (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    )
    WITH CHECK (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    );

ALTER TABLE public.media_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media_uploads FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.media_uploads;
CREATE POLICY tenant_isolation ON public.media_uploads
    FOR ALL
    TO podhub_app
    USING (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    )
    WITH CHECK (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    );
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
