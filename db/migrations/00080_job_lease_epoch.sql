-- +goose Up
-- declaration 80 JobLeaseEpoch m20260826_000242_job_lease_epoch
-- source: migration/src/job_lease_epoch.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.jobs
    ADD COLUMN IF NOT EXISTS lease_epoch bigint NOT NULL DEFAULT 0;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
