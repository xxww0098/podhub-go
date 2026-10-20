-- +goose Up
-- declaration 15 AuditLogsSupportGrantFk m20260802_000043_audit_logs_support_grant_fk
-- source: migration/src/idempotency.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.audit_logs
    ADD CONSTRAINT audit_logs_support_grant_id_fkey
    FOREIGN KEY (support_grant_id)
    REFERENCES public.support_grants(id)
    DEFERRABLE INITIALLY DEFERRED
    NOT VALID;

CREATE INDEX IF NOT EXISTS ix_audit_logs_support_grant_id
    ON public.audit_logs (support_grant_id);

ALTER TABLE public.audit_logs
    VALIDATE CONSTRAINT audit_logs_support_grant_id_fkey;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
