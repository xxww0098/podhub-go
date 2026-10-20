-- +goose Up
-- declaration 271 ClientListingLogs m20261009_000051_client_listing_logs
-- source: migration/src/client_listing_logs.rs @ a03d735
-- +goose StatementBegin
CREATE TABLE public.client_listing_logs (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    org_id bigint NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
    user_id bigint NOT NULL REFERENCES public.account_users (id) ON DELETE CASCADE,
    client_id text NOT NULL,
    session_id text NOT NULL,
    version text NOT NULL,
    logged_at timestamptz NOT NULL,
    received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    level text NOT NULL,
    module text NOT NULL,
    event text NOT NULL,
    duration_ms integer,
    batch_id text,
    row_id text,
    offer_id text,
    intent_id text,
    job_id text,
    psd_id text,
    error_code text,
    error_message text,
    fields jsonb NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT client_listing_logs_client_unique UNIQUE (user_id, client_id),
    CONSTRAINT client_listing_logs_level CHECK (level IN ('debug', 'info', 'warn', 'error')),
    CONSTRAINT client_listing_logs_fields_object CHECK (jsonb_typeof(fields) = 'object'),
    CONSTRAINT client_listing_logs_duration CHECK (duration_ms IS NULL OR duration_ms >= 0)
);

CREATE INDEX client_listing_logs_received_idx
    ON public.client_listing_logs (received_at, id);
CREATE INDEX client_listing_logs_user_received_idx
    ON public.client_listing_logs (user_id, received_at DESC);
CREATE INDEX client_listing_logs_batch_idx
    ON public.client_listing_logs (batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX client_listing_logs_row_idx
    ON public.client_listing_logs (row_id) WHERE row_id IS NOT NULL;
CREATE INDEX client_listing_logs_offer_idx
    ON public.client_listing_logs (offer_id) WHERE offer_id IS NOT NULL;
CREATE INDEX client_listing_logs_intent_idx
    ON public.client_listing_logs (intent_id) WHERE intent_id IS NOT NULL;

GRANT SELECT, INSERT ON public.client_listing_logs TO podhub_app;
GRANT SELECT, DELETE ON public.client_listing_logs TO podhub_worker;
GRANT USAGE, SELECT ON SEQUENCE public.client_listing_logs_id_seq TO podhub_app;

ALTER TABLE public.client_listing_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_listing_logs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.client_listing_logs;
CREATE POLICY tenant_isolation ON public.client_listing_logs
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
