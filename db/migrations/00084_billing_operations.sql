-- +goose Up
-- declaration 84 BillingOperations m20260819_000220_billing_operations
-- source: migration/src/billing_operations.rs @ a03d735
-- +goose StatementBegin
CREATE TABLE public.billing_operations (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    org_id bigint NOT NULL REFERENCES public.organizations(id),
    idempotency_key character varying(128) NOT NULL UNIQUE,
    price_snapshot_version bigint NOT NULL,
    expected_upper_bound_microfen bigint NOT NULL,
    actual_microfen bigint,
    state character varying(32) NOT NULL DEFAULT 'created',
    created_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT billing_operations_expected_positive CHECK (expected_upper_bound_microfen > 0),
    CONSTRAINT billing_operations_actual_nonneg CHECK (actual_microfen IS NULL OR actual_microfen >= 0),
    CONSTRAINT billing_operations_state_known CHECK (state IN ('created','reserved','upstream_started','settled','released','outcome_unknown','reconciliation_settled'))
);

CREATE INDEX IF NOT EXISTS ix_billing_operations_org ON public.billing_operations (org_id);

ALTER TABLE public.billing_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_operations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_operation_tenant_isolation ON public.billing_operations;
CREATE POLICY billing_operation_tenant_isolation ON public.billing_operations
    FOR ALL TO podhub_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint);
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.billing_operations TO podhub_app, podhub_worker;
GRANT USAGE, SELECT ON SEQUENCE public.billing_operations_id_seq TO podhub_app, podhub_worker;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
