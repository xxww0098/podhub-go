-- +goose Up
-- declaration 177 MediaLeaseStorageRevision m20260916_000316_media_lease_storage_revision
-- source: migration/src/media_lease_storage_revision.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.media_object_leases
    ADD COLUMN IF NOT EXISTS storage_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE public.media_object_leases
    DROP CONSTRAINT IF EXISTS media_object_leases_storage_revision_nonnegative;
ALTER TABLE public.media_object_leases
    ADD CONSTRAINT media_object_leases_storage_revision_nonnegative
        CHECK (storage_revision >= 0);
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
