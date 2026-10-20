-- +goose Up
-- declaration 331 StoreSellerInfo
-- Post-Rust append. company.currency, company.country, and subscription
-- are stored. company.inn, company.ogrn, company.tax_system,
-- company.ownership_form, and ratings are not columns.
-- 00001-00330 are not edited. organization_stores stays without RLS.
-- +goose StatementBegin
ALTER TABLE public.organization_stores
    ADD COLUMN IF NOT EXISTS company_currency character varying(8),
    ADD COLUMN IF NOT EXISTS company_country character varying(8),
    ADD COLUMN IF NOT EXISTS subscription_is_premium boolean,
    ADD COLUMN IF NOT EXISTS subscription_type character varying(32),
    ADD COLUMN IF NOT EXISTS seller_info_synced_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS seller_key_status character varying(16) NOT NULL DEFAULT 'unknown',
    ADD COLUMN IF NOT EXISTS seller_key_reason character varying(16);

ALTER TABLE public.organization_stores
    DROP CONSTRAINT IF EXISTS ck_organization_stores_seller_key_status;

ALTER TABLE public.organization_stores
    ADD CONSTRAINT ck_organization_stores_seller_key_status
        CHECK (seller_key_status IN ('valid', 'invalid', 'unknown'));

ALTER TABLE public.organization_stores
    DROP CONSTRAINT IF EXISTS ck_organization_stores_seller_key_reason;

ALTER TABLE public.organization_stores
    ADD CONSTRAINT ck_organization_stores_seller_key_reason
        CHECK (
            seller_key_reason IS NULL
            OR seller_key_reason IN ('401', '403', '404', 'network', 'upstream', 'unparsed')
        );

GRANT UPDATE (
    company_currency,
    company_country,
    subscription_is_premium,
    subscription_type,
    seller_info_synced_at,
    seller_key_status,
    seller_key_reason,
    updated_at
) ON TABLE public.organization_stores TO podhub_app, podhub_worker;
-- +goose StatementEnd

-- +goose Down
-- Rust down() refuses a destructive rollback. This append follows that shape.
SELECT 1;
