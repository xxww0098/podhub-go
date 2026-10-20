-- +goose Up
-- declaration 284 ProductGroupingObservations m20261014_000057_product_grouping_observations
-- source: migration/src/product_grouping_observations.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.seller_upstream_writes
    ADD COLUMN IF NOT EXISTS physical_account_key text,
    ADD COLUMN IF NOT EXISTS observation_state text,
    ADD COLUMN IF NOT EXISTS observation_items jsonb,
    ADD COLUMN IF NOT EXISTS observation_next_at timestamptz,
    ADD COLUMN IF NOT EXISTS observation_deadline_at timestamptz,
    ADD COLUMN IF NOT EXISTS observation_passes integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS observation_lease_token uuid,
    ADD COLUMN IF NOT EXISTS observation_lease_until timestamptz,
    ADD COLUMN IF NOT EXISTS observation_lease_epoch bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS observation_revision bigint,
    ADD COLUMN IF NOT EXISTS observation_model_id bigint;

-- The five verdicts slice 03 names. A NULL state is "this kind has no
-- effectiveness axis", which is every kind except the grouping one.
-- The IS NOT NULL guard is load-bearing: SQL's three-valued logic makes
-- NULL IN (...) unknown and a CHECK passes on unknown.
ALTER TABLE public.seller_upstream_writes
    ADD CONSTRAINT seller_upstream_writes_observation_state CHECK (
        observation_state IS NULL
        OR observation_state IN ('pending', 'applied', 'rejected', 'partial',
                                 'needs_review')),
    -- A live observation always names when it may run next; a terminal one
    -- never does. Without this, a terminal row could keep a due date and be
    -- re-read for ever.
    ADD CONSTRAINT seller_upstream_writes_observation_due CHECK (
        (observation_state IS NULL)
        OR (observation_state IN ('pending', 'partial')
            AND observation_next_at IS NOT NULL)
        OR (observation_state IN ('applied', 'rejected', 'needs_review')
            AND observation_next_at IS NULL)),
    ADD CONSTRAINT seller_upstream_writes_observation_passes CHECK (
        observation_passes >= 0),
    ADD CONSTRAINT seller_upstream_writes_observation_acronym CHECK (
        physical_account_key IS NULL
        OR physical_account_key ~ '^sha256:[0-9a-f]{64}$');

-- The scanner's own index: due rows of the only kinds that observe, in the
-- order they become due. Partial, so the unknown-write and dispatch scans
-- keep their own indexes and this one stays small.
CREATE INDEX IF NOT EXISTS seller_upstream_writes_observation_due_idx
    ON public.seller_upstream_writes (observation_next_at, updated_at)
    WHERE observation_state IN ('pending', 'partial');

-- The preview record: the frozen specification an operation quotes back by
-- digest. Short-lived by construction, so an operator who previews and comes
-- back much later re-previews instead of confirming stale facts.
CREATE TABLE public.product_variant_previews (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id               bigint NOT NULL REFERENCES public.organizations(id),
    store_pk             bigint NOT NULL REFERENCES public.organization_stores(id),
    digest               text NOT NULL CHECK (length(digest) BETWEEN 1 AND 128),
    -- The physical Seller account the preview was made against: a preview
    -- taken with another account must never execute (slice 03).
    physical_account_key text NOT NULL
        CHECK (physical_account_key ~ '^sha256:[0-9a-f]{64}$'),
    request              jsonb NOT NULL,
    created_at_ms        bigint NOT NULL
        DEFAULT (extract(epoch FROM clock_timestamp()) * 1000)::bigint,
    expires_at_ms        bigint NOT NULL,
    CONSTRAINT product_variant_previews_window CHECK (expires_at_ms > created_at_ms),
    CONSTRAINT product_variant_previews_request_shape CHECK (jsonb_typeof(request) = 'object')
);

-- One preview per (Workspace, store, digest): the lookup an operation makes.
CREATE UNIQUE INDEX product_variant_previews_digest_idx
    ON public.product_variant_previews (org_id, store_pk, digest);

-- Expired rows are pruned on the next preview of the same store.
CREATE INDEX product_variant_previews_expiry_idx
    ON public.product_variant_previews (expires_at_ms);

GRANT SELECT, INSERT, DELETE ON public.product_variant_previews TO podhub_app, podhub_worker;

ALTER TABLE public.product_variant_previews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_variant_previews FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.product_variant_previews;
CREATE POLICY tenant_isolation ON public.product_variant_previews
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
