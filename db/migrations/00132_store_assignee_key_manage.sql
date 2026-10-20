-- +goose Up
-- declaration 132 StoreAssigneeKeyManage m20260909_000288_store_assignee_key_manage
-- source: migration/src/store_assignee_key_manage.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.organization_stores
    ADD COLUMN IF NOT EXISTS assignee_key_manage boolean NOT NULL DEFAULT false;
UPDATE public.organization_stores
   SET assignee_key_manage = (assignee_key_read OR assignee_key_write OR assignee_key_edit);
ALTER TABLE public.organization_stores
    ALTER COLUMN assignee_key_read SET DEFAULT false,
    ALTER COLUMN assignee_key_write SET DEFAULT false,
    ALTER COLUMN assignee_key_edit SET DEFAULT false;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
