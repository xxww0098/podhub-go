-- +goose Up
-- Store purchase cap (100 per workspace), auto-issued renewal orders, and the
-- expiry freeze. docs/architecture/subscription-billing.md describes the rules.
--
-- The cap is a CHECK, not a truncation: an existing row above 100 makes this
-- migration fail instead of silently shrinking a paid period.
-- billing/domain.StoreCap holds the same number; the integration suite
-- compares the two.

-- +goose StatementBegin
ALTER TABLE public.subscriptions DROP CONSTRAINT subscriptions_stores_check;
ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_stores_check CHECK (stores BETWEEN 1 AND 100);
ALTER TABLE public.subscription_periods DROP CONSTRAINT subscription_periods_stores_check;
ALTER TABLE public.subscription_periods ADD CONSTRAINT subscription_periods_stores_check CHECK (stores BETWEEN 1 AND 100);
ALTER TABLE public.subscription_quotes DROP CONSTRAINT subscription_quotes_stores_check;
ALTER TABLE public.subscription_quotes ADD CONSTRAINT subscription_quotes_stores_check CHECK (stores BETWEEN 1 AND 100);

ALTER TABLE public.subscriptions ADD COLUMN auto_renew boolean DEFAULT true NOT NULL;

-- An auto-issued renewal has no payment channel and no purchase confirmation
-- until the buyer picks one (provider 'unselected'). auto_term_end is the
-- paid end it renews; one order per workspace per end, whatever its status.
ALTER TABLE public.payment_orders ADD COLUMN auto_term_end timestamp with time zone;
CREATE UNIQUE INDEX payment_orders_auto_term_uidx ON public.payment_orders USING btree (org_id, auto_term_end) WHERE (auto_term_end IS NOT NULL);

ALTER TABLE public.payment_orders DROP CONSTRAINT payment_orders_purchase_agreement_valid;
ALTER TABLE public.payment_orders ADD CONSTRAINT payment_orders_purchase_agreement_valid CHECK (
    ((product)::text <> 'subscription' AND purchase_agreement IS NULL)
    OR ((product)::text = 'subscription' AND (provider)::text = 'unselected' AND purchase_agreement IS NULL)
    OR ((product)::text = 'subscription'
        AND jsonb_typeof(purchase_agreement) = 'object'
        AND purchase_agreement ?& ARRAY['version', 'title', 'effective_at', 'content', 'accepted_at', 'accepted_by']
        AND jsonb_typeof(purchase_agreement -> 'version') = 'string'
        AND jsonb_typeof(purchase_agreement -> 'title') = 'string'
        AND jsonb_typeof(purchase_agreement -> 'effective_at') = 'string'
        AND jsonb_typeof(purchase_agreement -> 'content') = 'string'
        AND jsonb_typeof(purchase_agreement -> 'accepted_at') = 'string'
        AND jsonb_typeof(purchase_agreement -> 'accepted_by') = 'string'
        AND length(purchase_agreement ->> 'version') > 0
        AND length(purchase_agreement ->> 'content') > 0
        AND length(purchase_agreement ->> 'accepted_at') > 0
        AND (purchase_agreement ->> 'accepted_by') = (created_by_user_id)::text)
);

-- The one allowed write: the buyer confirms an unselected order.
CREATE OR REPLACE FUNCTION public.payment_order_agreement_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.purchase_agreement IS DISTINCT FROM OLD.purchase_agreement
       AND NOT (OLD.purchase_agreement IS NULL AND OLD.provider = 'unselected') THEN
        RAISE EXCEPTION 'payment order purchase agreement is immutable';
    END IF;
    RETURN NEW;
END;
$$;

