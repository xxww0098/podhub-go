-- +goose Up
-- Super administrators no longer have a second factor. Login, the management
-- routes, and the MCP code tools authorize on the platform role alone, so the
-- verifier rows and the per-session step-up window have no reader left.
-- +goose StatementBegin
DROP TABLE IF EXISTS public.account_admin_totp;
ALTER TABLE public.account_sessions DROP COLUMN IF EXISTS admin_step_up_until;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE public.account_sessions ADD COLUMN IF NOT EXISTS admin_step_up_until timestamp with time zone;
CREATE TABLE IF NOT EXISTS public.account_admin_totp (
    user_id bigint PRIMARY KEY,
    secret_nonce bytea NOT NULL,
    secret_ciphertext bytea NOT NULL,
    confirmed_at timestamp with time zone,
    recovery_hashes text[] DEFAULT '{}'::text[] NOT NULL,
    failed_attempts integer DEFAULT 0 NOT NULL,
    failures_reset_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT ck_account_admin_totp_ciphertext CHECK (((octet_length(secret_ciphertext) >= 17) AND (octet_length(secret_ciphertext) <= 128))),
    CONSTRAINT ck_account_admin_totp_failures CHECK ((failed_attempts >= 0)),
    CONSTRAINT ck_account_admin_totp_nonce CHECK ((octet_length(secret_nonce) = 12))
);
ALTER TABLE ONLY public.account_admin_totp
    ADD CONSTRAINT account_admin_totp_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.account_users(id) ON DELETE CASCADE;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.account_admin_totp TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.account_admin_totp TO podhub_worker;
-- +goose StatementEnd
