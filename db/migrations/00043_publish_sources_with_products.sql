-- +goose Up
-- Previously published products become visible without a separate source switch.
UPDATE public.sc_sources AS source
   SET listed = true,
       revision = revision + 1,
       updated_at_ms = (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint
 WHERE NOT source.listed
   AND EXISTS (
       SELECT 1
         FROM public.sc_products AS product
         JOIN public.sc_skus AS sku ON sku.product_id = product.product_id
        WHERE product.source_id = source.source_id
          AND product.published AND sku.published AND NOT product.archived
   );

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
    RAISE EXCEPTION 'Cannot infer which published sources were hidden before migration';
END $$;
-- +goose StatementEnd
