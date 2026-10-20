-- +goose Up
-- declaration 341 OzonErrorSampleRetention
-- Post-Rust append. Does not alter migrations 00001-00340.
-- Live sample_description values are blanked by the existing River periodic
-- job podhub.error_digest once last_seen_at is older than the cutoff the
-- process passes (180 days in Go). occurrences, first_seen_at, and
-- last_seen_at are not writable by this role. docs_seed is not a live sample.
-- The role is NOLOGIN, NOSUPERUSER, NOBYPASSRLS, NOINHERIT. Membership is
-- SET only, matching the writer-lease grant shape. It is not granted to
-- PUBLIC or to podhub_worker.
-- +goose StatementBegin
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'podhub_ozon_sample_prune') THEN
        CREATE ROLE podhub_ozon_sample_prune NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
    END IF;
END
$$;

GRANT podhub_ozon_sample_prune TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
GRANT podhub_ozon_sample_prune TO podhub_login_api WITH INHERIT FALSE, SET TRUE;
GRANT podhub_ozon_sample_prune TO podhub_login_listing_worker WITH INHERIT FALSE, SET TRUE;
GRANT podhub_ozon_sample_prune TO podhub_login_ai_media_worker WITH INHERIT FALSE, SET TRUE;
GRANT podhub_ozon_sample_prune TO podhub_login_reconciler WITH INHERIT FALSE, SET TRUE;

GRANT SELECT (source, sample_description, last_seen_at)
    ON TABLE public.ozon_error_catalog TO podhub_ozon_sample_prune;
GRANT UPDATE (sample_description)
    ON TABLE public.ozon_error_catalog TO podhub_ozon_sample_prune;
GRANT SELECT (sample_description, last_seen_at)
    ON TABLE public.ozon_error_observation TO podhub_ozon_sample_prune;
GRANT UPDATE (sample_description)
    ON TABLE public.ozon_error_observation TO podhub_ozon_sample_prune;

CREATE POLICY ozon_error_catalog_sample_read ON public.ozon_error_catalog
    FOR SELECT
    TO podhub_ozon_sample_prune
    USING (source <> 'docs_seed');

CREATE POLICY ozon_error_catalog_sample_prune ON public.ozon_error_catalog
    FOR UPDATE
    TO podhub_ozon_sample_prune
    USING (source <> 'docs_seed')
    WITH CHECK (source <> 'docs_seed' AND sample_description = '');

CREATE POLICY ozon_error_observation_sample_read ON public.ozon_error_observation
    FOR SELECT
    TO podhub_ozon_sample_prune
    USING (true);

CREATE POLICY ozon_error_observation_sample_prune ON public.ozon_error_observation
    FOR UPDATE
    TO podhub_ozon_sample_prune
    USING (true)
    WITH CHECK (sample_description = '');
-- +goose StatementEnd

-- +goose Down
-- Destructive rollback is refused. This append follows that shape.
SELECT 1;
