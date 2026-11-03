-- +goose Up
CREATE TABLE public.subscription_coupons (
    code text PRIMARY KEY CHECK (code ~ '^[A-Z0-9_-]{3,32}$'),
    discount_percent integer NOT NULL CHECK (discount_percent BETWEEN 1 AND 99),
    expires_at timestamptz NOT NULL,
    max_uses integer NOT NULL CHECK (max_uses BETWEEN 1 AND 1000000),
    used_count integer NOT NULL DEFAULT 0 CHECK (used_count BETWEEN 0 AND max_uses),
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.subscription_coupons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_coupons FORCE ROW LEVEL SECURITY;
CREATE POLICY subscription_coupon_admin ON public.subscription_coupons TO podhub_app
    USING (EXISTS (SELECT 1 FROM public.account_users observer
        WHERE observer.id::text = current_setting('app.platform_observer_id', true)
          AND observer.role = 'super_admin' AND observer.disabled_at IS NULL))
    WITH CHECK (EXISTS (SELECT 1 FROM public.account_users observer
        WHERE observer.id::text = current_setting('app.platform_observer_id', true)
          AND observer.role = 'super_admin' AND observer.disabled_at IS NULL));
GRANT SELECT, INSERT, UPDATE ON public.subscription_coupons TO podhub_app;
CREATE POLICY subscription_coupon_lookup ON public.subscription_coupons TO podhub_billing_lookup
    USING (true) WITH CHECK (true);
GRANT SELECT, UPDATE ON public.subscription_coupons TO podhub_billing_lookup;

-- +goose StatementBegin
CREATE FUNCTION public.billing_coupon_offer(coupon_code text, at_time timestamptz)
RETURNS TABLE(discount_percent integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO pg_catalog
AS $$
    SELECT c.discount_percent FROM public.subscription_coupons c
    WHERE c.code = coupon_code AND c.enabled AND c.expires_at > at_time AND c.used_count < c.max_uses
$$;
-- +goose StatementEnd
ALTER FUNCTION public.billing_coupon_offer(text, timestamptz) OWNER TO podhub_billing_lookup;
REVOKE ALL ON FUNCTION public.billing_coupon_offer(text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_coupon_offer(text, timestamptz) TO podhub_app;

-- Uses are counted when an order is created. They are not returned on cancellation:
-- valid late payments are still honored, so reusing a canceled order's use could exceed the cap.
-- +goose StatementBegin
CREATE FUNCTION public.billing_coupon_consume(coupon_code text, quoted_percent integer, at_time timestamptz)
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
ALTER FUNCTION public.billing_coupon_consume(text, integer, timestamptz) OWNER TO podhub_billing_lookup;
REVOKE ALL ON FUNCTION public.billing_coupon_consume(text, integer, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_coupon_consume(text, integer, timestamptz) TO podhub_app;

-- +goose Down
DROP FUNCTION public.billing_coupon_consume(text, integer, timestamptz);
DROP FUNCTION public.billing_coupon_offer(text, timestamptz);
DROP TABLE public.subscription_coupons;
