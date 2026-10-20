-- +goose Up
-- declaration 47 PlanQuotaPricing m20260819_000211_plan_quota_pricing
-- source: migration/src/plan_quota_pricing.rs @ a03d735
-- +goose StatementBegin
UPDATE public.plans
SET
    max_stores = CASE key
        WHEN 'free' THEN 1
        WHEN 'lite' THEN 1
        WHEN 'pro' THEN 2
        WHEN 'max' THEN 5
        WHEN 'ultra' THEN 10
        ELSE max_stores
    END,
    s3_upload_bytes_monthly = CASE key
        WHEN 'free' THEN 1610612736
        WHEN 'lite' THEN 31138512896
        WHEN 'pro' THEN 62277025792
        WHEN 'max' THEN 155692564480
        WHEN 'ultra' THEN 311385128960
        ELSE s3_upload_bytes_monthly
    END,
    ai_tokens_monthly = CASE key
        WHEN 'free' THEN 720000
        WHEN 'lite' THEN 14300000
        WHEN 'pro' THEN 28600000
        WHEN 'max' THEN 71500000
        WHEN 'ultra' THEN 143000000
        ELSE ai_tokens_monthly
    END,
    updated_at = clock_timestamp()
WHERE key IN ('free', 'lite', 'pro', 'max', 'ultra');

WITH limits AS (
    SELECT o.id AS org_id,
           greatest(
               coalesce(
                   CASE
                       WHEN o.plan_expires_at IS NOT NULL
                            AND o.plan_expires_at <= NOW()
                       THEN NULL
                       ELSE o.store_limit_override
                   END,
                   p.max_stores,
                   1
               ),
               1
           ) AS store_limit
    FROM public.organizations o
    LEFT JOIN public.plans p ON p.key = CASE
        WHEN o.plan_expires_at IS NOT NULL
             AND o.plan_expires_at <= NOW()
        THEN 'free'
        ELSE o.plan
    END
),
eligible AS (
    SELECT s.id,
           limits.store_limit,
           row_number() OVER (
               PARTITION BY s.org_id
               ORDER BY s.create_order ASC, s.id ASC
           ) AS rn
    FROM public.organization_stores s
    JOIN limits ON limits.org_id = s.org_id
    WHERE s.deleted_at_ms IS NULL
      AND NOT s.manual_disabled
)
UPDATE public.organization_stores s
SET quota_suspended = (e.rn > e.store_limit)
FROM eligible e
WHERE s.id = e.id
  AND s.quota_suspended IS DISTINCT FROM (e.rn > e.store_limit);

UPDATE public.organizations
SET quota_revision = quota_revision + 1,
    updated_at = clock_timestamp();
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
