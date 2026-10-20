-- +goose Up
-- declaration 182 AutomationCommands m20260917_000320_automation_commands
-- source: migration/src/automation_commands.rs @ a03d735
-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS public.automation_runtimes (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    org_id bigint NOT NULL,
    user_id bigint NOT NULL,
    grant_id uuid NOT NULL REFERENCES public.automation_grants (id) ON DELETE CASCADE,
    label varchar(120) NOT NULL,
    renderer_contract varchar(64) NOT NULL,
    heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    deregistered_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT automation_runtimes_pkey PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS automation_runtimes_scope_idx
    ON public.automation_runtimes (org_id, grant_id)
    WHERE deregistered_at IS NULL;

CREATE TABLE IF NOT EXISTS public.browser_commands (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    org_id bigint NOT NULL,
    user_id bigint NOT NULL,
    grant_id uuid NOT NULL,
    client_request_id varchar(120) NOT NULL,
    action varchar(32) NOT NULL,
    payload jsonb NOT NULL,
    status varchar(16) NOT NULL DEFAULT 'queued',
    claimed_by uuid,
    claim_epoch bigint NOT NULL DEFAULT 0,
    claim_expires_at timestamptz,
    progress jsonb,
    result jsonb,
    error jsonb,
    cancel_requested_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT browser_commands_pkey PRIMARY KEY (id),
    CONSTRAINT browser_commands_status_known
        CHECK (status IN ('queued','claimed','completed','failed','canceled')),
    CONSTRAINT browser_commands_action_known
        CHECK (action IN ('assets_import','listing_prepare'))
);
CREATE UNIQUE INDEX IF NOT EXISTS browser_commands_request_uidx
    ON public.browser_commands (org_id, grant_id, client_request_id);
CREATE INDEX IF NOT EXISTS browser_commands_queue_idx
    ON public.browser_commands (org_id, grant_id, created_at)
    WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS browser_commands_claimed_idx
    ON public.browser_commands (claimed_by)
    WHERE status = 'claimed';

CREATE TABLE IF NOT EXISTS public.automation_asset_sets (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    org_id bigint NOT NULL,
    user_id bigint NOT NULL,
    name varchar(120) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT automation_asset_sets_pkey PRIMARY KEY (id),
    CONSTRAINT automation_asset_sets_name_uidx UNIQUE (org_id, user_id, name)
);

CREATE TABLE IF NOT EXISTS public.automation_asset_set_items (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    set_id uuid NOT NULL REFERENCES public.automation_asset_sets (id) ON DELETE CASCADE,
    item_kind varchar(16) NOT NULL,
    item_key varchar(160) NOT NULL,
    file_name varchar(240) NOT NULL,
    sha256 varchar(64) NOT NULL,
    size_bytes bigint NOT NULL DEFAULT 0,
    runtime_id uuid REFERENCES public.automation_runtimes (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT automation_asset_set_items_pkey PRIMARY KEY (id),
    CONSTRAINT automation_asset_set_items_kind_known
        CHECK (item_kind IN ('local_file')),
    CONSTRAINT automation_asset_set_items_item_uidx UNIQUE (set_id, item_key)
);

ALTER TABLE public.automation_runtimes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_runtimes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.automation_runtimes
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint);

ALTER TABLE public.browser_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.browser_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.browser_commands
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint);

ALTER TABLE public.automation_asset_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_asset_sets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.automation_asset_sets
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint);

ALTER TABLE public.automation_asset_set_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_asset_set_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.automation_asset_set_items
    USING (set_id IN (
        SELECT id FROM public.automation_asset_sets s
        WHERE s.org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    ))
    WITH CHECK (set_id IN (
        SELECT id FROM public.automation_asset_sets s
        WHERE s.org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    ));

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
    public.automation_runtimes,
    public.browser_commands,
    public.automation_asset_sets,
    public.automation_asset_set_items
TO podhub_app, podhub_worker;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
