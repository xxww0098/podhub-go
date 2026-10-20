-- +goose Up
-- declaration 105 StoreAssigneeKeyGrants m20260905_000266_store_assignee_key_grants
-- source: migration/src/store_assignee_key_grants.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.organization_stores
    ADD COLUMN IF NOT EXISTS assignee_key_read boolean NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS assignee_key_write boolean NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS assignee_key_edit boolean NOT NULL DEFAULT true;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
