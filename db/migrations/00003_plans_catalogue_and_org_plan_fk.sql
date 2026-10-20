-- +goose Up
-- declaration 3 PlansCatalogueAndOrgPlanFk m20260802_000003_plans_catalogue_and_org_plan_fk
-- source: migration/src/migrator/plans.rs @ a03d735
-- +goose StatementBegin
INSERT INTO public.plans
    (key, name, tagline, price_monthly_cents, price_yearly_cents, seat_limit, max_stores,
     ocr_monthly, asset_monthly, listing_monthly, highlights, admin_only, sort_order, active,
     created_at, updated_at)
VALUES
    ('free',  'Free',  '', 0, 0, 2, 3, 0, 0, 0, '[]', false, 0, true,
     clock_timestamp(), clock_timestamp()),
    ('lite',  'Lite',  '', 0, 0, 3, 5, 0, 0, 0, '[]', false, 1, true,
     clock_timestamp(), clock_timestamp()),
    ('pro',   'Pro',   '', 0, 0, 8, 20, 0, 0, 0, '[]', false, 2, true,
     clock_timestamp(), clock_timestamp()),
    ('max',   'Max',   '', 0, 0, 12, 50, 0, 0, 0, '[]', false, 3, true,
     clock_timestamp(), clock_timestamp()),
    ('ultra', 'Ultra', '', 0, 0, 20, 100, 0, 0, 0, '[]', false, 4, true,
     clock_timestamp(), clock_timestamp())
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.plans
    (key, name, tagline, price_monthly_cents, price_yearly_cents, seat_limit, max_stores,
     ocr_monthly, asset_monthly, listing_monthly, highlights, admin_only, sort_order, active,
     created_at, updated_at)
SELECT DISTINCT
    o.plan,
    trim(o.plan),
    '',
    0,
    0,
    greatest(o.seat_limit, 1),
    0,
    0,
    0,
    0,
    '[]',
    false,
    1000,
    false,
    clock_timestamp(),
    clock_timestamp()
FROM public.organizations o
WHERE NOT EXISTS (
      SELECT 1 FROM public.plans p WHERE p.key = o.plan
  )
ON CONFLICT (key) DO NOTHING;

ALTER TABLE public.organizations
    ADD CONSTRAINT organizations_plan_fkey
    FOREIGN KEY (plan) REFERENCES public.plans(key)
    NOT VALID;

ALTER TABLE public.organizations
    VALIDATE CONSTRAINT organizations_plan_fkey;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
