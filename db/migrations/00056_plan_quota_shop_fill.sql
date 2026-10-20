-- +goose Up
-- declaration 56 PlanQuotaShopFill m20260820_000219_plan_quota_shop_fill
-- source: migration/src/plan_quota_shop_fill.rs @ a03d735
-- +goose StatementBegin
UPDATE public.plans
SET
    max_stores = CASE key
        WHEN 'free' THEN 1
        WHEN 'lite' THEN 10
        WHEN 'pro' THEN 25
        WHEN 'max' THEN 50
        WHEN 'ultra' THEN 100
        ELSE max_stores
    END,
    listing_monthly = CASE key
        WHEN 'free' THEN 1000
        WHEN 'lite' THEN 10000
        WHEN 'pro' THEN 25000
        WHEN 'max' THEN 50000
        WHEN 'ultra' THEN 100000
        ELSE listing_monthly
    END,
    s3_upload_bytes_monthly = CASE key
        WHEN 'free' THEN 15569256448
        WHEN 'lite' THEN 155692564480
        WHEN 'pro' THEN 389231411200
        WHEN 'max' THEN 778462822400
        WHEN 'ultra' THEN 1556925644800
        ELSE s3_upload_bytes_monthly
    END,
    ai_tokens_monthly = CASE key
        WHEN 'free' THEN 10000000
        WHEN 'lite' THEN 100000000
        WHEN 'pro' THEN 250000000
        WHEN 'max' THEN 500000000
        WHEN 'ultra' THEN 1000000000
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
