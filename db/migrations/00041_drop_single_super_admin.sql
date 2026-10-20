-- +goose Up
-- +goose NO TRANSACTION
-- declaration 41 DropSingleSuperAdmin m20260818_000205_drop_single_super_admin
-- source: migration/src/drop_single_super_admin.rs @ a03d735
-- +goose StatementBegin
DROP INDEX CONCURRENTLY IF EXISTS "public"."account_users_single_super_admin";
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
