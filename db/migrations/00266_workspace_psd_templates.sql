-- +goose Up
-- declaration 266 WorkspacePsdTemplates m20260930_000422_workspace_psd_templates
-- source: migration/src/workspace_psd_templates.rs @ a03d735
-- +goose StatementBegin
CREATE TABLE public.workspace_psd_templates (
    id uuid PRIMARY KEY,
    org_id bigint NOT NULL REFERENCES public.organizations(id),
    created_by bigint NOT NULL REFERENCES public.account_users(id),
    description_category_id bigint NOT NULL CHECK (description_category_id > 0),
    type_id bigint NOT NULL CHECK (type_id > 0),
    sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
    byte_length bigint NOT NULL CHECK (byte_length BETWEEN 26 AND 524288000),
    storage_identity text NOT NULL,
    object_key text NOT NULL,
    verified_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (org_id, description_category_id, type_id, sha256)
);
GRANT SELECT, INSERT, UPDATE ON public.workspace_psd_templates TO podhub_app, podhub_worker;

ALTER TABLE public.workspace_psd_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_psd_templates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.workspace_psd_templates;
CREATE POLICY tenant_isolation ON public.workspace_psd_templates
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
