-- +goose Up
-- declaration 87 RuntimeRoleGrants m20260828_000246_runtime_role_grants
-- source: migration/src/runtime_role_grants.rs @ a03d735
-- +goose StatementBegin
GRANT USAGE ON SCHEMA public TO podhub_app, podhub_worker;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
