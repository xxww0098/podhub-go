-- Agent reads and the payout update. Shapes follow the goose CHECKs at
-- a03d735. Money-moving inserts (claim, transfer, withdrawal request) are
-- not here: the Rust statements were not readable.

-- name: GetAgent :one
SELECT user_id, invite_code, status, payout_channel, payout_account, payout_real_name,
       review_flagged_at
FROM public.agents
WHERE user_id = $1;

-- name: GetAgentWallet :one
SELECT user_id, balance_cents, held_cents, version
FROM public.agent_commission_wallets
WHERE user_id = $1;

-- name: GetAgentRebatePolicy :one
SELECT default_rebate_bps, min_order_cents, attribution_validity_days, min_withdraw_cents
FROM public.agent_rebate_policy
WHERE singleton;

-- name: ListAgentLedger :many
SELECT id, entry_type, idempotency_key, amount_cents, held_delta_cents,
       balance_before_cents, balance_after_cents, held_before_cents, held_after_cents,
       commission_id, withdrawal_id, note, created_at
FROM public.agent_commission_ledger
WHERE user_id = $1
ORDER BY created_at DESC, id DESC
LIMIT $2;

-- name: ListAgentWithdrawals :many
SELECT id, public_id, amount_cents, channel, account, real_name, status,
       reference, reject_reason, requested_at, decided_at, decided_by_user_id
FROM public.agent_withdrawals
WHERE user_id = $1
ORDER BY requested_at DESC, id DESC;

-- name: UpdateAgentPayout :execrows
UPDATE public.agents
SET payout_channel = $2,
    payout_account = $3,
    payout_real_name = $4,
    updated_at = clock_timestamp()
WHERE user_id = $1;
