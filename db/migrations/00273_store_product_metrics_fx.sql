-- +goose Up
-- declaration 273 StoreProductMetricsFx m20261012_000053_store_product_metrics_fx
-- source: migration/src/store_product_metrics_fx.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.store_product_metrics
    ADD COLUMN fx_quote text,
    ADD COLUMN fx_rate double precision,
    ADD COLUMN fx_as_of date,
    ADD COLUMN fx_source text,
    ADD CONSTRAINT store_product_metrics_fx CHECK (
        (
            fx_quote IS NULL AND fx_rate IS NULL
            AND fx_as_of IS NULL AND fx_source IS NULL
        )
        OR (
            fx_quote ~ '^[A-Z]{3}$'
            AND fx_quote <> 'RUB'
            AND fx_rate > 0
            AND fx_rate <> 'NaN'::float8
            AND fx_rate < 'Infinity'::float8
            AND fx_as_of IS NOT NULL
            AND fx_source = 'cbr'
        )
    );
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
