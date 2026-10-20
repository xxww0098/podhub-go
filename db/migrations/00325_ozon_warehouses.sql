-- +goose Up
-- declaration 325 OzonWarehouses
-- Post-Rust append. Does not alter migrations 00001-00315.
-- Tenant cache of non-sensitive warehouse fields. No Api-Key column.
CREATE TABLE public.ozon_warehouses (
    org_id bigint NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
    store_id uuid NOT NULL,
    warehouse_id bigint NOT NULL,
    name text NOT NULL,
    ozon_status text NOT NULL DEFAULT '',
    is_rfbs boolean NOT NULL DEFAULT false,
    archived_at timestamptz,
    synced_at timestamptz NOT NULL,
    PRIMARY KEY (org_id, store_id, warehouse_id),
    CONSTRAINT ozon_warehouses_id_positive CHECK (warehouse_id > 0),
    CONSTRAINT ozon_warehouses_name_len CHECK (char_length(name) BETWEEN 1 AND 500),
    CONSTRAINT ozon_warehouses_status_len CHECK (char_length(ozon_status) <= 64)
);

REVOKE ALL ON TABLE public.ozon_warehouses FROM PUBLIC, podhub_app, podhub_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ozon_warehouses TO podhub_app;

ALTER TABLE public.ozon_warehouses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ozon_warehouses FORCE ROW LEVEL SECURITY;

CREATE POLICY ozon_warehouses_tenant ON public.ozon_warehouses
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
-- Rust down() refuses a destructive rollback. This append follows that shape.
SELECT 1;
