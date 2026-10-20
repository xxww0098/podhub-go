-- +goose Up
-- declaration 265 SupplierAggregateRevisions m20261004_000448_supplier_aggregate_revisions
-- source: migration/src/supplier_aggregate_revisions.rs @ a03d735
-- +goose StatementBegin
LOCK TABLE public.sc_products,public.sc_skus IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE anomalies text;
BEGIN
    SELECT string_agg(product_id || ':' || sku_count::text, ', ') INTO anomalies FROM (
        SELECT p.product_id,count(s.id) AS sku_count FROM public.sc_products p
        LEFT JOIN public.sc_skus s ON s.product_id=p.product_id WHERE NOT p.archived
        GROUP BY p.product_id HAVING count(s.id)<>1 ORDER BY p.product_id LIMIT 20
    ) bad;
    IF anomalies IS NOT NULL THEN
        RAISE EXCEPTION 'supplier single-SKU preflight rejected non-archived products (product:count): %', anomalies;
    END IF;
    SELECT string_agg(product_id || ':' || sku_count::text, ', ') INTO anomalies FROM (
        SELECT product_id,count(*) AS sku_count FROM public.sc_skus
        GROUP BY product_id HAVING count(*)>1 ORDER BY product_id LIMIT 20
    ) bad;
    IF anomalies IS NOT NULL THEN
        RAISE EXCEPTION 'supplier single-SKU uniqueness rejected historical products (product:count): %', anomalies;
    END IF;
END;
$$;
ALTER TABLE public.sc_sources
    ADD COLUMN revision bigint NOT NULL DEFAULT 1,
    ADD COLUMN schema_revision bigint NOT NULL DEFAULT 1,
    ADD CONSTRAINT sc_sources_revision_positive CHECK (revision>=1),
    ADD CONSTRAINT sc_sources_schema_revision_positive CHECK (schema_revision>=1);
ALTER TABLE public.sc_source_prop_defs
    ADD COLUMN revision bigint NOT NULL DEFAULT 1,
    ADD CONSTRAINT sc_source_prop_defs_revision_positive CHECK (revision>=1);
ALTER TABLE public.sc_skus ADD CONSTRAINT sc_skus_product_unique UNIQUE(product_id);
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
