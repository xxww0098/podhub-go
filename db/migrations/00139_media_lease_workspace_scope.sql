-- +goose Up
-- declaration 139 MediaLeaseWorkspaceScope m20260911_000289_media_lease_workspace_scope
-- source: migration/src/media_lease_workspace_scope.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.media_object_leases
    RENAME COLUMN team_uuid TO workspace_uuid;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
