-- +goose Up
-- declaration 90 SellerUpstreamWrites m20260901_000249_seller_upstream_writes
-- source: migration/src/seller_upstream_writes.rs @ a03d735
-- +goose StatementBegin
CREATE TABLE public.seller_upstream_writes (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                bigint NOT NULL REFERENCES public.organizations(id),
    store_id              bigint NOT NULL REFERENCES public.organization_stores(id),
    idempotency_key       text NOT NULL,
    request_hash          text NOT NULL,
    state                 text NOT NULL DEFAULT 'dispatching',
    response_status       smallint,
    response_content_type text,
    response_retry_after  text,
    response_body         bytea,
    created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT seller_upstream_writes_key_nonempty CHECK (
        char_length(idempotency_key) BETWEEN 1 AND 512
    ),
    CONSTRAINT seller_upstream_writes_state_known CHECK (
        state IN ('dispatching', 'settled')
    ),
    CONSTRAINT seller_upstream_writes_response_shape CHECK (
        (state = 'dispatching' AND response_status IS NULL AND response_body IS NULL)
        OR
        (state = 'settled' AND response_status BETWEEN 100 AND 599 AND response_body IS NOT NULL)
    ),
    CONSTRAINT seller_upstream_writes_idempotency UNIQUE (
        org_id, store_id, idempotency_key
    )
);

ALTER TABLE public.seller_upstream_writes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seller_upstream_writes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.seller_upstream_writes
    FOR ALL
    TO podhub_app
    USING (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    )
    WITH CHECK (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    );

GRANT SELECT, INSERT, UPDATE ON TABLE public.seller_upstream_writes
    TO podhub_app, podhub_worker;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
