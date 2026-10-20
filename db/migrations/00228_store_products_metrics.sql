-- +goose Up
-- declaration 228 StoreProductsMetrics m20260925_000410_store_products_metrics
-- source: migration/src/store_products_metrics.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.store_products ADD COLUMN primary_image text;

CREATE TABLE public.store_product_metrics (
    org_id             bigint    NOT NULL REFERENCES public.organizations(id),
    store_pk           bigint    NOT NULL REFERENCES public.organization_stores(id)
                                 ON DELETE CASCADE,
    sku                bigint    NOT NULL,
    hits_view          double precision NOT NULL,
    session_view       double precision NOT NULL,
    hits_tocart        double precision NOT NULL,
    conv_tocart        double precision NOT NULL,
    ordered_units      double precision NOT NULL,
    revenue            double precision NOT NULL,
    period_days        smallint  NOT NULL,
    through_day        date      NOT NULL,
    fetched_at_ms      bigint    NOT NULL,
    fetched_generation bigint    NOT NULL,
    CONSTRAINT store_product_metrics_pk PRIMARY KEY (store_pk, sku),
    -- `>= 0` alone admits NaN and +Infinity (float8 sorts NaN above every
    -- number), so every metric column rejects both explicitly; -Infinity
    -- already fails the `>= 0` arm.
    CONSTRAINT store_product_metrics_nonneg CHECK (
        hits_view >= 0 AND hits_view <> 'NaN'::float8 AND hits_view < 'Infinity'::float8
        AND session_view >= 0 AND session_view <> 'NaN'::float8
        AND session_view < 'Infinity'::float8
        AND hits_tocart >= 0 AND hits_tocart <> 'NaN'::float8
        AND hits_tocart < 'Infinity'::float8
        AND conv_tocart >= 0 AND conv_tocart <> 'NaN'::float8
        AND conv_tocart < 'Infinity'::float8
        AND ordered_units >= 0 AND ordered_units <> 'NaN'::float8
        AND ordered_units < 'Infinity'::float8
        AND revenue >= 0 AND revenue <> 'NaN'::float8
        AND revenue < 'Infinity'::float8
    )
);

ALTER TABLE public.store_product_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_product_metrics FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.store_product_metrics
    FOR ALL
    TO podhub_app
    USING (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    )
    WITH CHECK (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    );

-- Whole-slice replace on every landed page: DELETE prunes SKUs the mirror no
-- longer knows, so DELETE is part of the contract.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.store_product_metrics
    TO podhub_app, podhub_worker;

ALTER TABLE public.store_product_sync
    ADD COLUMN metrics_offset bigint NOT NULL DEFAULT 0,
    ADD COLUMN metrics_at_ms bigint,
    ADD COLUMN metrics_error text,
    ADD CONSTRAINT store_product_sync_metrics_error CHECK (
        metrics_error IS NULL OR metrics_error IN
        ('rate_limited', 'restricted', 'refused', 'invalid', 'unavailable')
    );
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
