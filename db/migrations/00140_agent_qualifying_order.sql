-- +goose Up
-- declaration 140 AgentQualifyingOrder m20260911_000287_agent_qualifying_order
-- source: migration/src/agent_qualifying_order.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.agent_rebate_policy
    ADD COLUMN min_order_cents bigint NOT NULL DEFAULT 10000,
    ADD COLUMN attribution_validity_days integer NOT NULL DEFAULT 365,
    ADD CONSTRAINT agent_rebate_policy_min_order_nonneg
        CHECK (min_order_cents >= 0),
    ADD CONSTRAINT agent_rebate_policy_validity_range
        CHECK (attribution_validity_days >= 0 AND attribution_validity_days <= 3650);

ALTER TABLE public.account_users
    ADD COLUMN agent_attributed_at timestamp with time zone,
    ADD COLUMN agent_attribution_bps integer,
    ADD CONSTRAINT account_users_agent_attribution_bps_range
        CHECK (agent_attribution_bps IS NULL
            OR (agent_attribution_bps >= 0 AND agent_attribution_bps <= 10000));

UPDATE public.account_users u
   SET agent_attributed_at = u.created_at,
       agent_attribution_bps = COALESCE(a.rebate_bps, p.default_rebate_bps)
  FROM public.agents a, public.agent_rebate_policy p
 WHERE a.user_id = u.invited_by_agent_user_id;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
