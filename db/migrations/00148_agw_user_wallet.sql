-- +goose Up
-- declaration 148 AgwUserWallet m20260912_000291_agw_user_wallet
-- source: migration/src/agw_user_wallet.rs @ a03d735
-- +goose StatementBegin
CREATE TABLE public.agw_user_wallets (
    user_id bigint PRIMARY KEY REFERENCES public.account_users(id),
    email text NOT NULL UNIQUE,
    agw_user_id bigint NOT NULL,
    password_ciphertext bytea NOT NULL,
    password_key_id text NOT NULL,
    key_ciphertext bytea,
    key_id text,
    key_prefix text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT agw_user_wallet_key_complete CHECK (
        (key_ciphertext IS NULL AND key_id IS NULL AND key_prefix IS NULL)
        OR (key_ciphertext IS NOT NULL AND key_id IS NOT NULL AND key_prefix IS NOT NULL)
    )
);
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
