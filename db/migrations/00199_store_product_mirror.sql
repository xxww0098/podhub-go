-- +goose Up
-- declaration 199 StoreProductMirror m20260920_000336_store_product_mirror
-- source: migration/src/store_product_mirror.rs @ a03d735
-- +goose StatementBegin
CREATE TABLE public.store_product_sync (
    org_id                  bigint NOT NULL REFERENCES public.organizations(id),
    store_id                uuid PRIMARY KEY,
    refresh_generation      bigint NOT NULL,
    phase                   text NOT NULL,
    cursor_last_id          text,
    seen_total              bigint,
    fetched_total           bigint,
    probed_at_ms            bigint,
    probed_total            bigint,
    last_full_sync_at_ms    bigint,
    next_due_at_ms          bigint,
    manual_requested_at_ms  bigint,
    window_offset_min       smallint NOT NULL,
    calls_day_key           text,
    calls_today             integer NOT NULL DEFAULT 0,
    consecutive_failures    integer NOT NULL DEFAULT 0,
    cooldown_until_ms       bigint,
    price_stock_every_6h    boolean NOT NULL DEFAULT false,
    count_total             bigint,
    count_on_sale           bigint,
    count_hidden            bigint,
    count_moderation_failed bigint,
    count_zero_stock        bigint,
    count_archived          bigint,
    last_error              text,
    retry_at_ms             bigint,
    CONSTRAINT store_product_sync_generation CHECK (refresh_generation > 0),
    CONSTRAINT store_product_sync_phase CHECK (
        phase IN ('idle','probing','listing','detailing','pricing',
                  'done','failed','budget_exhausted','cooldown')
    ),
    -- `hash(store_id) % 240` — see src/store/product_sync/plan.rs.
    CONSTRAINT store_product_sync_window_offset CHECK (
        window_offset_min >= 0 AND window_offset_min < 240
    ),
    -- A row carries a whole summary or none of it: a half-written full sync
    -- would paint counts the Seller data never supported.
    CONSTRAINT store_product_sync_counts_shape CHECK (
        (
            count_total IS NULL AND count_on_sale IS NULL
            AND count_hidden IS NULL AND count_moderation_failed IS NULL
            AND count_zero_stock IS NULL AND count_archived IS NULL
        )
        OR (
            count_total >= 0 AND count_on_sale >= 0 AND count_hidden >= 0
            AND count_moderation_failed >= 0 AND count_zero_stock >= 0
            AND count_archived >= 0
        )
    ),
    -- The day key and its counter move together; NULL key means no calls
    -- recorded yet.
    CONSTRAINT store_product_sync_calls_shape CHECK (
        calls_today >= 0 AND (calls_day_key IS NULL) = (calls_today = 0)
    ),
    CONSTRAINT store_product_sync_failures CHECK (consecutive_failures >= 0),
    CONSTRAINT store_product_sync_retry_shape CHECK (
        retry_at_ms IS NULL OR (retry_at_ms > 0 AND last_error IS NOT NULL)
    )
);

-- The worker scans due rows across every org (podhub_worker is BYPASSRLS);
-- the partial index keeps that scan to scheduled stores only.
CREATE INDEX store_product_sync_due_idx
    ON public.store_product_sync (next_due_at_ms)
    WHERE next_due_at_ms IS NOT NULL;

CREATE INDEX store_product_sync_org_idx
    ON public.store_product_sync (org_id);

ALTER TABLE public.store_product_sync ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_product_sync FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.store_product_sync
    FOR ALL
    TO podhub_app
    USING (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    )
    WITH CHECK (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    );

GRANT SELECT, INSERT, UPDATE ON TABLE public.store_product_sync
    TO podhub_app, podhub_worker;

CREATE TABLE public.store_products (
    org_id             bigint NOT NULL REFERENCES public.organizations(id),
    store_id           uuid NOT NULL,
    product_id         bigint NOT NULL,
    offer_id           text NOT NULL,
    sku                bigint,
    name               text,
    primary_image      text,
    category_id        bigint,
    visible            boolean,
    archived           boolean,
    status_name        text,
    moderation_status  text,
    validation_state   text,
    price              numeric,
    old_price          numeric,
    currency           text,
    stock_present      integer,
    stock_reserved     integer,
    ozon_updated_at_ms bigint,
    listed_at_ms       bigint,
    detailed_at_ms     bigint,
    priced_at_ms       bigint,
    source             text NOT NULL,
    seen_generation    bigint NOT NULL,
    gone_at_ms         bigint,
    CONSTRAINT store_products_pk PRIMARY KEY (store_id, product_id),
    -- `seller_read` came from a Seller API read; `own_evidence` from one of our
    -- own write receipts. No third source: Listing never writes the mirror.
    CONSTRAINT store_products_source CHECK (source IN ('seller_read','own_evidence')),
    CONSTRAINT store_products_seen_generation CHECK (seen_generation > 0)
);

CREATE INDEX store_products_org_visibility_idx
    ON public.store_products (org_id, store_id, visible, archived);

CREATE INDEX store_products_org_offer_idx
    ON public.store_products (org_id, offer_id);

ALTER TABLE public.store_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_products FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.store_products
    FOR ALL
    TO podhub_app
    USING (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    )
    WITH CHECK (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    );

-- `gone_at_ms` rows are garbage-collected, so DELETE is part of the contract.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.store_products
    TO podhub_app, podhub_worker;

CREATE TABLE public.seller_read_incidents (
    id             bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    org_id         bigint NOT NULL REFERENCES public.organizations(id),
    store_id       uuid NOT NULL,
    client_id      text NOT NULL,
    path           text NOT NULL,
    status         smallint NOT NULL,
    retry_after_ms bigint,
    origin         text NOT NULL,
    at_ms          bigint NOT NULL
);

-- Breaker scans are time-windowed: deployment-level counts span every org on
-- `at_ms`; workspace-level counts use the org-prefixed index.
CREATE INDEX seller_read_incidents_at_idx
    ON public.seller_read_incidents (at_ms);

CREATE INDEX seller_read_incidents_org_at_idx
    ON public.seller_read_incidents (org_id, at_ms);

ALTER TABLE public.seller_read_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seller_read_incidents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.seller_read_incidents
    FOR ALL
    TO podhub_app
    USING (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    )
    WITH CHECK (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    );

-- Append-only signal ledger: readers never update or delete a row.
GRANT SELECT, INSERT ON TABLE public.seller_read_incidents
    TO podhub_app, podhub_worker;
GRANT USAGE, SELECT ON SEQUENCE public.seller_read_incidents_id_seq
    TO podhub_app, podhub_worker;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
