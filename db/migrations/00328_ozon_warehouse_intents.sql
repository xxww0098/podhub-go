-- +goose Up
-- declaration 328 OzonWarehouseIntents
-- Post-Rust append. Browser-direct write intents. The partial unique index
-- is the in-flight fence for one warehouse. fence_warehouse_id 0 is the
-- store's create slot, not an Ozon warehouse id. No Api-Key column.
CREATE TABLE public.ozon_warehouse_intents (
    id uuid PRIMARY KEY,
    org_id bigint NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
    store_id uuid NOT NULL,
    user_id bigint NOT NULL,
    client_operation_id text NOT NULL,
    kind text NOT NULL,
    warehouse_id bigint,
    fence_warehouse_id bigint NOT NULL,
    confirm boolean NOT NULL DEFAULT false,
    state text NOT NULL,
    ozon_operation_id text,
    http_status integer,
    error_code text,
    request_hash text NOT NULL DEFAULT '',
    credential_granted_at timestamptz,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT ozon_warehouse_intents_kind CHECK (
        kind IN ('create', 'update', 'archive', 'unarchive', 'first_mile_update')
    ),
    CONSTRAINT ozon_warehouse_intents_state CHECK (
        state IN ('granted', 'accepted', 'rejected', 'unknown')
    ),
    CONSTRAINT ozon_warehouse_intents_client_op UNIQUE (org_id, store_id, client_operation_id),
    CONSTRAINT ozon_warehouse_intents_client_len CHECK (
        client_operation_id <> '' AND char_length(client_operation_id) <= 128
    ),
    CONSTRAINT ozon_warehouse_intents_hash_len CHECK (char_length(request_hash) <= 128),
    CONSTRAINT ozon_warehouse_intents_fence CHECK (
        (
            kind = 'create'
            AND fence_warehouse_id = 0
            AND warehouse_id IS NULL
        )
        OR (
            kind <> 'create'
            AND warehouse_id IS NOT NULL
            AND warehouse_id > 0
            AND fence_warehouse_id = warehouse_id
        )
    )
);

CREATE UNIQUE INDEX ozon_warehouse_intents_inflight
    ON public.ozon_warehouse_intents (org_id, store_id, fence_warehouse_id)
    WHERE state IN ('granted', 'unknown');

CREATE INDEX ozon_warehouse_intents_operation_idx
    ON public.ozon_warehouse_intents (org_id, store_id, ozon_operation_id)
    WHERE ozon_operation_id IS NOT NULL;

REVOKE ALL ON TABLE public.ozon_warehouse_intents FROM PUBLIC, podhub_app, podhub_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ozon_warehouse_intents TO podhub_app;

ALTER TABLE public.ozon_warehouse_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ozon_warehouse_intents FORCE ROW LEVEL SECURITY;

CREATE POLICY ozon_warehouse_intents_tenant ON public.ozon_warehouse_intents
    FOR ALL
    TO podhub_app
    USING (
        org_id IS NOT NULL
        AND org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    )
    WITH CHECK (
        org_id IS NOT NULL
        AND org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    );

-- +goose Down
SELECT 1;
