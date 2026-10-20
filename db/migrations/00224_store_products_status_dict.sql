-- +goose Up
-- declaration 224 StoreProductsStatusDict m20260924_000406_store_products_status_dict
-- source: migration/src/store_products_status_dict.rs @ a03d735
-- +goose StatementBegin
CREATE TABLE public.ozon_product_status (
    id                smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    is_archived       boolean  NOT NULL,
    status            text     NOT NULL,
    status_name       text     NOT NULL,
    moderate_status   text     NOT NULL,
    validation_status text     NOT NULL,
    state             text     NOT NULL CHECK (state IN
                        ('on_sale','processing','moderation_failed','hidden','archived')),
    CONSTRAINT ozon_product_status_combo UNIQUE
                        (is_archived, status, status_name, moderate_status, validation_status)
);

-- Global dictionary, not tenant data: no RLS tenant policy. Both roles
-- write — the worker on the sync path, the app on the verify path's first
-- sight of a combination — and both read. Rows are only classifications.
GRANT SELECT, INSERT, UPDATE ON TABLE public.ozon_product_status
    TO podhub_app, podhub_worker;
GRANT USAGE, SELECT ON SEQUENCE public.ozon_product_status_id_seq
    TO podhub_app, podhub_worker;

ALTER TABLE public.store_products
    ADD COLUMN status_id smallint REFERENCES public.ozon_product_status(id),
    ADD COLUMN content_hash bigint NOT NULL DEFAULT 0,
    ADD COLUMN refreshed_at_ms bigint,
    ADD COLUMN evidence_at_ms bigint,
    ADD COLUMN store_pk bigint;

-- The store-level currency (C11): one value per account, not per row.
ALTER TABLE public.store_product_sync ADD COLUMN currency text;

UPDATE public.store_products p
   SET status_id = d.id,
       store_pk = s.id
  FROM public.ozon_product_status d,
       public.organization_stores s
 WHERE COALESCE(p.archived, false) = d.is_archived
   AND d.status = ''
   AND COALESCE(p.status_name, '') = d.status_name
   AND COALESCE(p.moderation_status, '') = d.moderate_status
   AND COALESCE(p.validation_state, '') = d.validation_status
   AND s.uuid = p.store_id AND s.org_id = p.org_id;

UPDATE public.store_product_sync sync
   SET currency = picked.currency
  FROM (
      SELECT store_id, max(currency) AS currency
      FROM public.store_products
      WHERE currency IS NOT NULL
      GROUP BY store_id
  ) picked
 WHERE picked.store_id = sync.store_id
   AND sync.currency IS NULL;

DELETE FROM public.store_products
 WHERE store_pk IS NULL;

ALTER TABLE public.store_products
    DROP CONSTRAINT store_products_pk,
    DROP COLUMN primary_image,
    DROP COLUMN category_id,
    DROP COLUMN ozon_updated_at_ms,
    DROP COLUMN currency,
    DROP COLUMN status_name,
    DROP COLUMN moderation_status,
    DROP COLUMN validation_state,
    DROP COLUMN visible,
    DROP COLUMN archived,
    DROP COLUMN source,
    DROP COLUMN store_id,
    ADD CONSTRAINT store_products_pk PRIMARY KEY (store_pk, product_id),
    ADD CONSTRAINT store_products_store_fk
        FOREIGN KEY (store_pk) REFERENCES public.organization_stores(id);

-- Hot updates prune per-page: leave room for HTOP-style stubs (§4 体积估算).
ALTER TABLE public.store_products SET (fillfactor = 90);

DROP INDEX IF EXISTS public.store_products_org_visibility_idx;
DROP INDEX IF EXISTS public.store_products_org_offer_idx;
CREATE INDEX store_products_state_idx
    ON public.store_products (store_pk, status_id)
    WHERE gone_at_ms IS NULL;
CREATE INDEX store_products_offer_idx
    ON public.store_products (store_pk, offer_id);
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
