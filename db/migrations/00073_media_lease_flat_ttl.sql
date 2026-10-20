-- +goose Up
-- declaration 73 MediaLeaseFlatTtl m20260823_000235_media_lease_flat_ttl
-- source: migration/src/media_lease_flat_ttl.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.media_object_leases
    DROP COLUMN IF EXISTS birth_local_date,
    DROP COLUMN IF EXISTS hits_on_birth_date,
    DROP COLUMN IF EXISTS ttl_days;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
