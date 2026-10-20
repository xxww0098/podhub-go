-- +goose Up
-- declaration 45 PlanMonthlyPrices m20260818_000209_plan_monthly_prices
-- source: migration/src/plan_monthly_prices.rs @ a03d735
-- +goose StatementBegin
UPDATE public.plans
SET
    price_monthly_cents = CASE key
        WHEN 'lite' THEN 69900
        WHEN 'pro' THEN 139900
        WHEN 'max' THEN 329900
        WHEN 'ultra' THEN 659900
        ELSE price_monthly_cents
    END,
    updated_at = clock_timestamp()
WHERE key IN ('lite', 'pro', 'max', 'ultra');
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
