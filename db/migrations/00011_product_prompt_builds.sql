-- +goose Up
CREATE TABLE public.prompt_build_samples (
    id uuid PRIMARY KEY,
    org_id bigint NOT NULL REFERENCES public.organizations(id),
    source_id text NOT NULL REFERENCES public.sc_sources(source_id) ON DELETE CASCADE,
    product_id text NOT NULL REFERENCES public.sc_products(product_id) ON DELETE CASCADE,
    name text NOT NULL,
    sha256 text NOT NULL,
    mime text NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp')),
    pixels bytea NOT NULL CHECK (octet_length(pixels) BETWEEN 1 AND 4194304),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX prompt_build_samples_product ON public.prompt_build_samples(org_id,product_id,created_at DESC);
CREATE TABLE public.prompt_build_runs (
    id uuid PRIMARY KEY,
    org_id bigint NOT NULL REFERENCES public.organizations(id),
    source_id text NOT NULL REFERENCES public.sc_sources(source_id) ON DELETE CASCADE,
    product_id text NOT NULL REFERENCES public.sc_products(product_id) ON DELETE CASCADE,
    operation_key text NOT NULL,
    data jsonb NOT NULL,
    cancel_requested boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(org_id,product_id,operation_key)
);
CREATE INDEX prompt_build_runs_product ON public.prompt_build_runs(org_id,product_id,created_at DESC);
ALTER TABLE public.prompt_build_samples ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prompt_build_samples FORCE ROW LEVEL SECURITY;
ALTER TABLE public.prompt_build_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prompt_build_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY prompt_build_samples_tenant ON public.prompt_build_samples TO podhub_app
 USING (org_id=NULLIF(current_setting('app.current_org_id',true),'')::bigint)
 WITH CHECK (org_id=NULLIF(current_setting('app.current_org_id',true),'')::bigint);
CREATE POLICY prompt_build_runs_tenant ON public.prompt_build_runs TO podhub_app
 USING (org_id=NULLIF(current_setting('app.current_org_id',true),'')::bigint)
 WITH CHECK (org_id=NULLIF(current_setting('app.current_org_id',true),'')::bigint);
GRANT SELECT,INSERT,UPDATE,DELETE ON public.prompt_build_runs,public.prompt_build_samples TO podhub_app;

-- +goose Down
DROP TABLE public.prompt_build_runs;
DROP TABLE public.prompt_build_samples;
