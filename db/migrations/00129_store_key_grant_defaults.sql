-- +goose Up
-- declaration 129 StoreKeyGrantDefaults m20260908_000290_store_key_grant_defaults
-- source: migration/src/store_key_grant_defaults.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.organization_stores
             ALTER COLUMN assignee_key_read SET DEFAULT false,
             ALTER COLUMN assignee_key_write SET DEFAULT false,
             ALTER COLUMN assignee_key_edit SET DEFAULT false;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
