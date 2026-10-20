-- +goose Up
-- declaration 335 StoreRatingSnapshot
-- Post-Rust append. Does not alter migrations 00001-00320.
-- The highest file on main at this branch point is 00320. 00335 leaves
-- 00321-00334 for other in-flight work. Snapshot rows are the latest
-- Seller rating per store. The sync row is only a short lease and the
-- last success time; readers do not lock it.
-- +goose StatementBegin
CREATE TABLE public.store_rating_snapshots (
    org_id bigint NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
    store_id uuid NOT NULL REFERENCES public.organization_stores (uuid) ON DELETE CASCADE,
    rating_key text NOT NULL,
    name text NOT NULL DEFAULT '',
    value_type text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT '',
    current_value numeric,
    past_value numeric,
    synced_at timestamptz NOT NULL,
    CONSTRAINT store_rating_snapshots_pkey PRIMARY KEY (org_id, store_id, rating_key),
    CONSTRAINT store_rating_snapshots_org CHECK (org_id > 0),
    CONSTRAINT store_rating_snapshots_key_len CHECK (char_length(rating_key) BETWEEN 1 AND 128),
    CONSTRAINT store_rating_snapshots_text_len CHECK (
        char_length(name) <= 400
        AND char_length(value_type) <= 64
        AND char_length(status) <= 64
    ),
    CONSTRAINT store_rating_snapshots_clean CHECK (
        rating_key !~* '(fixture-api-key|api[-_]?key|bearer |sk-|client[-_]?id|signature=|x-amz-)'
        AND name !~* '(fixture-api-key|api[-_]?key|bearer |sk-|client[-_]?id|signature=|x-amz-)'
        AND value_type !~* '(fixture-api-key|api[-_]?key|bearer |sk-|client[-_]?id|signature=|x-amz-)'
        AND status !~* '(fixture-api-key|api[-_]?key|bearer |sk-|client[-_]?id|signature=|x-amz-)'
    )
);

CREATE TABLE public.store_rating_sync (
    org_id bigint NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
    store_id uuid NOT NULL REFERENCES public.organization_stores (uuid) ON DELETE CASCADE,
    synced_at timestamptz,
    lease_until timestamptz,
    CONSTRAINT store_rating_sync_pkey PRIMARY KEY (org_id, store_id),
    CONSTRAINT store_rating_sync_org CHECK (org_id > 0)
);

CREATE INDEX store_rating_snapshots_store_idx
    ON public.store_rating_snapshots (org_id, store_id, rating_key);

REVOKE ALL ON TABLE public.store_rating_snapshots FROM PUBLIC;
REVOKE ALL ON TABLE public.store_rating_sync FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.store_rating_snapshots TO podhub_app, podhub_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.store_rating_sync TO podhub_app, podhub_worker;

ALTER TABLE public.store_rating_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_rating_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE public.store_rating_sync ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_rating_sync FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.store_rating_snapshots
    FOR ALL
    TO podhub_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint);

CREATE POLICY tenant_isolation ON public.store_rating_sync
    FOR ALL
    TO podhub_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint);
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
