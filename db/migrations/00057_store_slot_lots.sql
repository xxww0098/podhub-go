-- +goose Up
-- declaration 57 StoreSlotLots m20260821_000220_store_slot_lots
-- source: migration/src/store_slot_lots.rs @ a03d735
-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS public.store_slot_lots (
    id                  bigserial PRIMARY KEY,
    org_id              bigint NOT NULL REFERENCES public.organizations(id),
    quantity            integer NOT NULL,
    starts_at           timestamp with time zone NOT NULL,
    expires_at          timestamp with time zone NOT NULL,
    payment_order_id    bigint REFERENCES public.payment_orders(id),
    created_at          timestamp with time zone NOT NULL,
    CONSTRAINT store_slot_lots_quantity_check CHECK (quantity >= 1)
);

CREATE INDEX IF NOT EXISTS store_slot_lots_org_expires_idx
    ON public.store_slot_lots (org_id, expires_at);

ALTER TABLE public.payment_orders
    ADD COLUMN IF NOT EXISTS store_slots integer;

ALTER TABLE public.payment_orders
    DROP CONSTRAINT IF EXISTS payment_orders_product_known,
    DROP CONSTRAINT IF EXISTS payment_orders_product_shape;

UPDATE public.payment_orders po
SET store_slots = p.max_stores
FROM public.plans p
WHERE po.product = 'team_plan'
  AND po.plan = p.key
  AND po.store_slots IS NULL;

UPDATE public.payment_orders
SET product = 'store_slots'
WHERE product = 'team_plan';

ALTER TABLE public.payment_orders
    ADD CONSTRAINT payment_orders_product_known
        CHECK (product IN ('store_slots', 'ai_wallet_topup'));

ALTER TABLE public.payment_orders
    ADD CONSTRAINT payment_orders_product_shape CHECK (
        (product = 'store_slots' AND store_slots >= 1 AND topup_microfen IS NULL)
        OR (product = 'ai_wallet_topup' AND topup_microfen > 0)
    );

INSERT INTO public.store_slot_lots (org_id, quantity, starts_at, expires_at, created_at)
SELECT o.id,
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
       )::integer,
       NOW(),
       coalesce(o.plan_expires_at, TIMESTAMPTZ '2099-12-31 00:00:00+00'),
       NOW()
FROM public.organizations o
LEFT JOIN public.plans p ON p.key = btrim(o.plan)
WHERE btrim(o.plan) <> 'free'
  AND (o.plan_expires_at IS NULL OR o.plan_expires_at > NOW())
  AND NOT EXISTS (
      SELECT 1 FROM public.store_slot_lots l WHERE l.org_id = o.id
  );

UPDATE public.plans
SET
    max_stores = CASE key
        WHEN 'free' THEN 1
        WHEN 'lite' THEN 3
        WHEN 'pro' THEN 10
        WHEN 'max' THEN 25
        WHEN 'ultra' THEN 50
        ELSE max_stores
    END,
    listing_monthly = CASE key
        WHEN 'free' THEN 1000
        WHEN 'lite' THEN 3000
        WHEN 'pro' THEN 10000
        WHEN 'max' THEN 25000
        WHEN 'ultra' THEN 50000
        ELSE listing_monthly
    END,
    s3_upload_bytes_monthly = CASE key
        WHEN 'free' THEN 15569256448
        WHEN 'lite' THEN 46707769344
        WHEN 'pro' THEN 155692564480
        WHEN 'max' THEN 389231411200
        WHEN 'ultra' THEN 778462822400
        ELSE s3_upload_bytes_monthly
    END,
    ai_tokens_monthly = 0,
    price_monthly_cents = CASE key
        WHEN 'free' THEN 0
        WHEN 'lite' THEN 4500
        WHEN 'pro' THEN 15000
        WHEN 'max' THEN 37500
        WHEN 'ultra' THEN 75000
        ELSE price_monthly_cents
    END,
    tagline = CASE key
        WHEN 'free' THEN '试用 1 家店铺'
        WHEN 'lite' THEN '3 家起'
        WHEN 'pro' THEN '10 家起'
        WHEN 'max' THEN '25 家起'
        WHEN 'ultra' THEN '50 家起'
        ELSE tagline
    END,
    updated_at = clock_timestamp()
WHERE key IN ('free', 'lite', 'pro', 'max', 'ultra');

WITH purchased AS (
    SELECT org_id, SUM(quantity)::bigint AS slots
    FROM public.store_slot_lots
    WHERE expires_at > NOW()
    GROUP BY org_id
)
UPDATE public.organizations o
SET plan = CASE
        WHEN greatest(coalesce(o.store_limit_override, p.slots, 1), 1) >= 50 THEN 'ultra'
        WHEN greatest(coalesce(o.store_limit_override, p.slots, 1), 1) >= 25 THEN 'max'
        WHEN greatest(coalesce(o.store_limit_override, p.slots, 1), 1) >= 10 THEN 'pro'
        WHEN greatest(coalesce(o.store_limit_override, p.slots, 1), 1) >= 3 THEN 'lite'
        ELSE 'free'
    END,
    updated_at = clock_timestamp()
FROM purchased p
WHERE p.org_id = o.id;

UPDATE public.organizations o
SET seat_limit = pl.seat_limit,
    quota_revision = o.quota_revision + 1,
    updated_at = clock_timestamp()
FROM public.plans pl
WHERE pl.key = btrim(o.plan)
  AND o.seat_limit IS DISTINCT FROM pl.seat_limit;

WITH limits AS (
    SELECT o.id AS org_id,
           greatest(
               coalesce(
                   o.store_limit_override,
                   p.slots,
                   1
               ),
               1
           ) AS store_limit
    FROM public.organizations o
    LEFT JOIN (
        SELECT org_id, SUM(quantity)::bigint AS slots
        FROM public.store_slot_lots
        WHERE expires_at > NOW()
        GROUP BY org_id
    ) p ON p.org_id = o.id
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
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
