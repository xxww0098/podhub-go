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