ALTER TABLE public.notifications DROP CONSTRAINT ck_notifications_kind;
ALTER TABLE public.notifications ADD CONSTRAINT ck_notifications_kind CHECK (((kind)::text = ANY (ARRAY['team_invitation'::text, 'agent_commission_credited'::text, 'agent_withdrawal_paid'::text, 'agent_withdrawal_rejected'::text, 'delegate_order_event'::text, 'store_rating_worsened'::text, 'subscription_renewal_due'::text, 'subscription_frozen'::text])));

-- A workspace that has bought service and has no period covering at_time is
-- frozen: no store is allowed. A workspace that never paid keeps its one free
-- store, and an administrator's store_limit_override wins over the freeze.
CREATE OR REPLACE FUNCTION public.subscription_capacity(workspace bigint, at_time timestamp with time zone) RETURNS TABLE(plan_key text, purchased_stores bigint, stores bigint, members bigint, keep_stores uuid[])
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
    SELECT COALESCE(p.plan_key, 'free'),
           COALESCE(p.stores::bigint, 1),
           COALESCE(o.store_limit_override, p.stores::bigint,
                    CASE WHEN EXISTS (SELECT 1 FROM public.subscription_periods f
                                       WHERE f.org_id = o.id AND f.ends_at <= at_time)
                         THEN 0 ELSE 1 END),
           COALESCE(o.member_seat_limit_override, 10::bigint),
           CASE WHEN o.store_limit_override IS NULL THEN p.keep_store_ids END
      FROM public.organizations o
      LEFT JOIN public.subscription_periods p
        ON p.org_id=o.id AND p.starts_at<=at_time AND at_time<p.ends_at
     WHERE o.id=workspace
$$;

-- Unpaid renewals the sweep still has to issue: auto_renew on, paid end inside
-- the lead window, nothing pending, and none issued for this paid end yet.
CREATE FUNCTION public.billing_due_renewals(at_time timestamp with time zone, lead_seconds bigint, batch_size integer) RETURNS TABLE(org_id bigint)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
 SELECT s.org_id FROM public.subscriptions s
  JOIN public.organizations o ON o.id = s.org_id AND o.dissolved_at IS NULL
  WHERE s.status = 'active' AND s.auto_renew
    AND s.term_end > at_time AND s.term_end <= at_time + lead_seconds * interval '1 second'
    AND NOT EXISTS (SELECT 1 FROM public.payment_orders p
                     WHERE p.org_id = s.org_id AND p.product = 'subscription'
                       AND (p.status = 'pending' OR p.auto_term_end = s.term_end))
  ORDER BY s.term_end, s.org_id LIMIT greatest(0, least(batch_size, 1000))
