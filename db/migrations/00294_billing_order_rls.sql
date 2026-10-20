-- +goose NO TRANSACTION
-- +goose Up
-- declaration 294 BillingOrderRLS
-- Post-Rust append. Does not alter 00001-00293.
-- FORCE RLS on the billing and platform-order tables that had grants and no
-- policy. podhub_app is limited to app.current_org_id. podhub_worker keeps a
-- separate claim policy; that role is still BYPASSRLS, so the policy is the
-- grant that applies if the attribute is removed. Cross-tenant lookup by
-- public_id or redeem code goes through podhub_billing_lookup, which is not
-- a login and is not granted to the API role.
-- +goose StatementBegin
DO $$
BEGIN
    CREATE ROLE podhub_billing_lookup NOLOGIN NOINHERIT;
EXCEPTION WHEN duplicate_object OR unique_violation THEN
    NULL;
END
$$;
-- +goose StatementEnd

-- +goose StatementBegin
GRANT USAGE ON SCHEMA public TO podhub_billing_lookup;

GRANT SELECT, UPDATE ON TABLE
    public.payment_orders,
    public.redeem_codes
    TO podhub_billing_lookup;

GRANT SELECT ON TABLE public.payment_callback_ledger TO podhub_billing_lookup;
GRANT SELECT ON TABLE public.organizations TO podhub_billing_lookup;
-- +goose StatementEnd

-- +goose StatementBegin
ALTER TABLE public.payment_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_orders FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.payment_orders;
CREATE POLICY tenant_isolation ON public.payment_orders
    FOR ALL TO podhub_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint);
DROP POLICY IF EXISTS worker_claim ON public.payment_orders;
CREATE POLICY worker_claim ON public.payment_orders
    FOR ALL TO podhub_worker
    USING (true)
    WITH CHECK (true);
DROP POLICY IF EXISTS billing_lookup ON public.payment_orders;
CREATE POLICY billing_lookup ON public.payment_orders
    FOR ALL TO podhub_billing_lookup
    USING (true)
    WITH CHECK (true);

ALTER TABLE public.member_seat_lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_seat_lots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.member_seat_lots;
CREATE POLICY tenant_isolation ON public.member_seat_lots
    FOR ALL TO podhub_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint);
DROP POLICY IF EXISTS worker_claim ON public.member_seat_lots;
CREATE POLICY worker_claim ON public.member_seat_lots
    FOR ALL TO podhub_worker
    USING (true)
    WITH CHECK (true);

ALTER TABLE public.member_seat_lot_credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_seat_lot_credits FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.member_seat_lot_credits;
CREATE POLICY tenant_isolation ON public.member_seat_lot_credits
    FOR ALL TO podhub_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint);
DROP POLICY IF EXISTS worker_claim ON public.member_seat_lot_credits;
CREATE POLICY worker_claim ON public.member_seat_lot_credits
    FOR ALL TO podhub_worker
    USING (true)
    WITH CHECK (true);

ALTER TABLE public.redeem_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.redeem_codes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS worker_claim ON public.redeem_codes;
CREATE POLICY worker_claim ON public.redeem_codes
    FOR ALL TO podhub_worker
    USING (true)
    WITH CHECK (true);
DROP POLICY IF EXISTS billing_lookup ON public.redeem_codes;
CREATE POLICY billing_lookup ON public.redeem_codes
    FOR ALL TO podhub_billing_lookup
    USING (true)
    WITH CHECK (true);

ALTER TABLE public.ai_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.ai_requests;
CREATE POLICY tenant_isolation ON public.ai_requests
    FOR ALL TO podhub_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint);
DROP POLICY IF EXISTS worker_claim ON public.ai_requests;
CREATE POLICY worker_claim ON public.ai_requests
    FOR ALL TO podhub_worker
    USING (true)
    WITH CHECK (true);

ALTER TABLE public.sc_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sc_orders FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.sc_orders;
CREATE POLICY tenant_isolation ON public.sc_orders
    FOR ALL TO podhub_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint);
DROP POLICY IF EXISTS worker_claim ON public.sc_orders;
CREATE POLICY worker_claim ON public.sc_orders
    FOR ALL TO podhub_worker
    USING (true)
    WITH CHECK (true);

ALTER TABLE public.sc_order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sc_order_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.sc_order_lines;
CREATE POLICY tenant_isolation ON public.sc_order_lines
    FOR ALL TO podhub_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint);
DROP POLICY IF EXISTS worker_claim ON public.sc_order_lines;
CREATE POLICY worker_claim ON public.sc_order_lines
    FOR ALL TO podhub_worker
    USING (true)
    WITH CHECK (true);
-- +goose StatementEnd

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION public.billing_payment_order_org(p_public_id text)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT org_id FROM public.payment_orders WHERE public_id = p_public_id
$$;

