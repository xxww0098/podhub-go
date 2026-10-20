-- +goose Up
-- declaration 59 FreeTrialSolo m20260821_000222_free_trial_solo
-- source: migration/src/free_trial_solo.rs @ a03d735
-- +goose StatementBegin
UPDATE public.plans
SET seat_limit = 1,
    updated_at = clock_timestamp()
WHERE key = 'free'
  AND seat_limit IS DISTINCT FROM 1;

UPDATE public.organizations
SET seat_limit = 1,
    quota_revision = quota_revision + 1,
    updated_at = clock_timestamp()
WHERE btrim(plan) = 'free'
  AND seat_limit = 2;

WITH ranked AS (
    SELECT m.id,
           row_number() OVER (
               PARTITION BY m.org_id
               ORDER BY m.join_order ASC, m.id ASC
           ) AS rn
    FROM public.organization_members m
    JOIN public.organizations o ON o.id = m.org_id
    WHERE btrim(o.plan) = 'free'
      AND o.seat_limit = 1
      AND NOT m.manual_disabled
)
UPDATE public.organization_members m
SET quota_suspended = (ranked.rn > 1)
FROM ranked
WHERE m.id = ranked.id
  AND m.quota_suspended IS DISTINCT FROM (ranked.rn > 1);
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
