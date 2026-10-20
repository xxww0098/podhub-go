-- +goose Up
-- declaration 330 StoreCompanyNames
-- Post-Rust append. Display names can be filled from Ozon company.name.
-- company.legal_name is the grouping key. company.inn and company.ogrn
-- are not columns. 00001-00315 are not edited. organization_stores stays
-- without row level security; existing readers do not set the tenant GUC.
-- +goose StatementBegin
ALTER TABLE public.organization_stores
    ADD COLUMN IF NOT EXISTS company_short_name character varying(255),
    ADD COLUMN IF NOT EXISTS company_legal_name character varying(512),
    ADD COLUMN IF NOT EXISTS name_source character varying(16) NOT NULL DEFAULT 'auto';

ALTER TABLE public.organization_stores
    DROP CONSTRAINT IF EXISTS ck_organization_stores_name_source;

ALTER TABLE public.organization_stores
    ADD CONSTRAINT ck_organization_stores_name_source
        CHECK (name_source IN ('auto', 'manual'));

CREATE INDEX IF NOT EXISTS ix_organization_stores_company_legal
    ON public.organization_stores (org_id, company_legal_name);

GRANT UPDATE (
    name,
    company_short_name,
    company_legal_name,
    name_source,
    updated_at
) ON TABLE public.organization_stores TO podhub_app, podhub_worker;
-- +goose StatementEnd

-- +goose Down
-- Rust down() refuses a destructive rollback. This append follows that shape.
SELECT 1;
