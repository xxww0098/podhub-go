-- +goose Up
-- declaration 329 OzonWarehouseFences
-- Post-Rust append. One row per warehouse (or the create slot 0) is locked
-- with INSERT .. ON CONFLICT DO UPDATE before an intent is inserted, so
-- concurrent writers of the same warehouse queue on a single row.
CREATE TABLE public.ozon_warehouse_fences (
    org_id bigint NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
    store_id uuid NOT NULL,
    warehouse_id bigint NOT NULL,
    PRIMARY KEY (org_id, store_id, warehouse_id),
    CONSTRAINT ozon_warehouse_fences_id_nonneg CHECK (warehouse_id >= 0)
);

REVOKE ALL ON TABLE public.ozon_warehouse_fences FROM PUBLIC, podhub_app, podhub_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ozon_warehouse_fences TO podhub_app;

ALTER TABLE public.ozon_warehouse_fences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ozon_warehouse_fences FORCE ROW LEVEL SECURITY;

CREATE POLICY ozon_warehouse_fences_tenant ON public.ozon_warehouse_fences
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
