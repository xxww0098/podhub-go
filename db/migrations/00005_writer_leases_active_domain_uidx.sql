-- +goose Up
-- +goose NO TRANSACTION
-- declaration 5 WriterLeasesActiveDomainUidx m20260802_000021_writer_leases_active_domain_uidx
-- source: migration/src/migrator/writer_leases.rs @ a03d735
-- +goose StatementBegin
CREATE UNIQUE INDEX CONCURRENTLY "writer_leases_active_domain_uidx" ON "public"."writer_leases" ("domain") WHERE revoked_at_ms IS NULL;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
