-- +goose Up
-- declaration 23 TombstoneConsumptions m20260805_000051_tombstone_consumptions
-- source: migration/src/tombstone_consumptions.rs @ a03d735
-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS public.store_tombstone_consumptions (
    org_id bigint NOT NULL REFERENCES public.organizations(id),
    store_id bigint NOT NULL REFERENCES public.organization_stores(id),
    device_id bigint NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
    consumed_at_ms bigint NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT store_tombstone_consumptions_pkey
        PRIMARY KEY (org_id, store_id, device_id),
    CONSTRAINT ck_store_tombstone_consumptions_consumed_at_ms
        CHECK (consumed_at_ms >= 0)
);
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
