-- +goose Up
-- declaration 196 AgentPayoutRetirement m20260918_000334_agent_payout_retirement
-- source: migration/src/agent_payout_retirement.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.agents
    DROP CONSTRAINT agents_rebate_bps_range,
    DROP COLUMN rebate_bps,
    DROP COLUMN payout_org_id;

ALTER TABLE public.agent_commissions
    DROP CONSTRAINT agent_commissions_status_shape,
    DROP COLUMN payout_org_id;

ALTER TABLE public.agent_commissions
    RENAME COLUMN amount_microfen TO amount_cents;

ALTER TABLE public.agent_commissions
    ADD CONSTRAINT agent_commissions_status_shape CHECK (
        (status = 'credited' AND amount_cents > 0
            AND ledger_idempotency_key IS NOT NULL)
        OR (status = 'skipped' AND amount_cents = 0
            AND ledger_idempotency_key IS NULL));
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
