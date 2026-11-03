-- +goose Up
CREATE TABLE public.store_listing_policies (
    org_id bigint NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    store_id bigint PRIMARY KEY REFERENCES public.organization_stores(id) ON DELETE CASCADE,
    daily_cap integer CHECK (daily_cap BETWEEN 1 AND 1000000),
    min_gap_seconds integer NOT NULL DEFAULT 0 CHECK (min_gap_seconds BETWEEN 0 AND 86400),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.store_listing_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_listing_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY store_listing_policy_tenant ON public.store_listing_policies TO podhub_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.store_listing_policies TO podhub_app;
GRANT SELECT ON public.store_listing_policies TO podhub_worker;

CREATE INDEX seller_import_store_dispatch_time ON public.seller_upstream_writes(org_id, store_id, created_at)
    WHERE kind = 'import' AND error_code IS DISTINCT FROM 'not_dispatched';

-- +goose Down
DROP INDEX public.seller_import_store_dispatch_time;
DROP TABLE public.store_listing_policies;
