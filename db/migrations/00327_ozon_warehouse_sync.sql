-- +goose Up
-- declaration 327 OzonWarehouseSync
-- Post-Rust append. Last successful sync timestamps for one store.
CREATE TABLE public.ozon_warehouse_sync (
    org_id bigint NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
    store_id uuid NOT NULL,
    warehouses_synced_at timestamptz,
    methods_synced_at timestamptz,
    PRIMARY KEY (org_id, store_id)
);

REVOKE ALL ON TABLE public.ozon_warehouse_sync FROM PUBLIC, podhub_app, podhub_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ozon_warehouse_sync TO podhub_app;

ALTER TABLE public.ozon_warehouse_sync ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ozon_warehouse_sync FORCE ROW LEVEL SECURITY;

CREATE POLICY ozon_warehouse_sync_tenant ON public.ozon_warehouse_sync
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
