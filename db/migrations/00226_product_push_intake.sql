-- +goose Up
-- declaration 226 StoreProductPushIntake m20260924_000408_product_push_intake
-- source: migration/src/store_product_push_intake.rs @ a03d735
-- +goose StatementBegin
CREATE UNLOGGED TABLE public.store_product_dirty (
    org_id     bigint NOT NULL REFERENCES public.organizations(id),
    store_pk   bigint NOT NULL REFERENCES public.organization_stores(id) ON DELETE CASCADE,
    product_id bigint NOT NULL,
    since_ms   bigint NOT NULL,
    CONSTRAINT store_product_dirty_pk PRIMARY KEY (store_pk, product_id)
);

ALTER TABLE public.store_product_dirty ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_product_dirty FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.store_product_dirty
    FOR ALL
    TO podhub_app
    USING (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    )
    WITH CHECK (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    );

-- The push intake writes with the tenant policy off (public endpoint, no
-- session) and the refresh reader spans orgs; both ride the worker role.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.store_product_dirty
    TO podhub_app, podhub_worker;

CREATE TABLE public.store_push_tokens (
    store_pk            bigint PRIMARY KEY REFERENCES public.organization_stores(id) ON DELETE CASCADE,
    org_id              bigint NOT NULL REFERENCES public.organizations(id),
    token_hash          bytea  NOT NULL,
    credential_revision bigint NOT NULL,
    created_at_ms       bigint NOT NULL
);

-- The intake looks a token up by its hash; uniqueness makes a hash collision
-- (32 bytes of SHA-256 output) a non-event in practice.
CREATE UNIQUE INDEX store_push_tokens_hash_uidx
    ON public.store_push_tokens (token_hash);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.store_push_tokens
    TO podhub_app, podhub_worker;

ALTER TABLE public.store_product_sync
    ADD COLUMN push_last_ping_at_ms bigint,
    ADD COLUMN push_last_event_at_ms bigint;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
