-- +goose Up
-- declaration 178 MediaLeaseBatch m20260916_000317_media_lease_batch
-- source: migration/src/media_lease_batch.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.media_object_leases
    ADD COLUMN IF NOT EXISTS batch_id text NOT NULL DEFAULT '';
ALTER TABLE public.media_object_leases
    DROP CONSTRAINT IF EXISTS media_object_leases_pkey;
ALTER TABLE public.media_object_leases
    ADD CONSTRAINT media_object_leases_pkey
        PRIMARY KEY (workspace_uuid, batch_id, content_hash);
CREATE INDEX IF NOT EXISTS ix_media_object_leases_workspace_digest
    ON public.media_object_leases (workspace_uuid, content_hash);
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
