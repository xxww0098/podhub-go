-- +goose Up
ALTER TABLE public.subscription_coupons
    DROP CONSTRAINT subscription_coupons_max_uses_check,
    DROP CONSTRAINT subscription_coupons_check;
ALTER TABLE public.subscription_coupons ALTER COLUMN used_count TYPE bigint;
ALTER TABLE public.subscription_coupons
    ADD CONSTRAINT subscription_coupons_max_uses_check CHECK (max_uses BETWEEN 0 AND 1000000),
    ADD CONSTRAINT subscription_coupons_check CHECK (used_count >= 0 AND (max_uses = 0 OR used_count <= max_uses));

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION public.billing_coupon_offer(coupon_code text, at_time timestamptz)
RETURNS TABLE(discount_percent integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO pg_catalog
AS $$
    SELECT c.discount_percent FROM public.subscription_coupons c
    WHERE c.code = coupon_code AND c.enabled
      AND c.starts_at <= at_time AND at_time < c.expires_at
      AND (c.max_uses = 0 OR c.used_count < c.max_uses)
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
          AND c.starts_at <= at_time AND at_time < c.expires_at
          AND (c.max_uses = 0 OR c.used_count < c.max_uses)
        RETURNING 1
    ) SELECT EXISTS(SELECT 1 FROM claimed)
$$;
-- +goose StatementEnd

-- +goose Down
ALTER TABLE public.subscription_coupons
    DROP CONSTRAINT subscription_coupons_max_uses_check,
    DROP CONSTRAINT subscription_coupons_check;
ALTER TABLE public.subscription_coupons
    ADD CONSTRAINT subscription_coupons_max_uses_check CHECK (max_uses BETWEEN 1 AND 1000000),
    ADD CONSTRAINT subscription_coupons_check CHECK (used_count BETWEEN 0 AND max_uses);
ALTER TABLE public.subscription_coupons ALTER COLUMN used_count TYPE integer;

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
