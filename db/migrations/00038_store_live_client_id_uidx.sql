-- +goose Up
-- +goose NO TRANSACTION
-- declaration 38 StoreLiveClientIdUidx m20260817_000202_store_live_client_id_uidx
-- source: migration/src/store_live_client_id_uidx.rs @ a03d735
-- +goose StatementBegin
CREATE UNIQUE INDEX CONCURRENTLY "uq_organization_stores_live_client_id" ON "public"."organization_stores" ("org_id", "client_id") WHERE client_id IS NOT NULL AND deleted_at_ms IS NULL;
-- +goose StatementEnd
-- +goose StatementBegin
DROP INDEX CONCURRENTLY IF EXISTS "public"."uq_organization_stores_client_id";
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
