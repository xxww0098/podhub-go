-- +goose Up
-- declaration 282 SellerResourceOccupancies m20261014_000055_seller_resource_occupancies
-- source: migration/src/seller_resource_occupancies.rs @ a03d735
-- +goose StatementBegin
CREATE TABLE public.seller_resource_occupancies (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id               bigint NOT NULL REFERENCES public.organizations(id),
    store_pk             bigint NOT NULL REFERENCES public.organization_stores(id),
    physical_account_key text NOT NULL
        CHECK (length(physical_account_key) BETWEEN 1 AND 128),
    resource_kind        text NOT NULL
        CHECK (resource_kind IN ('offer', 'model', 'group_rule')),
    resource_key         text NOT NULL
        CHECK (length(resource_key) BETWEEN 1 AND 512),
    owner_kind           text NOT NULL
        CHECK (owner_kind IN ('store_write', 'listing_association')),
    owner_ref            text NOT NULL
        CHECK (length(owner_ref) BETWEEN 1 AND 512),
    members              jsonb NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(members) = 'array'),
    spec_digest          text NOT NULL
        CHECK (length(spec_digest) BETWEEN 1 AND 128),
    state                text NOT NULL DEFAULT 'held'
        CHECK (state IN ('held', 'released')),
    created_at_ms        bigint NOT NULL
        DEFAULT (extract(epoch FROM clock_timestamp()) * 1000)::bigint,
    released_at_ms       bigint,
    release_reason       text,
    -- The IS NOT NULL guard below is load-bearing: SQL's three-valued logic
    -- makes NULL IN (...) unknown, and a CHECK passes on unknown — without it
    -- a released row could carry no reason at all.
    CONSTRAINT seller_resource_occupancies_release_complete CHECK (
        (state = 'held' AND released_at_ms IS NULL AND release_reason IS NULL)
        OR (state = 'released' AND released_at_ms IS NOT NULL
            AND release_reason IS NOT NULL
            AND release_reason IN ('not_dispatched', 'rejected_no_pending',
                                   'relationship_confirmed', 'partial_settled')))
);

-- The mutex. No expiry column on purpose: an unknown write is never released
-- by the clock — only one of the four terminal reasons above releases it.
CREATE UNIQUE INDEX seller_resource_occupancies_held_key_idx
    ON public.seller_resource_occupancies
       (physical_account_key, resource_kind, resource_key)
    WHERE state = 'held';

-- "Everything this operation still holds" — release and continuation both
-- start here rather than from a remembered key list.
CREATE INDEX seller_resource_occupancies_owner_idx
    ON public.seller_resource_occupancies (org_id, owner_kind, owner_ref)
    WHERE state = 'held';

GRANT SELECT, INSERT, UPDATE ON public.seller_resource_occupancies TO podhub_app, podhub_worker;

ALTER TABLE public.seller_resource_occupancies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seller_resource_occupancies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.seller_resource_occupancies;
CREATE POLICY tenant_isolation ON public.seller_resource_occupancies
    FOR ALL
    TO podhub_app
    USING (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    )
    WITH CHECK (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    );
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
