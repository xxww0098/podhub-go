-- +goose Up
-- declaration 37 FreePlanS3Quota m20260817_000201_free_plan_s3_quota
-- source: migration/src/free_plan_s3_quota.rs @ a03d735
-- +goose StatementBegin
UPDATE public.plans
SET
    s3_upload_bytes_monthly = 104857600,
    updated_at = clock_timestamp()
WHERE key = 'free';
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
