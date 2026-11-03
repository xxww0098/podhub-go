-- +goose Up
ALTER TABLE public.redeem_codes
    DROP CONSTRAINT redeem_codes_wallet_cents_valid,
    ADD COLUMN plan_key text REFERENCES public.plans(key),
    ADD COLUMN plan_stores integer,
    ADD COLUMN plan_months integer,
    ADD COLUMN plan_store_monthly_cents bigint,
    ADD CONSTRAINT redeem_codes_grant_valid CHECK (
        (wallet_cents >= 1 AND plan_key IS NULL AND plan_stores IS NULL AND plan_months IS NULL AND plan_store_monthly_cents IS NULL)
        OR (wallet_cents = 0 AND plan_key IS NOT NULL AND plan_key IN ('lite', 'pro', 'max')
            AND plan_stores IS NOT NULL AND plan_stores BETWEEN 1 AND 100
            AND plan_months IS NOT NULL AND plan_months IN (1, 3, 6, 12)
            AND plan_store_monthly_cents IS NOT NULL AND plan_store_monthly_cents >= 0)
    );

ALTER TABLE public.subscription_periods
    ADD COLUMN redeem_code_id bigint UNIQUE REFERENCES public.redeem_codes(id);

DROP FUNCTION public.billing_lock_redeem_code(text);
-- +goose StatementBegin
CREATE FUNCTION public.billing_lock_redeem_code(p_code text)
RETURNS TABLE(id bigint, wallet_cents bigint, used boolean, expires_at timestamptz, revoked_at timestamptz,
              plan_key text, plan_stores integer, plan_months integer, plan_store_monthly_cents bigint)
LANGUAGE sql SECURITY DEFINER SET search_path TO public, pg_temp
AS $$
    SELECT r.id, r.wallet_cents, r.used, r.expires_at, r.revoked_at,
           r.plan_key, r.plan_stores, r.plan_months, r.plan_store_monthly_cents
      FROM public.redeem_codes r WHERE upper(r.code) = upper(p_code) LIMIT 1 FOR UPDATE
$$;
-- +goose StatementEnd
ALTER FUNCTION public.billing_lock_redeem_code(text) OWNER TO podhub_billing_lookup;
REVOKE ALL ON FUNCTION public.billing_lock_redeem_code(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_lock_redeem_code(text) TO podhub_app, podhub_worker, podhub_login_api;

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM public.redeem_codes WHERE plan_key IS NOT NULL) THEN
        RAISE EXCEPTION 'cannot roll back while plan redeem codes exist';
    END IF;
END $$;
-- +goose StatementEnd
DROP FUNCTION public.billing_lock_redeem_code(text);
-- +goose StatementBegin
CREATE FUNCTION public.billing_lock_redeem_code(p_code text)
RETURNS TABLE(id bigint, wallet_cents bigint, used boolean, expires_at timestamptz, revoked_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path TO public, pg_temp
AS $$
    SELECT r.id, r.wallet_cents, r.used, r.expires_at, r.revoked_at
      FROM public.redeem_codes r WHERE upper(r.code) = upper(p_code) LIMIT 1 FOR UPDATE
$$;
-- +goose StatementEnd
ALTER FUNCTION public.billing_lock_redeem_code(text) OWNER TO podhub_billing_lookup;
REVOKE ALL ON FUNCTION public.billing_lock_redeem_code(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_lock_redeem_code(text) TO podhub_app, podhub_worker, podhub_login_api;
ALTER TABLE public.subscription_periods DROP COLUMN redeem_code_id;
ALTER TABLE public.redeem_codes
    DROP CONSTRAINT redeem_codes_grant_valid,
    DROP COLUMN plan_key, DROP COLUMN plan_stores, DROP COLUMN plan_months, DROP COLUMN plan_store_monthly_cents,
    ADD CONSTRAINT redeem_codes_wallet_cents_valid CHECK (wallet_cents >= 1);
