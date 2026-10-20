-- +goose Up
-- +goose StatementBegin
-- Projection columns. organizations keeps plan / seat_limit / plan_expires_at
-- because every existing reader uses them; store_limit is new. These four are
-- written only by ProjectSubscription and read by everyone else.
ALTER TABLE public.organizations
    ADD COLUMN store_limit bigint NOT NULL DEFAULT 1 CHECK (store_limit >= 0);

-- Backfill. A workspace whose stored expiry is still in the future keeps the
-- plan it has; everything else becomes free. A free plan with a future expiry
-- is not treated as paid: subscriptions_plan_not_free forbids it, and it was
-- never a real entitlement. term_end is snapped up to the
-- Shanghai month start after the stored expiry, so it satisfies the boundary
-- trigger, and term_start is one month before it.
INSERT INTO public.subscriptions
    (org_id, status, plan_key, term_start, term_end,
     extra_stores, extra_members, revision, updated_at)
SELECT b.org_id,
       CASE WHEN b.live THEN 'active' ELSE 'free' END,
       CASE WHEN b.live THEN b.plan ELSE 'free' END,
       CASE WHEN b.live THEN b.term_end - interval '1 month' END,
       CASE WHEN b.live THEN b.term_end END,
       0, 0, 1, clock_timestamp()
  FROM (
        SELECT o.id AS org_id,
               o.plan,
               (o.plan_expires_at IS NOT NULL
                AND o.plan_expires_at > clock_timestamp()
                AND o.plan IN ('lite', 'pro', 'max')) AS live,
               ((date_trunc('month', o.plan_expires_at AT TIME ZONE 'Asia/Shanghai')
                 + interval '1 month') AT TIME ZONE 'Asia/Shanghai') AS term_end
          FROM public.organizations o
         WHERE NOT EXISTS (SELECT 1 FROM public.subscriptions s WHERE s.org_id = o.id)
       ) b;

-- store_limit follows the same rule: the plan's store count for a live paid
-- workspace, free's one store otherwise.
UPDATE public.organizations o
   SET store_limit = CASE
           WHEN o.plan_expires_at IS NOT NULL AND o.plan_expires_at > clock_timestamp()
                AND o.plan IN ('lite', 'pro', 'max')
           THEN greatest(coalesce((SELECT p.max_stores FROM public.plans p WHERE p.key = o.plan), 1), 1)
           ELSE 1 END,
       updated_at = clock_timestamp();
-- +goose StatementEnd
-- +goose Down
SELECT 1;
