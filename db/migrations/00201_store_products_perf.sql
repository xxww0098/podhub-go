-- +goose Up
-- declaration 201 StoreProductsPerf m20260921_074152_store_products_perf
-- source: migration/src/store_products_perf.rs @ a03d735
-- +goose StatementBegin
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Mirrors the `q` predicate: `lower(offer_id || ' ' || coalesce(name, ''))
-- LIKE '%' || escaped || '%'` over live rows only.
CREATE INDEX store_products_search_trgm_idx
    ON public.store_products USING gin
    (lower(offer_id || ' ' || coalesce(name, '')) gin_trgm_ops)
    WHERE gone_at_ms IS NULL;

-- The console's per-store `MAX(priced_at_ms)` is the last leaf of this
-- range — index-only, no heap pass over the store's rows.
CREATE INDEX store_products_priced_max_idx
    ON public.store_products (org_id, store_id, priced_at_ms DESC)
    WHERE gone_at_ms IS NULL AND priced_at_ms IS NOT NULL;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
