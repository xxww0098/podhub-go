-- +goose Up
CREATE TABLE public.user_slice_storage (
    id uuid PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES public.account_users(id) ON DELETE CASCADE,
    endpoint text NOT NULL,
    bucket text NOT NULL,
    public_base_url text NOT NULL,
    access_key_hint text NOT NULL,
    secret_nonce bytea NOT NULL,
    secret_ciphertext bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    retired_at timestamptz
);
CREATE UNIQUE INDEX user_slice_storage_active ON public.user_slice_storage(user_id) WHERE retired_at IS NULL;
ALTER TABLE public.user_slice_storage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_slice_storage FORCE ROW LEVEL SECURITY;
CREATE POLICY user_slice_storage_self ON public.user_slice_storage TO podhub_app
    USING (user_id::text = current_setting('app.slice_storage_user_id', true))
    WITH CHECK (user_id::text = current_setting('app.slice_storage_user_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_slice_storage TO podhub_app;
GRANT SELECT, UPDATE ON public.user_slice_storage TO podhub_worker;
GRANT SELECT, INSERT, UPDATE ON public.transit_clear_runs TO podhub_worker;

CREATE TABLE public.user_slice_clear_requests (
    id uuid PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES public.account_users(id) ON DELETE CASCADE,
    storage_id uuid NOT NULL REFERENCES public.user_slice_storage(id) ON DELETE CASCADE,
    requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    finished_at timestamptz,
    error_code text
);
CREATE UNIQUE INDEX user_slice_clear_pending ON public.user_slice_clear_requests(storage_id) WHERE finished_at IS NULL;
ALTER TABLE public.user_slice_clear_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_slice_clear_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY user_slice_clear_self ON public.user_slice_clear_requests TO podhub_app
    USING (user_id::text = current_setting('app.slice_storage_user_id', true))
    WITH CHECK (user_id::text = current_setting('app.slice_storage_user_id', true));
GRANT SELECT, INSERT ON public.user_slice_clear_requests TO podhub_app;
GRANT SELECT, UPDATE ON public.user_slice_clear_requests TO podhub_worker;

-- +goose Down
DROP TABLE public.user_slice_clear_requests;
DROP TABLE public.user_slice_storage;
