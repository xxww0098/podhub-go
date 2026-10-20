-- +goose Up
-- +goose StatementBegin
-- Subscription billing, stage 1: the term is the single source of truth.
-- Capacity changes never move term_end; renewal appends months to it.
-- All month boundaries are Asia/Shanghai 00:00. A trigger enforces it because
-- date_trunc with a zone is STABLE and cannot appear in a CHECK.

CREATE TABLE public.subscriptions (
    org_id             bigint PRIMARY KEY REFERENCES public.organizations (id) ON DELETE CASCADE,
    status             text NOT NULL CHECK (status IN ('free', 'active', 'expired')),
    plan_key           text NOT NULL REFERENCES public.plans (key),
    term_start         timestamptz,
    term_end           timestamptz,
    extra_stores       integer NOT NULL DEFAULT 0 CHECK (extra_stores >= 0),
    extra_members      integer NOT NULL DEFAULT 0 CHECK (extra_members >= 0),
    next_plan_key      text REFERENCES public.plans (key),
    next_extra_stores  integer NOT NULL DEFAULT 0 CHECK (next_extra_stores >= 0),
    next_extra_members integer NOT NULL DEFAULT 0 CHECK (next_extra_members >= 0),
    next_keep_store_ids  uuid[] NOT NULL DEFAULT '{}',
    next_keep_member_ids bigint[] NOT NULL DEFAULT '{}',
    revision           bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    updated_at         timestamptz NOT NULL,
    -- free has no term at all; a paid status always has both ends ordered.
    CONSTRAINT subscriptions_term_shape CHECK (
        (status = 'free' AND term_start IS NULL AND term_end IS NULL)
        OR (status IN ('active', 'expired') AND term_start IS NOT NULL AND term_end IS NOT NULL)),
    CONSTRAINT subscriptions_term_order CHECK (term_end IS NULL OR term_end > term_start),
    -- Only a free subscription may point at the free plan.
    CONSTRAINT subscriptions_plan_not_free CHECK (status = 'free' OR plan_key <> 'free'),
    -- A scheduled reduction always names its plan, even when it repeats the
    -- current one. A null next_plan_key means "no schedule".
    CONSTRAINT subscriptions_next_shape CHECK (
        next_plan_key IS NOT NULL
        OR (next_extra_stores = 0 AND next_extra_members = 0
            AND cardinality(next_keep_store_ids) = 0
            AND cardinality(next_keep_member_ids) = 0))
);
COMMENT ON TABLE public.subscriptions IS
    'One row per workspace. term_end is the only expiry fact; capacity changes never move it.';

-- Sweep candidates: expiring rows and rows that should already have expired.
CREATE INDEX subscriptions_active_end_idx
    ON public.subscriptions (term_end)
    WHERE status = 'active';
CREATE INDEX subscriptions_expired_end_idx
    ON public.subscriptions (term_end)
    WHERE status = 'expired';

-- term_end is always a Shanghai month start. A CHECK cannot express this
-- (date_trunc with a zone is STABLE), so a trigger does. term_start is
-- deliberately unchecked: a first purchase starts in the middle of a month.
CREATE FUNCTION public.subscription_term_month_start() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.term_end IS NOT NULL
       AND NEW.term_end <> (date_trunc('month', NEW.term_end AT TIME ZONE 'Asia/Shanghai')
                            AT TIME ZONE 'Asia/Shanghai') THEN
        RAISE EXCEPTION 'subscription term_end must be a Shanghai month start'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END
$$;
CREATE TRIGGER subscriptions_term_month_start
    BEFORE INSERT OR UPDATE OF term_end ON public.subscriptions
    FOR EACH ROW EXECUTE FUNCTION public.subscription_term_month_start();

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.subscriptions
    FOR ALL TO podhub_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint);
CREATE POLICY worker_claim ON public.subscriptions
    FOR ALL TO podhub_worker
    USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.subscriptions TO podhub_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.subscriptions TO podhub_worker;
-- The expiry sweep runs across tenants and cannot set app.current_org_id for
-- every row it visits; it reads and writes through this non-login role.
CREATE POLICY billing_lookup ON public.subscriptions
    FOR ALL TO podhub_billing_lookup
    USING (true) WITH CHECK (true);
GRANT SELECT, UPDATE ON TABLE public.subscriptions TO podhub_billing_lookup;
-- +goose StatementEnd
-- +goose Down
SELECT 1;
