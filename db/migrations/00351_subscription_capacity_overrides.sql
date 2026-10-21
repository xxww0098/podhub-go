-- +goose Up
-- +goose StatementBegin
-- Periods and the existing administrative overrides are the only capacity facts.
CREATE FUNCTION public.subscription_capacity(workspace bigint, at_time timestamptz)
RETURNS TABLE(plan_key text, purchased_stores bigint, purchased_members bigint,
              stores bigint, members bigint, keep_stores uuid[], keep_members bigint[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
    SELECT COALESCE(p.plan_key, 'free'),
           COALESCE(p.plan_stores::bigint + p.extra_stores, 1),
           COALESCE(p.plan_members::bigint + p.extra_members, 1),
           COALESCE(o.store_limit_override, p.plan_stores::bigint + p.extra_stores, 1),
           COALESCE(o.member_seat_limit_override, p.plan_members::bigint + p.extra_members, 1),
           CASE WHEN o.store_limit_override IS NULL THEN p.keep_store_ids END,
           CASE WHEN o.member_seat_limit_override IS NULL THEN p.keep_member_ids END
      FROM public.organizations o
      LEFT JOIN public.subscription_periods p
        ON p.org_id=o.id AND p.starts_at<=at_time AND at_time<p.ends_at
     WHERE o.id=workspace
$$;
GRANT SELECT (id, store_limit_override, member_seat_limit_override)
    ON public.organizations TO podhub_billing_lookup;
ALTER FUNCTION public.subscription_capacity(bigint,timestamptz) OWNER TO podhub_billing_lookup;
REVOKE ALL ON FUNCTION public.subscription_capacity(bigint,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.subscription_capacity(bigint,timestamptz) TO podhub_app,podhub_worker;

-- An explicit override replaces the paid capacity and its retention list for that dimension.
CREATE OR REPLACE FUNCTION public.subscription_store_allowed(workspace bigint, store uuid, at_time timestamptz)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
    WITH entitlement AS (
        SELECT stores AS capacity, keep_stores AS keep FROM public.subscription_capacity(workspace,at_time)
    ), ranked AS (
        SELECT uuid, row_number() OVER (ORDER BY create_order, id) AS rn
          FROM public.organization_stores
         WHERE org_id = workspace AND deleted_at_ms IS NULL AND NOT manual_disabled
    )
    SELECT COALESCE((SELECT CASE WHEN e.keep IS NULL THEN r.rn <= COALESCE(e.capacity, 1)
                                ELSE r.uuid = ANY(e.keep) END
                      FROM ranked r LEFT JOIN entitlement e ON true WHERE r.uuid = store), false)
$$;
CREATE OR REPLACE FUNCTION public.subscription_member_allowed(workspace bigint, member bigint, at_time timestamptz)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
    WITH entitlement AS (
        SELECT members AS capacity, keep_members AS keep FROM public.subscription_capacity(workspace,at_time)
    ), ranked AS (
        SELECT id, role, row_number() OVER (ORDER BY (role = 'owner') DESC, join_order, id) AS rn
          FROM public.organization_members
         WHERE org_id = workspace AND status = 'active' AND NOT manual_disabled
    )
    SELECT COALESCE((SELECT r.role = 'owner' OR CASE WHEN e.keep IS NULL THEN r.rn <= COALESCE(e.capacity, 1)
                                                   ELSE r.id = ANY(e.keep) END
                      FROM ranked r LEFT JOIN entitlement e ON true WHERE r.id = member), false)
$$;
-- +goose StatementEnd
-- +goose Down
SELECT 1;
