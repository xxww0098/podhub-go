-- +goose Up
-- +goose StatementBegin
DROP TRIGGER subscriptions_term_month_start ON public.subscriptions;
DROP FUNCTION public.subscription_term_month_start();
ALTER TABLE public.subscriptions
    ADD COLUMN billing_anchor timestamptz,
    ADD COLUMN billing_timezone text NOT NULL DEFAULT 'Asia/Shanghai'
        CHECK (billing_timezone = 'Asia/Shanghai');
UPDATE public.subscriptions SET billing_anchor = term_start;

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE TABLE public.subscription_periods (
    id bigserial PRIMARY KEY,
    org_id bigint NOT NULL REFERENCES public.subscriptions(org_id) ON DELETE CASCADE,
    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
    plan_key text NOT NULL REFERENCES public.plans(key),
    plan_stores integer NOT NULL CHECK (plan_stores >= 0),
    plan_members integer NOT NULL CHECK (plan_members >= 1),
    plan_monthly_cents bigint NOT NULL CHECK (plan_monthly_cents >= 0),
    store_monthly_cents bigint NOT NULL CHECK (store_monthly_cents >= 0),
    member_monthly_cents bigint NOT NULL CHECK (member_monthly_cents >= 0),
    extra_stores integer NOT NULL CHECK (extra_stores >= 0),
    extra_members integer NOT NULL CHECK (extra_members >= 0),
    keep_store_ids uuid[],
    keep_member_ids bigint[],
    order_id bigint REFERENCES public.payment_orders(id),
    EXCLUDE USING gist (org_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)
);
INSERT INTO public.subscription_periods
    (org_id, starts_at, ends_at, plan_key, plan_stores, plan_members,
     plan_monthly_cents, store_monthly_cents, member_monthly_cents, extra_stores, extra_members)
SELECT s.org_id, s.term_start, s.term_end, s.plan_key, p.max_stores, p.seat_limit,
       p.price_monthly_cents, b.store_monthly_cents, b.member_monthly_cents, s.extra_stores, s.extra_members
  FROM public.subscriptions s JOIN public.plans p ON p.key = s.plan_key
 CROSS JOIN public.billing_settings b WHERE s.status <> 'free';

ALTER TABLE public.subscription_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_periods FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.subscription_periods FOR ALL TO podhub_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint);
CREATE POLICY worker_claim ON public.subscription_periods FOR ALL TO podhub_worker
    USING (true) WITH CHECK (true);
