-- +goose Up
-- declaration 264 AutomationExecutionReceipts m20261004_000447_automation_execution_receipts
-- source: migration/src/automation_execution_receipts.rs @ a03d735
-- +goose StatementBegin
CREATE TABLE public.automation_executions (
    grant_id uuid NOT NULL REFERENCES public.automation_grants(id) ON DELETE RESTRICT,
    execution_id uuid NOT NULL,
    input_digest text NOT NULL,
    status text NOT NULL DEFAULT 'running',
    lease_token uuid,
    lease_epoch bigint NOT NULL DEFAULT 1,
    lease_deadline timestamptz,
    calls integer NOT NULL DEFAULT 0,
    error_code text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    completed_at timestamptz,
    CONSTRAINT automation_executions_pkey PRIMARY KEY (grant_id,execution_id),
    CONSTRAINT automation_executions_digest CHECK (input_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT automation_executions_status CHECK (status IN ('running','completed','failed','cancelled','interrupted')),
    CONSTRAINT automation_executions_lease CHECK (lease_epoch >= 1 AND (status <> 'running' OR (lease_token IS NOT NULL AND lease_deadline IS NOT NULL))),
    CONSTRAINT automation_executions_calls CHECK (calls >= 0),
    CONSTRAINT automation_executions_error_code CHECK (error_code IS NULL OR (length(error_code) BETWEEN 1 AND 100 AND error_code ~ '^[a-z0-9_]+$'))
);
CREATE INDEX automation_executions_grant_created_idx ON public.automation_executions (grant_id,created_at,execution_id);
CREATE INDEX automation_executions_grant_expired_idx ON public.automation_executions (grant_id,lease_deadline,execution_id) WHERE status='running';
CREATE TABLE public.automation_call_receipts (
    grant_id uuid NOT NULL,
    execution_id uuid NOT NULL,
    call_id text NOT NULL,
    method text NOT NULL,
    args_digest text NOT NULL,
    outcome text NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT automation_call_receipts_pkey PRIMARY KEY (grant_id,execution_id,call_id),
    CONSTRAINT automation_call_receipts_execution_fk FOREIGN KEY (grant_id,execution_id) REFERENCES public.automation_executions(grant_id,execution_id) ON DELETE RESTRICT,
    CONSTRAINT automation_call_receipts_call_id CHECK (length(call_id) BETWEEN 1 AND 128),
    CONSTRAINT automation_call_receipts_method CHECK (length(method) BETWEEN 1 AND 256),
    CONSTRAINT automation_call_receipts_digest CHECK (args_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT automation_call_receipts_outcome CHECK (length(outcome) BETWEEN 1 AND 64 AND outcome ~ '^[a-z0-9_]+$'),
    CONSTRAINT automation_call_receipts_metadata CHECK (jsonb_typeof(metadata)='object' AND octet_length(metadata::text)<=16384)
);
ALTER TABLE public.automation_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_executions FORCE ROW LEVEL SECURITY;
CREATE POLICY grant_owner_isolation ON public.automation_executions TO podhub_app
    USING (grant_id = NULLIF(current_setting('app.automation_grant_id',true),'')::uuid)
    WITH CHECK (grant_id = NULLIF(current_setting('app.automation_grant_id',true),'')::uuid);
ALTER TABLE public.automation_call_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_call_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY grant_owner_isolation ON public.automation_call_receipts TO podhub_app
    USING (grant_id = NULLIF(current_setting('app.automation_grant_id',true),'')::uuid)
    WITH CHECK (grant_id = NULLIF(current_setting('app.automation_grant_id',true),'')::uuid);
-- podhub_worker is BYPASSRLS; use SET LOCAL ROLE podhub_app per grant transaction.
-- Older platform default privileges grant both roles all DML automatically.
-- Remove those grants explicitly before granting the finite owner-role surface.
REVOKE ALL ON public.automation_executions,public.automation_call_receipts FROM PUBLIC,podhub_app,podhub_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.automation_executions TO podhub_app;
GRANT SELECT,INSERT,DELETE ON public.automation_call_receipts TO podhub_app;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
