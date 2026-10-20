-- +goose Up
-- declaration 138 MemberSeatLots m20260911_000286_member_seat_lots
-- source: migration/src/member_seat_lots.rs @ a03d735
-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS public.member_seat_lots (
    id                  bigserial PRIMARY KEY,
    org_id              bigint NOT NULL REFERENCES public.organizations(id),
    tier                text NOT NULL,
    seats               integer NOT NULL,
    starts_at           timestamp with time zone NOT NULL,
    expires_at          timestamp with time zone NOT NULL,
    payment_order_id    bigint REFERENCES public.payment_orders(id),
    created_at          timestamp with time zone NOT NULL,
    CONSTRAINT member_seat_lots_tier_known CHECK (tier IN ('pro', 'max', 'ultra')),
    CONSTRAINT member_seat_lots_seats_positive CHECK (seats >= 1)
);

CREATE INDEX IF NOT EXISTS member_seat_lots_org_expires_idx
    ON public.member_seat_lots (org_id, expires_at);

INSERT INTO public.member_seat_lots
    (org_id, tier, seats, starts_at, expires_at, payment_order_id, created_at)
SELECT org_id,
       'pro',
       greatest(1, ceil(quantity::numeric / 5))::int,
       starts_at,
       expires_at,
       payment_order_id,
       created_at
FROM public.store_slot_lots;

DROP TABLE public.store_slot_lots;

ALTER TABLE public.payment_orders
    RENAME COLUMN store_slots TO member_seats;

ALTER TABLE public.payment_orders
    ALTER COLUMN product SET DEFAULT 'member_seats';

-- Old product constraints still name 'store_slots'; drop them before the
-- UPDATE writes 'member_seats' rows, or a populated database fails here.
ALTER TABLE public.payment_orders
    DROP CONSTRAINT IF EXISTS payment_orders_store_slot_terms;

ALTER TABLE public.payment_orders
    DROP CONSTRAINT IF EXISTS payment_orders_product_known;

ALTER TABLE public.payment_orders
    DROP CONSTRAINT IF EXISTS payment_orders_product_shape;

UPDATE public.payment_orders
SET product = 'member_seats',
    member_seats = greatest(1, ceil(member_seats::numeric / 5))::int,
    plan = CASE plan
        WHEN 'max' THEN 'max'
        WHEN 'ultra' THEN 'ultra'
        ELSE 'pro'
    END
WHERE product = 'store_slots';

ALTER TABLE public.payment_orders
    ADD CONSTRAINT payment_orders_member_seat_terms CHECK (
        product <> 'member_seats'
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

ALTER TABLE public.payment_orders
    ADD CONSTRAINT payment_orders_product_known
        CHECK (product IN ('member_seats', 'ai_wallet_topup', 'platform_goods'));

ALTER TABLE public.payment_orders
    ADD CONSTRAINT payment_orders_product_shape CHECK (
        (product = 'member_seats' AND member_seats >= 1 AND topup_microfen IS NULL)
        OR (product = 'ai_wallet_topup' AND topup_microfen > 0)
        OR (product = 'platform_goods'
            AND topup_microfen IS NULL
            AND (member_seats IS NULL OR member_seats = 0))
    );

ALTER TABLE public.redeem_codes
    RENAME COLUMN store_slots TO member_seats;

ALTER TABLE public.redeem_codes
    ADD COLUMN IF NOT EXISTS tier text;

ALTER TABLE public.redeem_codes
    ALTER COLUMN product SET DEFAULT 'member_seats';

-- Same ordering rule: the old shape constraint still names 'store_slots',
-- so it must go before the UPDATE writes 'member_seats' rows.
ALTER TABLE public.redeem_codes
    DROP CONSTRAINT IF EXISTS redeem_codes_product_shape;

UPDATE public.redeem_codes
SET product = 'member_seats',
    tier = CASE
        WHEN plan IN ('pro', 'max', 'ultra') THEN plan
        ELSE 'pro'
    END
WHERE product = 'store_slots';

ALTER TABLE public.redeem_codes
    ADD CONSTRAINT redeem_codes_product_shape CHECK (
        product IN ('member_seats', 'ocr_credits', 'wallet_credits')
        AND (
            (product = 'member_seats'
                AND member_seats >= 1
                AND tier IN ('pro', 'max', 'ultra')
                AND ocr_credits = 0
                AND wallet_cents = 0)
            OR (product = 'ocr_credits'
                AND ocr_credits >= 1
                AND member_seats = 0
                AND wallet_cents = 0)
            OR (product = 'wallet_credits'
                AND wallet_cents >= 1
                AND member_seats = 0
                AND ocr_credits = 0)
        )
    );
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
