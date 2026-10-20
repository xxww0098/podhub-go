-- +goose Up
-- declaration 16 PlansTeamQuotaColumns m20260802_000044_plans_team_quota_columns
-- source: migration/src/migrator/plans.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.plans
    ADD COLUMN IF NOT EXISTS s3_upload_bytes_monthly bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS ai_tokens_monthly bigint NOT NULL DEFAULT 0;

UPDATE public.plans
SET
    s3_upload_bytes_monthly = CASE key
        WHEN 'free' THEN 1073741824
        WHEN 'lite' THEN 5368709120
        WHEN 'pro' THEN 21474836480
        WHEN 'max' THEN 53687091200
        WHEN 'ultra' THEN 107374182400
        ELSE s3_upload_bytes_monthly
    END,
    ai_tokens_monthly = CASE key
        WHEN 'free' THEN 50000
        WHEN 'lite' THEN 200000
        WHEN 'pro' THEN 1000000
        WHEN 'max' THEN 3000000
        WHEN 'ultra' THEN 10000000
        ELSE ai_tokens_monthly
    END,
    updated_at = clock_timestamp()
WHERE key IN ('free', 'lite', 'pro', 'max', 'ultra');
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
