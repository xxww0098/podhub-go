-- +goose Up
-- declaration 156 AccountNameChange m20260913_000300_account_name_change
-- source: migration/src/account_name_change.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.account_profiles
    ADD COLUMN IF NOT EXISTS name_changed_at_ms bigint;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
