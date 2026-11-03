-- +goose Up
DROP TABLE IF EXISTS public.saved_product_views;

-- +goose Down
CREATE TABLE public.saved_product_views (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id bigint NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    user_id bigint NOT NULL REFERENCES public.account_users(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
    filter jsonb NOT NULL CHECK (jsonb_typeof(filter) = 'object'),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (org_id, user_id, name)
);
ALTER TABLE public.saved_product_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saved_product_views FORCE ROW LEVEL SECURITY;
CREATE POLICY saved_product_views_tenant ON public.saved_product_views TO podhub_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.saved_product_views TO podhub_app;
