-- +goose Up
-- +goose NO TRANSACTION
-- declaration 12 PaymentCallbackLedger m20260802_000040_payment_callback_ledger
-- source: migration/src/idempotency.rs @ a03d735
-- +goose StatementBegin
CREATE TABLE public.payment_callback_ledger (
    payment_reference character varying(128) NOT NULL,
    org_id bigint NOT NULL,
    plan character varying(64) NOT NULL,
    status character varying(64) NOT NULL,
    body_digest character varying(128),
    applied_at_ms bigint NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT payment_callback_ledger_pkey PRIMARY KEY (payment_reference)
);
-- +goose StatementEnd
-- +goose StatementBegin
INSERT INTO public.payment_callback_ledger
    (payment_reference, org_id, plan, status, body_digest, applied_at_ms, created_at)
SELECT DISTINCT ON (a.entity_id)
    a.entity_id,
    a.org_id,
    COALESCE(a.message::jsonb ->> 'plan', ''),
    a.status,
    NULL,
    a.created_at_ms,
    a.created_at
FROM public.audit_logs a
WHERE a.module = 'billing'
  AND a.action = 'payment_callback'
ORDER BY a.entity_id, a.created_at_ms ASC
ON CONFLICT (payment_reference) DO NOTHING;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
