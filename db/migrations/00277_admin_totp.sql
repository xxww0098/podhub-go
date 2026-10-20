-- +goose Up
-- declaration 277 AdminTotp m20261013_000056_admin_totp
-- source: migration/src/admin_totp.rs @ a03d735
-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS public.account_admin_totp (
    user_id bigint PRIMARY KEY REFERENCES public.account_users (id) ON DELETE CASCADE,
    secret_nonce bytea NOT NULL,
    secret_ciphertext bytea NOT NULL,
    confirmed_at timestamp with time zone,
    recovery_hashes text[] NOT NULL DEFAULT '{}',
    failed_attempts integer NOT NULL DEFAULT 0,
    failures_reset_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT ck_account_admin_totp_nonce CHECK (octet_length(secret_nonce) = 12),
    CONSTRAINT ck_account_admin_totp_ciphertext CHECK (
        octet_length(secret_ciphertext) BETWEEN 17 AND 128
    ),
    CONSTRAINT ck_account_admin_totp_failures CHECK (failed_attempts >= 0)
);

ALTER TABLE public.account_sessions
    ADD COLUMN IF NOT EXISTS admin_step_up_until timestamp with time zone;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
