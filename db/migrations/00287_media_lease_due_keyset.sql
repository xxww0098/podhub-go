-- +goose Up
-- +goose NO TRANSACTION
-- declaration 287 MediaLeaseDueKeyset m20261015_000060_media_lease_due_keyset
-- source: migration/src/media_lease_due_keyset.rs @ a03d735
-- +goose StatementBegin
CREATE INDEX CONCURRENTLY "ix_media_object_leases_due_keyset" ON "public"."media_object_leases" ("expires_at", "workspace_uuid", "batch_id", "content_hash") WHERE deleted_at IS NULL;
-- +goose StatementEnd
-- +goose StatementBegin
DROP INDEX CONCURRENTLY IF EXISTS "public"."ix_media_object_leases_due";
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
