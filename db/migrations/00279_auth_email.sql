-- +goose Up
-- declaration 279 AuthEmail m20261013_000058_auth_email
-- source: migration/src/auth_email.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.account_users
    ADD COLUMN IF NOT EXISTS email_verified_at timestamp with time zone;

UPDATE public.account_users
SET email_verified_at = COALESCE(created_at, clock_timestamp())
WHERE email_verified_at IS NULL;

CREATE TABLE IF NOT EXISTS public.auth_email_tokens (
    token_hash text NOT NULL,
    user_id bigint NOT NULL,
    purpose text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT auth_email_tokens_pkey PRIMARY KEY (token_hash),
    CONSTRAINT auth_email_tokens_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES public.account_users (id) ON DELETE CASCADE,
    CONSTRAINT ck_auth_email_tokens_purpose
        CHECK (purpose = ANY (ARRAY['reset'::text, 'verify'::text]))
);

CREATE INDEX IF NOT EXISTS ix_auth_email_tokens_open
    ON public.auth_email_tokens (user_id, purpose)
    WHERE consumed_at IS NULL;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
