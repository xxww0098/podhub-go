-- +goose Up
-- declaration 145 AgwSupply m20260912_000290_agw_supply
-- source: migration/src/agw_supply.rs @ a03d735
-- +goose StatementBegin
CREATE TABLE public.agw_accounts (
    org_id          bigint PRIMARY KEY,
    agw_user_id     bigint NOT NULL,
    email           text NOT NULL,
    key_ciphertext  bytea NOT NULL,
    key_id          text NOT NULL,
    key_prefix      text NOT NULL,
    status          text NOT NULL DEFAULT 'active',
    last_error      text,
    created_at      timestamp with time zone NOT NULL DEFAULT now(),
    updated_at      timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.agw_provision_outbox (
    id               bigserial PRIMARY KEY,
    org_id           bigint NOT NULL,
    owner_user_id    bigint NOT NULL,
    owner_email      text NOT NULL,
    kind             text NOT NULL,
    idempotency_key  text NOT NULL UNIQUE,
    payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
    attempts         integer NOT NULL DEFAULT 0,
    next_attempt_at  timestamp with time zone NOT NULL DEFAULT now(),
    state            text NOT NULL DEFAULT 'pending',
    last_error       text,
    created_at       timestamp with time zone NOT NULL DEFAULT now(),
    updated_at       timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX agw_provision_outbox_pending_idx
    ON public.agw_provision_outbox (state, next_attempt_at)
    WHERE state = 'pending';
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
