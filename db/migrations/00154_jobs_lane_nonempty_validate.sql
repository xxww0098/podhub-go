-- +goose Up
-- declaration 154 JobsLaneNonemptyValidate m20260913_000298_jobs_lane_nonempty_validate
-- source: migration/src/jobs_lane_nonempty_validate.rs @ a03d735
-- +goose StatementBegin
UPDATE public.jobs SET lane = kind WHERE lane = '';
ALTER TABLE public.jobs VALIDATE CONSTRAINT jobs_lane_nonempty;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
