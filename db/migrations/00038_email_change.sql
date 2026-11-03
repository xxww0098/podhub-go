-- +goose Up
ALTER TABLE public.account_users ADD COLUMN session_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE public.auth_email_tokens ADD COLUMN new_email text;
ALTER TABLE public.auth_email_tokens DROP CONSTRAINT ck_auth_email_tokens_purpose;
ALTER TABLE public.auth_email_tokens ADD CONSTRAINT ck_auth_email_tokens_purpose
    CHECK ((purpose = 'reset' AND new_email IS NULL) OR (purpose = 'change_email' AND new_email IS NOT NULL));

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION public.revoke_password_recovery() RETURNS trigger
LANGUAGE plpgsql SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
    UPDATE public.auth_email_tokens SET consumed_at=clock_timestamp()
    WHERE user_id=NEW.id AND consumed_at IS NULL;
    UPDATE public.auth_password_reset_deliveries d
    SET state='cancelled', secret_nonce=NULL, secret_ciphertext=NULL,
        lease_token=NULL, lease_until=NULL, last_error_code='credentials_changed', updated_at=clock_timestamp()
    FROM public.auth_email_tokens t
    WHERE t.token_hash=d.token_hash AND t.user_id=NEW.id AND d.state IN ('pending','sending');
    RETURN NEW;
END;
$$;
-- +goose StatementEnd

-- +goose Down
DELETE FROM public.auth_email_tokens WHERE purpose='change_email';
ALTER TABLE public.auth_email_tokens DROP CONSTRAINT ck_auth_email_tokens_purpose;
ALTER TABLE public.auth_email_tokens ADD CONSTRAINT ck_auth_email_tokens_purpose CHECK (purpose='reset');
ALTER TABLE public.auth_email_tokens DROP COLUMN new_email;
ALTER TABLE public.account_users DROP COLUMN session_revision;
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION public.revoke_password_recovery() RETURNS trigger
LANGUAGE plpgsql SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
    UPDATE public.auth_email_tokens SET consumed_at=clock_timestamp()
    WHERE user_id=NEW.id AND purpose='reset' AND consumed_at IS NULL;
    UPDATE public.auth_password_reset_deliveries d
    SET state='cancelled', secret_nonce=NULL, secret_ciphertext=NULL,
        lease_token=NULL, lease_until=NULL, last_error_code='credentials_changed', updated_at=clock_timestamp()
    FROM public.auth_email_tokens t
    WHERE t.token_hash=d.token_hash AND t.user_id=NEW.id AND d.state IN ('pending','sending');
    RETURN NEW;
END;
$$;
-- +goose StatementEnd
