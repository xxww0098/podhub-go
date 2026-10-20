-- +goose Up
-- declaration 146 AgwRequestCharge m20260912_000293_agw_request_charge
-- source: migration/src/agw_request_charge.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.ai_requests
    ADD COLUMN IF NOT EXISTS agw_usage_log_id bigint;

ALTER TABLE public.ai_requests
    ADD COLUMN IF NOT EXISTS charge_amount numeric(20, 8);

ALTER TABLE public.ai_requests
    ADD COLUMN IF NOT EXISTS charge_currency character varying(16);

ALTER TABLE public.ai_requests
    ADD COLUMN IF NOT EXISTS charge_state character varying(16);

ALTER TABLE public.ai_requests
    DROP CONSTRAINT IF EXISTS ai_requests_charge_state_valid;

ALTER TABLE public.ai_requests
    ADD CONSTRAINT ai_requests_charge_state_valid
    CHECK (
        charge_state IS NULL
        OR charge_state IN ('pending', 'settled', 'unknown')
    );

-- The reconciler only ever scans rows whose money is still unknown; the index
-- stays proportional to that set, not to the table.
CREATE INDEX IF NOT EXISTS ai_requests_charge_pending_idx
    ON public.ai_requests (id)
    WHERE charge_state = 'pending';
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
