-- +goose Up
-- Workspace slice buckets are filled in by the owner, so no server-side
-- provisioning checkpoints remain.
DROP TABLE IF EXISTS public.workspace_slice_provisions;

-- +goose Down
CREATE TABLE public.workspace_slice_provisions (
    org_id bigint PRIMARY KEY REFERENCES public.organizations(id),
    id uuid NOT NULL UNIQUE,
    created_by bigint NOT NULL,
    account_id text NOT NULL CHECK (account_id ~ '^[a-f0-9]{32}$'),
    bucket text NOT NULL,
    phase text NOT NULL CHECK (phase IN ('creating','bucket_ready','token_creating','verifying','ready','blocked')),
    error_code text NOT NULL DEFAULT '',
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    custom_name boolean NOT NULL DEFAULT false,
    CONSTRAINT workspace_slice_provisions_account_bucket_key UNIQUE (account_id, bucket)
);
ALTER TABLE public.workspace_slice_provisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_slice_provisions FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_slice_provision_read ON public.workspace_slice_provisions FOR SELECT TO podhub_app
    USING (org_id=NULLIF(current_setting('app.current_org_id',true),'')::bigint);
CREATE POLICY workspace_slice_provision_write ON public.workspace_slice_provisions FOR ALL TO podhub_app
    USING (org_id=NULLIF(current_setting('app.current_org_id',true),'')::bigint AND EXISTS (
        SELECT 1 FROM public.organizations o WHERE o.id=org_id AND o.dissolved_at IS NULL
        AND o.owner_user_id=NULLIF(current_setting('app.slice_storage_actor_id',true),'')::bigint
    ))
    WITH CHECK (org_id=NULLIF(current_setting('app.current_org_id',true),'')::bigint AND EXISTS (
        SELECT 1 FROM public.organizations o WHERE o.id=org_id AND o.dissolved_at IS NULL
        AND o.owner_user_id=NULLIF(current_setting('app.slice_storage_actor_id',true),'')::bigint
    ));
GRANT SELECT,INSERT,UPDATE,DELETE ON public.workspace_slice_provisions TO podhub_app;
