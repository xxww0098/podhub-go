-- +goose Up
-- +goose NO TRANSACTION
-- declaration 31 OrganizationsMultiOwnedTeams m20260813_000059_organizations_multi_owned_teams
-- source: migration/src/invitation_inbox.rs @ a03d735
-- +goose StatementBegin
DROP INDEX CONCURRENTLY IF EXISTS "public"."organizations_owner_user_uidx";
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX CONCURRENTLY "organizations_owner_user_idx" ON "public"."organizations" ("owner_user_id");
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
