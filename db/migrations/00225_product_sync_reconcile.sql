-- +goose Up
-- declaration 225 StoreProductSyncReconcile m20260924_000407_product_sync_reconcile
-- source: migration/src/store_product_sync_reconcile.rs @ a03d735
-- +goose StatementBegin
CREATE UNLOGGED TABLE public.store_product_pass_pages (
    store_pk       bigint  NOT NULL REFERENCES public.organization_stores(id) ON DELETE CASCADE,
    generation     bigint  NOT NULL,
    page_no        integer NOT NULL,
    archived       boolean NOT NULL,
    product_ids    bigint[] NOT NULL,
    detailed_at_ms bigint,
    CONSTRAINT store_product_pass_pages_pk
        PRIMARY KEY (store_pk, generation, page_no),
    CONSTRAINT store_product_pass_pages_generation CHECK (generation > 0)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.store_product_pass_pages
    TO podhub_app, podhub_worker;

ALTER TABLE public.store_product_sync
    ADD COLUMN pass_pages_live integer NOT NULL DEFAULT 0,
    ADD COLUMN pass_pages_archived integer NOT NULL DEFAULT 0;

ALTER TABLE public.store_product_sync DROP CONSTRAINT store_product_sync_hold_reason;
ALTER TABLE public.store_product_sync ADD CONSTRAINT store_product_sync_hold_reason
    CHECK (hold_reason IS NULL OR hold_reason IN (
        'rate_limited','generation_expired','credential_revoked',
        'credential_expired','ip_restricted','workspace_breaker',
        'deployment_breaker','egress_blocked','store_busy','seller_error',
        'budget_exhausted','store_disabled','staging_lost'
    ));

UPDATE public.store_product_sync
   SET next_due_at_ms = COALESCE(next_due_at_ms, 0)
 WHERE next_due_at_ms IS NULL;

ALTER TABLE public.store_product_sync
    DROP COLUMN probed_total,
    DROP COLUMN probed_at_ms,
    DROP COLUMN window_offset_min,
    DROP COLUMN price_stock_every_6h;

DROP INDEX IF EXISTS public.store_product_sync_due_idx;
CREATE INDEX store_product_sync_due_idx
    ON public.store_product_sync (next_due_at_ms)
    WHERE next_due_at_ms IS NOT NULL;

ALTER TABLE public.store_products
    DROP COLUMN listed_at_ms,
    DROP COLUMN detailed_at_ms,
    DROP COLUMN priced_at_ms,
    DROP COLUMN seen_generation;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