$$;
ALTER FUNCTION public.billing_due_renewals(timestamp with time zone, bigint, integer) OWNER TO podhub_billing_lookup;
REVOKE ALL ON FUNCTION public.billing_due_renewals(timestamp with time zone, bigint, integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.billing_due_renewals(timestamp with time zone, bigint, integer) TO podhub_app;
GRANT ALL ON FUNCTION public.billing_due_renewals(timestamp with time zone, bigint, integer) TO podhub_worker;

CREATE OR REPLACE FUNCTION public.billing_reap_subscription_orders(at_time timestamp with time zone) RETURNS bigint
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
 WITH closed AS (
 UPDATE public.payment_orders SET status='canceled',canceled_at=at_time,updated_at=at_time
 WHERE status='pending' AND product='subscription' AND provider IN ('manual','unselected') AND payment_deadline_at<=at_time
 RETURNING 1)
 SELECT count(*) FROM closed
$$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION public.billing_reap_subscription_orders(at_time timestamp with time zone) RETURNS bigint
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
 WITH closed AS (
 UPDATE public.payment_orders SET status='canceled',canceled_at=at_time,updated_at=at_time
 WHERE status='pending' AND product='subscription' AND provider='manual' AND payment_deadline_at<=at_time
 RETURNING 1)
 SELECT count(*) FROM closed
$$;

DROP FUNCTION public.billing_due_renewals(timestamp with time zone, bigint, integer);

CREATE OR REPLACE FUNCTION public.subscription_capacity(workspace bigint, at_time timestamp with time zone) RETURNS TABLE(plan_key text, purchased_stores bigint, stores bigint, members bigint, keep_stores uuid[])
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
    SELECT COALESCE(p.plan_key, 'free'),
           COALESCE(p.stores::bigint, 1),
           COALESCE(o.store_limit_override, p.stores::bigint, 1),
           COALESCE(o.member_seat_limit_override, 10::bigint),
           CASE WHEN o.store_limit_override IS NULL THEN p.keep_store_ids END
      FROM public.organizations o
      LEFT JOIN public.subscription_periods p
        ON p.org_id=o.id AND p.starts_at<=at_time AND at_time<p.ends_at
     WHERE o.id=workspace
$$;

DELETE FROM public.notifications WHERE kind IN ('subscription_renewal_due', 'subscription_frozen');
ALTER TABLE public.notifications DROP CONSTRAINT ck_notifications_kind;
ALTER TABLE public.notifications ADD CONSTRAINT ck_notifications_kind CHECK (((kind)::text = ANY (ARRAY['team_invitation'::text, 'agent_commission_credited'::text, 'agent_withdrawal_paid'::text, 'agent_withdrawal_rejected'::text, 'delegate_order_event'::text, 'store_rating_worsened'::text])));

CREATE OR REPLACE FUNCTION public.payment_order_agreement_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.purchase_agreement IS DISTINCT FROM OLD.purchase_agreement THEN
        RAISE EXCEPTION 'payment order purchase agreement is immutable';
    END IF;
    RETURN NEW;
END;
$$;

DELETE FROM public.payment_orders WHERE provider = 'unselected';
ALTER TABLE public.payment_orders DROP CONSTRAINT payment_orders_purchase_agreement_valid;
ALTER TABLE public.payment_orders ADD CONSTRAINT payment_orders_purchase_agreement_valid CHECK (
    ((product)::text <> 'subscription' AND purchase_agreement IS NULL)
    OR ((product)::text = 'subscription'
        AND jsonb_typeof(purchase_agreement) = 'object'
        AND purchase_agreement ?& ARRAY['version', 'title', 'effective_at', 'content', 'accepted_at', 'accepted_by']
        AND jsonb_typeof(purchase_agreement -> 'version') = 'string'
        AND jsonb_typeof(purchase_agreement -> 'title') = 'string'
        AND jsonb_typeof(purchase_agreement -> 'effective_at') = 'string'
        AND jsonb_typeof(purchase_agreement -> 'content') = 'string'
        AND jsonb_typeof(purchase_agreement -> 'accepted_at') = 'string'
        AND jsonb_typeof(purchase_agreement -> 'accepted_by') = 'string'
        AND length(purchase_agreement ->> 'version') > 0
        AND length(purchase_agreement ->> 'content') > 0
        AND length(purchase_agreement ->> 'accepted_at') > 0
        AND (purchase_agreement ->> 'accepted_by') = (created_by_user_id)::text)
);
DROP INDEX public.payment_orders_auto_term_uidx;
ALTER TABLE public.payment_orders DROP COLUMN auto_term_end;
ALTER TABLE public.subscriptions DROP COLUMN auto_renew;

ALTER TABLE public.subscription_quotes DROP CONSTRAINT subscription_quotes_stores_check;
ALTER TABLE public.subscription_quotes ADD CONSTRAINT subscription_quotes_stores_check CHECK (stores >= 1);
ALTER TABLE public.subscription_periods DROP CONSTRAINT subscription_periods_stores_check;
ALTER TABLE public.subscription_periods ADD CONSTRAINT subscription_periods_stores_check CHECK (stores >= 1);
ALTER TABLE public.subscriptions DROP CONSTRAINT subscriptions_stores_check;
ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_stores_check CHECK (stores >= 1);
-- +goose StatementEnd
