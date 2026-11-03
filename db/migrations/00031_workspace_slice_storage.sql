-- +goose Up
ALTER TABLE public.user_slice_storage RENAME TO workspace_slice_storage;
ALTER TABLE public.workspace_slice_storage RENAME COLUMN user_id TO created_by;
ALTER TABLE public.workspace_slice_storage DROP CONSTRAINT user_slice_storage_user_id_fkey;
ALTER TABLE public.workspace_slice_storage ADD COLUMN org_id bigint REFERENCES public.organizations(id);
DROP INDEX public.user_slice_storage_active;
DROP POLICY user_slice_storage_self ON public.workspace_slice_storage;

-- Preserve each owner's current workspace first. A personal bucket is never
-- copied into several workspaces, and former members' credentials are retired.
UPDATE public.workspace_slice_storage s SET org_id = (
    SELECT o.id FROM public.organizations o
    LEFT JOIN public.account_profiles p ON p.user_id=s.created_by
    WHERE o.owner_user_id=s.created_by AND o.dissolved_at IS NULL
    ORDER BY (o.id=p.active_org_id) DESC NULLS LAST, o.created_at, o.id LIMIT 1
);
UPDATE public.workspace_slice_storage SET retired_at=COALESCE(retired_at,clock_timestamp()) WHERE org_id IS NULL;
WITH duplicates AS (
    SELECT id, row_number() OVER (PARTITION BY endpoint,bucket ORDER BY created_at,id) AS n
    FROM public.workspace_slice_storage WHERE retired_at IS NULL
)
UPDATE public.workspace_slice_storage s SET retired_at=clock_timestamp()
FROM duplicates d WHERE d.id=s.id AND d.n>1;
ALTER TABLE public.workspace_slice_storage ADD CONSTRAINT workspace_slice_active_org CHECK (retired_at IS NOT NULL OR org_id IS NOT NULL);
CREATE UNIQUE INDEX workspace_slice_storage_active ON public.workspace_slice_storage(org_id) WHERE retired_at IS NULL;
CREATE UNIQUE INDEX workspace_slice_storage_bucket ON public.workspace_slice_storage(endpoint,bucket) WHERE retired_at IS NULL;
CREATE POLICY workspace_slice_read ON public.workspace_slice_storage FOR SELECT TO podhub_app
    USING (org_id=NULLIF(current_setting('app.current_org_id',true),'')::bigint);
CREATE POLICY workspace_slice_write ON public.workspace_slice_storage FOR ALL TO podhub_app
    USING (org_id=NULLIF(current_setting('app.current_org_id',true),'')::bigint AND EXISTS (
        SELECT 1 FROM public.organizations o WHERE o.id=org_id AND o.dissolved_at IS NULL
        AND o.owner_user_id=NULLIF(current_setting('app.slice_storage_actor_id',true),'')::bigint
    ))
    WITH CHECK (org_id=NULLIF(current_setting('app.current_org_id',true),'')::bigint AND EXISTS (
        SELECT 1 FROM public.organizations o WHERE o.id=org_id AND o.dissolved_at IS NULL
        AND o.owner_user_id=NULLIF(current_setting('app.slice_storage_actor_id',true),'')::bigint
    ));

ALTER TABLE public.user_slice_clear_requests RENAME TO workspace_slice_clear_requests;
ALTER TABLE public.workspace_slice_clear_requests RENAME COLUMN user_id TO requested_by;
ALTER TABLE public.workspace_slice_clear_requests ADD COLUMN org_id bigint REFERENCES public.organizations(id);
UPDATE public.workspace_slice_clear_requests r SET org_id=s.org_id FROM public.workspace_slice_storage s WHERE s.id=r.storage_id;
DROP POLICY user_slice_clear_self ON public.workspace_slice_clear_requests;
CREATE POLICY workspace_slice_clear_read ON public.workspace_slice_clear_requests FOR SELECT TO podhub_app
    USING (org_id=NULLIF(current_setting('app.current_org_id',true),'')::bigint);
CREATE POLICY workspace_slice_clear_insert ON public.workspace_slice_clear_requests FOR INSERT TO podhub_app
    WITH CHECK (org_id=NULLIF(current_setting('app.current_org_id',true),'')::bigint AND requested_by=NULLIF(current_setting('app.slice_storage_actor_id',true),'')::bigint AND EXISTS (
        SELECT 1 FROM public.organizations o JOIN public.workspace_slice_storage s ON s.org_id=o.id
        WHERE o.id=workspace_slice_clear_requests.org_id AND s.id=workspace_slice_clear_requests.storage_id AND s.retired_at IS NULL
        AND o.owner_user_id=requested_by AND o.dissolved_at IS NULL
    ));

CREATE TABLE public.workspace_slice_provisions (
    org_id bigint PRIMARY KEY REFERENCES public.organizations(id),
    id uuid NOT NULL UNIQUE,
    created_by bigint NOT NULL,
    account_id text NOT NULL CHECK (account_id ~ '^[a-f0-9]{32}$'),
    bucket text NOT NULL UNIQUE,
    phase text NOT NULL CHECK (phase IN ('creating','bucket_ready','token_creating','verifying','ready','blocked')),
    error_code text NOT NULL DEFAULT '',
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
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
GRANT SELECT,INSERT,UPDATE ON public.workspace_slice_provisions TO podhub_app;

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
    RAISE EXCEPTION 'Workspace bucket ownership cannot be reverted to personal ownership without a reviewed data migration';
END $$;
-- +goose StatementEnd
