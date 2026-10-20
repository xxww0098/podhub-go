-- +goose Up
-- +goose NO TRANSACTION
-- declaration 43 AccountSessionsUserIdx m20260818_000207_account_sessions_user_idx
-- source: migration/src/account_sessions_user_idx.rs @ a03d735
-- +goose StatementBegin
CREATE INDEX CONCURRENTLY "ix_account_sessions_user" ON "public"."account_sessions" ("user_id");
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
