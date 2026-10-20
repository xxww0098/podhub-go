-- +goose Up
-- +goose NO TRANSACTION
-- declaration 234 JobsCommandId m20260928_000416_jobs_command_id
-- source: migration/src/jobs_command_id.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.jobs
    ADD COLUMN IF NOT EXISTS command_id text;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX CONCURRENTLY "jobs_org_command_id_idx" ON "public"."jobs" ("org_id", "command_id") WHERE command_id IS NOT NULL;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
