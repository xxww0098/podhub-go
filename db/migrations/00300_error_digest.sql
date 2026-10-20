-- +goose Up
-- declaration 300 ErrorDigest
-- Post-Rust append. Does not alter migrations 00001-00293.
-- error_digest is a redacted side table. event_inbox_events keeps its
-- existing privileges and has no new RLS policy, so the schema fingerprint
-- of that table stays the Rust head. Aged inbox rows of every kind are
-- deleted only inside prune_aged_inbox. podhub_error_prune may execute that
-- function and has no DELETE on the table, and the role is not BYPASSRLS.
-- +goose StatementBegin
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'podhub_error_prune') THEN
        CREATE ROLE podhub_error_prune NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'podhub_digest_platform') THEN
        CREATE ROLE podhub_digest_platform NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
    END IF;
END
$$;

GRANT podhub_error_prune TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
GRANT podhub_digest_platform TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;

CREATE TABLE public.error_digest (
    id              bigserial PRIMARY KEY,
    org_id          bigint NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
    fingerprint     text NOT NULL,
    route_template  text NOT NULL,
    status_code     integer NOT NULL,
    event_count     bigint NOT NULL,
    first_at        timestamptz NOT NULL,
    last_at         timestamptz NOT NULL,
    summary         text NOT NULL,
    window_start    timestamptz NOT NULL,
    CONSTRAINT error_digest_fingerprint_hex CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
    CONSTRAINT error_digest_route_clean CHECK (
        char_length(route_template) BETWEEN 1 AND 160
        AND route_template !~* '(sk-|bearer|api[_-]?key|signature=|x-amz-|@)'
    ),
    CONSTRAINT error_digest_summary_clean CHECK (
        char_length(summary) BETWEEN 1 AND 80
        AND summary !~* '(sk-|bearer|api[_-]?key|signature=|x-amz-|@)'
        AND summary !~ '[0-9]{13}'
    ),
    CONSTRAINT error_digest_status CHECK (status_code = 0 OR status_code BETWEEN 100 AND 599),
    CONSTRAINT error_digest_count CHECK (event_count > 0),
    CONSTRAINT error_digest_span CHECK (first_at <= last_at),
    CONSTRAINT error_digest_org CHECK (org_id IS NULL OR org_id > 0),
    CONSTRAINT error_digest_window_key UNIQUE NULLS NOT DISTINCT (
        org_id, fingerprint, route_template, status_code, window_start
    )
);

CREATE INDEX error_digest_platform_last_idx
    ON public.error_digest (last_at DESC, fingerprint)
    WHERE org_id IS NULL;
CREATE INDEX error_digest_org_window_idx
    ON public.error_digest (org_id, window_start)
    WHERE org_id IS NOT NULL;

REVOKE ALL ON TABLE public.error_digest FROM PUBLIC, podhub_app, podhub_worker;
GRANT SELECT, INSERT, UPDATE ON TABLE public.error_digest TO podhub_app;
GRANT SELECT, INSERT, UPDATE ON TABLE public.error_digest TO podhub_digest_platform;
REVOKE ALL ON SEQUENCE public.error_digest_id_seq FROM PUBLIC, podhub_app, podhub_worker, podhub_digest_platform;
GRANT USAGE, SELECT ON SEQUENCE public.error_digest_id_seq TO podhub_app, podhub_digest_platform;

ALTER TABLE public.error_digest ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.error_digest FORCE ROW LEVEL SECURITY;

CREATE POLICY error_digest_tenant ON public.error_digest
    FOR ALL
    TO podhub_app
    USING (
        org_id IS NOT NULL
        AND org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    )
    WITH CHECK (
        org_id IS NOT NULL
        AND org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    );

CREATE POLICY error_digest_platform_observe ON public.error_digest
    FOR SELECT
    TO podhub_app
    USING (
        org_id IS NULL
        AND EXISTS (
            SELECT 1 FROM public.account_users observer
            WHERE observer.id::text = current_setting('app.platform_observer_id', true)
              AND observer.role = 'super_admin'
              AND observer.disabled_at IS NULL
        )
    );

CREATE POLICY error_digest_platform_write ON public.error_digest
    FOR ALL
    TO podhub_digest_platform
    USING (org_id IS NULL)
    WITH CHECK (org_id IS NULL);

CREATE FUNCTION public.prune_aged_inbox(older_seconds bigint)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    deleted bigint;
BEGIN
    IF older_seconds IS NULL OR older_seconds < 0 THEN
        older_seconds := 0;
    END IF;
    DELETE FROM public.event_inbox_events
     WHERE received_at < clock_timestamp() - (older_seconds::text || ' seconds')::interval;
    GET DIAGNOSTICS deleted = ROW_COUNT;
    RETURN deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.prune_aged_inbox(bigint) FROM PUBLIC, podhub_app, podhub_worker;
GRANT EXECUTE ON FUNCTION public.prune_aged_inbox(bigint) TO podhub_error_prune;
-- +goose StatementEnd

-- +goose Down
-- Rust down() refuses a destructive rollback. This append follows that shape.
SELECT 1;
