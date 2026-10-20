-- +goose Up
-- declaration 209 AccountLastLogin m20260922_140000_account_last_login
-- source: migration/src/account_last_login.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.account_users
    ADD COLUMN IF NOT EXISTS last_login_at timestamp with time zone;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
