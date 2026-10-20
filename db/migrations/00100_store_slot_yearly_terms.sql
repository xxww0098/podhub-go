-- +goose Up
-- declaration 100 StoreSlotYearlyTerms m20260904_000262_store_slot_yearly_terms
-- source: migration/src/store_slot_yearly_terms.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.payment_orders
    ADD COLUMN IF NOT EXISTS list_unit_month_cents bigint,
    ADD COLUMN IF NOT EXISTS unit_month_cents bigint,
    ADD COLUMN IF NOT EXISTS duration_days integer;

UPDATE public.payment_orders
SET list_unit_month_cents = 1500,
    unit_month_cents = 1500,
    duration_days = 30 * months
WHERE product = 'store_slots'
  AND duration_days IS NULL;

ALTER TABLE public.payment_orders
    ADD CONSTRAINT payment_orders_store_slot_terms CHECK (
        product <> 'store_slots'
        OR (
            list_unit_month_cents IS NOT NULL
            AND unit_month_cents IS NOT NULL
            AND duration_days IS NOT NULL
            AND list_unit_month_cents >= 1
            AND unit_month_cents >= 1
            AND unit_month_cents <= list_unit_month_cents
            AND duration_days >= 1
        )
    );

UPDATE public.plans lite
SET seat_limit = free.seat_limit,
    max_stores = free.max_stores,
    ocr_monthly = free.ocr_monthly,
    asset_monthly = free.asset_monthly,
    listing_monthly = free.listing_monthly,
    s3_upload_bytes_monthly = free.s3_upload_bytes_monthly,
    ai_tokens_monthly = free.ai_tokens_monthly,
    highlights = free.highlights,
    admin_only = free.admin_only,
    sort_order = free.sort_order,
    price_monthly_cents = 0,
    price_yearly_cents = 0,
    tagline = '默认档 · 1–9 家',
    active = true,
    updated_at = clock_timestamp()
FROM public.plans free
WHERE lite.key = 'lite' AND free.key = 'free';

UPDATE public.plans
SET active = false,
    updated_at = clock_timestamp()
WHERE key = 'free';

ALTER TABLE public.organizations
    ALTER COLUMN plan SET DEFAULT 'lite';
ALTER TABLE public.account_users
    ALTER COLUMN plan SET DEFAULT 'lite';

UPDATE public.plans
SET max_stores = CASE key
        WHEN 'pro' THEN 10
        WHEN 'max' THEN 20
        WHEN 'ultra' THEN 50
        ELSE max_stores
    END,
    listing_monthly = CASE key
        WHEN 'pro' THEN 10000
        WHEN 'max' THEN 20000
        WHEN 'ultra' THEN 50000
        ELSE listing_monthly
    END,
    s3_upload_bytes_monthly = CASE key
        WHEN 'pro' THEN 155692564480
        WHEN 'max' THEN 311385128960
        WHEN 'ultra' THEN 778462822400
        ELSE s3_upload_bytes_monthly
    END,
    price_monthly_cents = CASE key
        WHEN 'pro' THEN 20000
        WHEN 'max' THEN 40000
        WHEN 'ultra' THEN 100000
        ELSE price_monthly_cents
    END,
    tagline = CASE key
        WHEN 'pro' THEN '10 家起'
        WHEN 'max' THEN '20 家起'
        WHEN 'ultra' THEN '50 家起'
        ELSE tagline
    END,
    updated_at = clock_timestamp()
WHERE key IN ('pro', 'max', 'ultra');

WITH slots AS (
    SELECT o.id AS org_id,
           greatest(coalesce(o.store_limit_override, p.slots, 1), 1) AS stores
    FROM public.organizations o
    LEFT JOIN (
        SELECT org_id, SUM(quantity)::bigint AS slots
        FROM public.store_slot_lots
        WHERE starts_at <= NOW() AND expires_at > NOW()
        GROUP BY org_id
    ) p ON p.org_id = o.id
),
badges AS (
    SELECT org_id,
           CASE
               WHEN stores >= 50 THEN 'ultra'
               WHEN stores >= 20 THEN 'max'
               WHEN stores >= 10 THEN 'pro'
               ELSE 'lite'
           END AS plan
    FROM slots
)
UPDATE public.organizations o
SET plan = b.plan,
    seat_limit = pl.seat_limit,
    quota_revision = o.quota_revision + 1,
    updated_at = clock_timestamp()
FROM badges b
JOIN public.plans pl ON pl.key = b.plan
WHERE b.org_id = o.id
  AND btrim(o.plan) <> b.plan;

UPDATE public.account_users
SET plan = 'lite',
    updated_at = clock_timestamp()
WHERE plan = 'free';
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
