-- +goose Up
CREATE TABLE public.auth_password_reset_requests (
    ip_hash text PRIMARY KEY CHECK (ip_hash ~ '^[0-9a-f]{64}$'),
    window_start timestamptz NOT NULL,
    requests integer NOT NULL CHECK (requests > 0)
);
CREATE TABLE public.auth_password_reset_deliveries (
    token_hash text PRIMARY KEY REFERENCES public.auth_email_tokens(token_hash) ON DELETE CASCADE,
    state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','sent','failed','cancelled')),
    secret_nonce bytea,
    secret_ciphertext bytea,
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
    next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    lease_token text,
    lease_until timestamptz,
    last_error_code text,
    delivered_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((state IN ('pending','sending') AND secret_nonce IS NOT NULL AND secret_ciphertext IS NOT NULL AND octet_length(secret_nonce)=12 AND octet_length(secret_ciphertext)>=16)
        OR (state NOT IN ('pending','sending') AND secret_nonce IS NULL AND secret_ciphertext IS NULL))
);
CREATE INDEX auth_password_reset_deliveries_due ON public.auth_password_reset_deliveries(next_attempt_at)
    WHERE state IN ('pending','sending');
CREATE INDEX auth_email_tokens_user_created ON public.auth_email_tokens(user_id,created_at DESC);
GRANT SELECT,INSERT,UPDATE,DELETE ON public.auth_password_reset_requests, public.auth_password_reset_deliveries TO podhub_app;
-- +goose StatementBegin
CREATE FUNCTION public.revoke_password_recovery() RETURNS trigger
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
CREATE TRIGGER account_users_revoke_password_recovery
AFTER UPDATE OF password_hash,email,disabled_at ON public.account_users FOR EACH ROW
WHEN (NEW.password_hash IS DISTINCT FROM OLD.password_hash OR NEW.email IS DISTINCT FROM OLD.email
      OR (NEW.disabled_at IS NOT NULL AND NEW.disabled_at IS DISTINCT FROM OLD.disabled_at))
EXECUTE FUNCTION public.revoke_password_recovery();
-- +goose StatementEnd

-- +goose Down
DROP TRIGGER account_users_revoke_password_recovery ON public.account_users;
DROP FUNCTION public.revoke_password_recovery();
DROP INDEX public.auth_email_tokens_user_created;
DROP TABLE public.auth_password_reset_deliveries;
DROP TABLE public.auth_password_reset_requests;