CREATE OR REPLACE FUNCTION public.billing_lock_payment_order(p_public_id text)
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT org_id FROM public.payment_orders WHERE public_id = p_public_id FOR UPDATE
$$;

CREATE OR REPLACE FUNCTION public.billing_lock_redeem_code(p_code text)
RETURNS TABLE (
    id bigint,
    product text,
    member_seats bigint,
    tier text,
    ocr_credits bigint,
    wallet_cents bigint,
    duration_days integer,
    used boolean,
    expires_at timestamp with time zone,
    revoked_at timestamp with time zone
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT id,
           product::text,
           member_seats::bigint,
           COALESCE(tier, '')::text,
           ocr_credits::bigint,
           wallet_cents::bigint,
           duration_days,
           used,
           expires_at,
           revoked_at
      FROM public.redeem_codes
     WHERE upper(code) = upper(p_code)
     LIMIT 1
     FOR UPDATE
$$;

CREATE OR REPLACE FUNCTION public.billing_consume_redeem_code(
    p_id bigint,
    p_user bigint,
    p_org bigint,
    p_used_at_ms bigint
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    n integer;
BEGIN
    IF NULLIF(current_setting('app.current_org_id', true), '')::bigint IS DISTINCT FROM p_org THEN
        RAISE EXCEPTION 'billing redeem org mismatch' USING ERRCODE = '42501';
    END IF;
    UPDATE public.redeem_codes
       SET used = true,
           used_by_user_id = p_user,
           used_by_org_id = p_org,
           used_at_ms = p_used_at_ms,
           updated_at = clock_timestamp()
     WHERE id = p_id AND used = false;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_replay_candidates(p_seconds bigint)
RETURNS TABLE (
    id bigint,
    public_id character varying,
    org_id bigint,
    product text,
    status character varying,
    topup_microfen bigint,
    ledger_status character varying
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT o.id,
           o.public_id,
           o.org_id,
           o.product::text,
           o.status,
           COALESCE(o.topup_microfen, 0),
           l.status
      FROM public.payment_orders o
      JOIN public.payment_callback_ledger l ON l.payment_reference = o.public_id
     WHERE o.status = 'pending'
       AND o.created_at < clock_timestamp() - (p_seconds || ' seconds')::interval
     ORDER BY o.id
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION public.billing_owner_paid_orders(p_user_id bigint)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT count(*)::bigint
      FROM public.payment_orders o
      JOIN public.organizations g ON g.id = o.org_id
     WHERE g.owner_user_id = p_user_id
       AND o.status = 'paid'
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION public.billing_payment_order_brief(p_id bigint)
RETURNS TABLE (public_id text, product text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT o.public_id, o.product::text
      FROM public.payment_orders o
     WHERE o.id = p_id
$$;
-- +goose StatementEnd

-- +goose StatementBegin
ALTER FUNCTION public.billing_payment_order_org(text) OWNER TO podhub_billing_lookup;
ALTER FUNCTION public.billing_lock_payment_order(text) OWNER TO podhub_billing_lookup;
ALTER FUNCTION public.billing_lock_redeem_code(text) OWNER TO podhub_billing_lookup;
ALTER FUNCTION public.billing_consume_redeem_code(bigint, bigint, bigint, bigint) OWNER TO podhub_billing_lookup;
ALTER FUNCTION public.billing_replay_candidates(bigint) OWNER TO podhub_billing_lookup;
ALTER FUNCTION public.billing_owner_paid_orders(bigint) OWNER TO podhub_billing_lookup;
ALTER FUNCTION public.billing_payment_order_brief(bigint) OWNER TO podhub_billing_lookup;

REVOKE ALL ON FUNCTION public.billing_payment_order_org(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.billing_lock_payment_order(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.billing_lock_redeem_code(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.billing_consume_redeem_code(bigint, bigint, bigint, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.billing_replay_candidates(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.billing_owner_paid_orders(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.billing_payment_order_brief(bigint) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.billing_payment_order_org(text) TO podhub_app, podhub_login_api, podhub_worker;
GRANT EXECUTE ON FUNCTION public.billing_lock_payment_order(text) TO podhub_app, podhub_login_api, podhub_worker;
GRANT EXECUTE ON FUNCTION public.billing_lock_redeem_code(text) TO podhub_app, podhub_login_api;
GRANT EXECUTE ON FUNCTION public.billing_consume_redeem_code(bigint, bigint, bigint, bigint) TO podhub_app, podhub_login_api;
GRANT EXECUTE ON FUNCTION public.billing_replay_candidates(bigint) TO podhub_app, podhub_login_api, podhub_worker;
GRANT EXECUTE ON FUNCTION public.billing_owner_paid_orders(bigint) TO podhub_app, podhub_login_api;
GRANT EXECUTE ON FUNCTION public.billing_payment_order_brief(bigint) TO podhub_app, podhub_login_api;
-- +goose StatementEnd

-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
