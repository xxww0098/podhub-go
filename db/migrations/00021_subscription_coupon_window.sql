-- +goose Up
ALTER TABLE public.subscription_coupons ADD COLUMN starts_at timestamptz;
-- Existing coupons were valid immediately after creation, including expired ones.
UPDATE public.subscription_coupons SET starts_at = LEAST(created_at, expires_at - interval '1 microsecond');
ALTER TABLE public.subscription_coupons ALTER COLUMN starts_at SET NOT NULL;
ALTER TABLE public.subscription_coupons ADD CONSTRAINT subscription_coupon_window CHECK (starts_at < expires_at);

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION public.billing_coupon_offer(coupon_code text, at_time timestamptz)
RETURNS TABLE(discount_percent integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO pg_catalog
AS $$
    SELECT c.discount_percent FROM public.subscription_coupons c
    WHERE c.code = coupon_code AND c.enabled
      AND c.starts_at <= at_time AND at_time < c.expires_at AND c.used_count < c.max_uses
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION public.billing_coupon_consume(coupon_code text, quoted_percent integer, at_time timestamptz)
RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path TO pg_catalog
AS $$
    WITH claimed AS (
        UPDATE public.subscription_coupons c SET used_count = c.used_count + 1
        WHERE c.code = coupon_code AND c.discount_percent = quoted_percent AND c.enabled
          AND c.starts_at <= at_time AND at_time < c.expires_at AND c.used_count < c.max_uses
        RETURNING 1
    ) SELECT EXISTS(SELECT 1 FROM claimed)
$$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION public.billing_coupon_offer(coupon_code text, at_time timestamptz)
RETURNS TABLE(discount_percent integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO pg_catalog
AS $$
    SELECT c.discount_percent FROM public.subscription_coupons c
    WHERE c.code = coupon_code AND c.enabled AND c.expires_at > at_time AND c.used_count < c.max_uses
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION public.billing_coupon_consume(coupon_code text, quoted_percent integer, at_time timestamptz)
RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path TO pg_catalog
AS $$
    WITH claimed AS (
        UPDATE public.subscription_coupons c SET used_count = c.used_count + 1
        WHERE c.code = coupon_code AND c.discount_percent = quoted_percent
          AND c.enabled AND c.expires_at > at_time AND c.used_count < c.max_uses
        RETURNING 1
    ) SELECT EXISTS(SELECT 1 FROM claimed)
$$;
-- +goose StatementEnd
ALTER TABLE public.subscription_coupons DROP COLUMN starts_at;
