-- +goose Up
-- declaration 183 AutomationPreviews m20260917_000321_automation_previews
-- source: migration/src/automation_previews.rs @ a03d735
-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS public.automation_previews (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    org_id bigint NOT NULL,
    user_id bigint NOT NULL,
    grant_id uuid NOT NULL,
    store_id varchar(64) NOT NULL,
    digest varchar(64) NOT NULL,
    input jsonb NOT NULL,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT automation_previews_pkey PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS automation_previews_scope_idx
    ON public.automation_previews (org_id, grant_id, created_at);

ALTER TABLE public.automation_previews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_previews FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.automation_previews
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
    public.automation_previews
TO podhub_app, podhub_worker;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
