-- +goose Up
-- declaration 326 OzonDeliveryMethods
-- Post-Rust append. Does not alter migrations 00001-00325.
-- Delivery-method cache. Field types that the verified list does not pin
-- are stored as text. No Api-Key column.
CREATE TABLE public.ozon_delivery_methods (
    org_id bigint NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
    store_id uuid NOT NULL,
    method_id bigint NOT NULL,
    warehouse_id bigint NOT NULL,
    name text NOT NULL,
    provider_id text NOT NULL DEFAULT '',
    template_id text NOT NULL DEFAULT '',
    cutoff text NOT NULL DEFAULT '',
    sla_cut_in text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT '',
    created_at text NOT NULL DEFAULT '',
    updated_at text NOT NULL DEFAULT '',
    synced_at timestamptz NOT NULL,
    PRIMARY KEY (org_id, store_id, method_id),
    CONSTRAINT ozon_delivery_methods_id_positive CHECK (method_id > 0),
    CONSTRAINT ozon_delivery_methods_warehouse_positive CHECK (warehouse_id > 0),
    CONSTRAINT ozon_delivery_methods_name_len CHECK (char_length(name) BETWEEN 1 AND 500)
);

CREATE INDEX ozon_delivery_methods_warehouse_idx
    ON public.ozon_delivery_methods (org_id, store_id, warehouse_id);

REVOKE ALL ON TABLE public.ozon_delivery_methods FROM PUBLIC, podhub_app, podhub_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ozon_delivery_methods TO podhub_app;

ALTER TABLE public.ozon_delivery_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ozon_delivery_methods FORCE ROW LEVEL SECURITY;

CREATE POLICY ozon_delivery_methods_tenant ON public.ozon_delivery_methods
    FOR ALL
    TO podhub_app
    USING (
        org_id IS NOT NULL
        AND org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    )
    WITH CHECK (
        org_id IS NOT NULL
        AND org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    );

-- +goose Down
SELECT 1;
