-- +goose Up
-- declaration 89 WorkerTenantRoleMembership m20260901_000248_worker_tenant_role_membership
-- source: migration/src/worker_tenant_role_membership.rs @ a03d735
-- +goose StatementBegin
GRANT podhub_app TO podhub_worker;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