CREATE POLICY billing_lookup ON public.subscription_periods FOR SELECT TO podhub_billing_lookup USING (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.subscription_periods TO podhub_app, podhub_worker;
GRANT SELECT ON public.subscription_periods TO podhub_billing_lookup;
GRANT USAGE, SELECT ON SEQUENCE public.subscription_periods_id_seq TO podhub_app, podhub_worker;

ALTER TABLE public.subscription_quotes DROP CONSTRAINT subscription_quotes_amount_cents_check;
ALTER TABLE public.subscription_quotes ADD CHECK (amount_cents >= 0);
ALTER TABLE public.subscription_quotes DROP CONSTRAINT subscription_quotes_action_check;
ALTER TABLE public.subscription_quotes ADD CHECK (action IN ('subscribe', 'renew', 'change', 'schedule', 'keep'));
ALTER TABLE public.subscription_quotes ADD COLUMN payload jsonb NOT NULL DEFAULT '{}';

-- These predicates read the service interval at admission time; a late sweep cannot extend access.
CREATE FUNCTION public.subscription_store_allowed(workspace bigint, store uuid, at_time timestamptz)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
    WITH entitlement AS (
        SELECT plan_stores + extra_stores AS capacity, keep_store_ids AS keep
          FROM public.subscription_periods
         WHERE org_id = workspace AND starts_at <= at_time AND at_time < ends_at
    ), ranked AS (
        SELECT uuid, row_number() OVER (ORDER BY create_order, id) AS rn
          FROM public.organization_stores
         WHERE org_id = workspace AND deleted_at_ms IS NULL AND NOT manual_disabled
    )
    SELECT COALESCE((SELECT CASE WHEN e.keep IS NULL THEN r.rn <= COALESCE(e.capacity, 1)
                                ELSE r.uuid = ANY(e.keep) END
                      FROM ranked r LEFT JOIN entitlement e ON true WHERE r.uuid = store), false)
$$;
CREATE FUNCTION public.subscription_member_allowed(workspace bigint, member bigint, at_time timestamptz)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
    WITH entitlement AS (
        SELECT plan_members + extra_members AS capacity, keep_member_ids AS keep
          FROM public.subscription_periods
         WHERE org_id = workspace AND starts_at <= at_time AND at_time < ends_at
    ), ranked AS (
        SELECT id, role, row_number() OVER (ORDER BY (role = 'owner') DESC, join_order, id) AS rn
          FROM public.organization_members
         WHERE org_id = workspace AND status = 'active' AND NOT manual_disabled
    )
    SELECT COALESCE((SELECT r.role = 'owner' OR CASE WHEN e.keep IS NULL THEN r.rn <= COALESCE(e.capacity, 1)
                                                   ELSE r.id = ANY(e.keep) END
                      FROM ranked r LEFT JOIN entitlement e ON true WHERE r.id = member), false)
$$;
GRANT SELECT (id, org_id, uuid, create_order, deleted_at_ms, manual_disabled)
    ON public.organization_stores TO podhub_billing_lookup;
GRANT SELECT (id, org_id, role, status, manual_disabled, join_order)
    ON public.organization_members TO podhub_billing_lookup;
ALTER FUNCTION public.subscription_store_allowed(bigint, uuid, timestamptz) OWNER TO podhub_billing_lookup;
ALTER FUNCTION public.subscription_member_allowed(bigint, bigint, timestamptz) OWNER TO podhub_billing_lookup;
REVOKE ALL ON FUNCTION public.subscription_store_allowed(bigint, uuid, timestamptz),
    public.subscription_member_allowed(bigint, bigint, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.subscription_store_allowed(bigint, uuid, timestamptz),
    public.subscription_member_allowed(bigint, bigint, timestamptz) TO podhub_app, podhub_worker;

-- Cross-tenant maintenance uses narrow functions, never a role switch to the lookup role.
CREATE FUNCTION public.billing_due_subscriptions(at_time timestamptz, batch_size integer)
RETURNS TABLE (org_id bigint) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
 SELECT s.org_id FROM public.subscriptions s WHERE s.status='active' AND
 (s.term_end<=at_time OR EXISTS (SELECT 1 FROM public.subscription_periods p
   WHERE p.org_id=s.org_id AND p.starts_at<=at_time AND at_time<p.ends_at
   AND (p.plan_key,p.extra_stores,p.extra_members,p.starts_at) IS DISTINCT FROM (s.plan_key,s.extra_stores,s.extra_members,s.term_start)))
 ORDER BY s.updated_at LIMIT greatest(0,least(batch_size,1000))
$$;
CREATE FUNCTION public.billing_due_drains(deadline_seconds bigint, at_time timestamptz, batch_size integer)
RETURNS TABLE (org_id bigint, drain_id bigint, deadline_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
 SELECT e.org_id,e.id,e.effective_at+deadline_seconds*interval '1 second'
 FROM public.subscription_events e WHERE e.kind='drain'
 AND NOT EXISTS(SELECT 1 FROM public.subscription_events d WHERE d.org_id=e.org_id AND d.kind='drain_done' AND (d.breakdown->>'drain_event_id')::bigint=e.id)
 AND e.effective_at+deadline_seconds*interval '1 second'<=at_time
 ORDER BY e.id LIMIT greatest(0,least(batch_size,1000))
$$;
CREATE FUNCTION public.billing_reap_subscription_orders(at_time timestamptz)
RETURNS bigint LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
 WITH closed AS (
 UPDATE public.payment_orders SET status='canceled',canceled_at=at_time,updated_at=at_time
 WHERE status='pending' AND product='subscription' AND provider='manual' AND payment_deadline_at<=at_time
 RETURNING 1)
 SELECT count(*) FROM closed
$$;
ALTER FUNCTION public.billing_due_subscriptions(timestamptz,integer) OWNER TO podhub_billing_lookup;
ALTER FUNCTION public.billing_due_drains(bigint,timestamptz,integer) OWNER TO podhub_billing_lookup;
ALTER FUNCTION public.billing_reap_subscription_orders(timestamptz) OWNER TO podhub_billing_lookup;
REVOKE ALL ON FUNCTION public.billing_due_subscriptions(timestamptz,integer),public.billing_due_drains(bigint,timestamptz,integer),public.billing_reap_subscription_orders(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_due_subscriptions(timestamptz,integer),public.billing_due_drains(bigint,timestamptz,integer),public.billing_reap_subscription_orders(timestamptz) TO podhub_app,podhub_worker;
-- +goose StatementEnd
-- +goose Down
SELECT 1;
