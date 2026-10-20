-- +goose Up
-- +goose NO TRANSACTION
-- declaration 7 OrganizationsOwnerUserUidx m20260802_000031_organizations_owner_user_uidx
-- source: migration/src/uniqueness.rs @ a03d735
-- +goose StatementBegin
CREATE UNIQUE INDEX CONCURRENTLY "organizations_owner_user_uidx" ON "public"."organizations" ("owner_user_id");
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
