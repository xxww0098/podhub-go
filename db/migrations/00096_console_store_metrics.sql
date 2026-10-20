-- +goose Up
-- declaration 96 ConsoleStoreMetrics m20260902_000254_console_store_metrics
-- source: migration/src/console_store_metrics.rs @ a03d735
-- +goose StatementBegin
CREATE TABLE public.console_store_metrics (
    org_id                     bigint NOT NULL REFERENCES public.organizations(id),
    store_id                   uuid PRIMARY KEY,
    refresh_generation         bigint NOT NULL,
    ordered_units_30d          double precision,
    previous_ordered_units_30d double precision,
    day_series_14d             double precision[],
    through_day                text,
    last_sync_at_ms            bigint,
    last_error                 text,
    retry_at_ms                bigint,
    CONSTRAINT console_store_metrics_generation CHECK (refresh_generation > 0),
    -- A row carries a whole snapshot or none of it. A half-written refresh
    -- would paint a trend line the Seller data never supported.
    CONSTRAINT console_store_metrics_snapshot_shape CHECK (
        (
            ordered_units_30d IS NULL AND day_series_14d IS NULL
            AND through_day IS NULL AND last_sync_at_ms IS NULL
        )
        OR (
            ordered_units_30d >= 0
            AND array_length(day_series_14d, 1) = 14
            AND through_day <> ''
            AND last_sync_at_ms > 0
        )
    ),
    -- The previous period only means something next to a current one.
    CONSTRAINT console_store_metrics_previous_shape CHECK (
        previous_ordered_units_30d IS NULL
        OR (previous_ordered_units_30d >= 0 AND ordered_units_30d IS NOT NULL)
    ),
    CONSTRAINT console_store_metrics_retry_shape CHECK (
        retry_at_ms IS NULL OR (retry_at_ms > 0 AND last_error IS NOT NULL)
    )
);

CREATE INDEX console_store_metrics_org_idx
    ON public.console_store_metrics (org_id);

ALTER TABLE public.console_store_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.console_store_metrics FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.console_store_metrics
    FOR ALL
    TO podhub_app
    USING (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    )
    WITH CHECK (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    );

GRANT SELECT, INSERT, UPDATE ON TABLE public.console_store_metrics
    TO podhub_app, podhub_worker;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
