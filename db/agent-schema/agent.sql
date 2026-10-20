-- sqlc snapshot for the agent queries. Runtime DDL is the goose chain
-- (00101, 00140, 00141, 00195, 00196). This file only names columns those
-- queries touch. It is not a migration.

CREATE TABLE public.agent_rebate_policy (
    singleton boolean PRIMARY KEY,
    default_rebate_bps integer NOT NULL,
    min_order_cents bigint NOT NULL,
    attribution_validity_days integer NOT NULL,
    min_withdraw_cents bigint NOT NULL
);

CREATE TABLE public.agents (
    user_id bigint PRIMARY KEY,
    invite_code character varying(32) NOT NULL,
    status character varying(16) NOT NULL,
    payout_channel character varying(16),
    payout_account character varying(128),
    payout_real_name character varying(64),
    review_flagged_at timestamp with time zone,
    created_by_user_id bigint NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);

CREATE TABLE public.agent_commission_wallets (
    user_id bigint PRIMARY KEY,
    balance_cents bigint NOT NULL,
    held_cents bigint NOT NULL,
    version bigint NOT NULL,
    updated_at timestamp with time zone NOT NULL
);

CREATE TABLE public.agent_commission_ledger (
    id bigint PRIMARY KEY,
    user_id bigint NOT NULL,
    entry_type character varying(24) NOT NULL,
    idempotency_key character varying(128) NOT NULL,
    amount_cents bigint NOT NULL,
    held_delta_cents bigint NOT NULL,
    balance_before_cents bigint NOT NULL,
    balance_after_cents bigint NOT NULL,
    held_before_cents bigint NOT NULL,
    held_after_cents bigint NOT NULL,
    commission_id bigint,
    withdrawal_id bigint,
    note text NOT NULL,
    created_at timestamp with time zone NOT NULL
);

CREATE TABLE public.agent_withdrawals (
    id bigint PRIMARY KEY,
    public_id character varying(32) NOT NULL,
    user_id bigint NOT NULL,
    amount_cents bigint NOT NULL,
    channel character varying(16) NOT NULL,
    account character varying(128) NOT NULL,
    real_name character varying(64) NOT NULL,
    status character varying(16) NOT NULL,
    reference character varying(128),
    reject_reason character varying(200),
    requested_at timestamp with time zone NOT NULL,
    decided_at timestamp with time zone,
    decided_by_user_id bigint
);
