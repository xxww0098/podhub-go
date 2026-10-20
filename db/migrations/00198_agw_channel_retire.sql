-- +goose Up
-- declaration 198 AgwChannelRetire m20260919_000332_agw_channel_retire
-- source: migration/src/agw_channel_retire.rs @ a03d735
-- +goose StatementBegin
DROP INDEX IF EXISTS public.ai_requests_charge_pending_idx;
ALTER TABLE public.ai_requests
    DROP CONSTRAINT IF EXISTS ai_requests_charge_state_valid,
    DROP COLUMN IF EXISTS charge_state,
    DROP COLUMN IF EXISTS charge_currency,
    DROP COLUMN IF EXISTS charge_amount,
    DROP COLUMN IF EXISTS agw_usage_log_id;
DROP TABLE IF EXISTS public.agw_user_wallets;
DROP TABLE IF EXISTS public.agw_provision_outbox;
DROP TABLE IF EXISTS public.agw_accounts;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
