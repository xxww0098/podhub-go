-- +goose Up
-- declaration 278 AuthLoginThrottle m20261013_000057_auth_login_throttle
-- source: migration/src/auth_login_throttle.rs @ a03d735
-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS public.auth_login_attempts (
    email_hash bytea NOT NULL,
    ip_hash bytea NOT NULL,
    failures integer NOT NULL DEFAULT 0,
    window_start timestamp with time zone NOT NULL,
    next_allowed_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT auth_login_attempts_pkey PRIMARY KEY (email_hash, ip_hash),
    CONSTRAINT ck_auth_login_attempts_email_hash CHECK (octet_length(email_hash) = 32),
    CONSTRAINT ck_auth_login_attempts_ip_hash CHECK (octet_length(ip_hash) = 32),
    CONSTRAINT ck_auth_login_attempts_failures CHECK (failures >= 0)
);

CREATE INDEX IF NOT EXISTS ix_auth_login_attempts_updated
    ON public.auth_login_attempts (updated_at);
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
