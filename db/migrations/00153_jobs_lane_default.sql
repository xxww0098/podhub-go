-- +goose Up
-- declaration 153 JobsLaneDefault m20260913_000297_jobs_lane_default
-- source: migration/src/jobs_lane_default.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.jobs ALTER COLUMN lane DROP DEFAULT;
ALTER TABLE public.jobs ADD CONSTRAINT jobs_lane_nonempty CHECK (lane <> '') NOT VALID;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
