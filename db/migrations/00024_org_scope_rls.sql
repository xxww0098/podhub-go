-- +goose Up
-- Row-level security for the org-scoped tables that only carried application
-- WHERE clauses. The policy shape matches 00002_schema.sql: the request role
-- reads its own org, staff reads across orgs, and the read-only platform
-- observer can inspect the two directory tables used by the admin console.
-- Billing helper functions are owned by podhub_billing_lookup, which is not a
-- superuser; the subscription predicates therefore need an explicit SELECT
-- policy on the two directory tables they rank.
-- +goose StatementBegin
DO $$
DECLARE
    tbl text;
BEGIN
    FOREACH tbl IN ARRAY ARRAY[
        'organization_stores',
        'organization_members',
        'org_invitations',
        'organization_store_groups',
        'organization_store_tags',
        'store_tag_links',
        'store_tombstone_consumptions',
        'store_seller_credentials',
        'store_credential_verifications',
        'sc_listing_bindings',
        'sc_order_quotes',
        'sc_procurements',
        'shipping_inject_operations',
        'shipping_shop_injections',
        'support_grants'
    ] LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
        EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', tbl);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', tbl);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON public.%I USING (org_id = (NULLIF(current_setting(''app.current_org_id'', true), '''')::bigint)) WITH CHECK (org_id = (NULLIF(current_setting(''app.current_org_id'', true), '''')::bigint))',
            tbl);
        EXECUTE format('DROP POLICY IF EXISTS staff_all ON public.%I', tbl);
        EXECUTE format(
            'CREATE POLICY staff_all ON public.%I USING (current_setting(''app.staff_access'', true) = ''1'') WITH CHECK (current_setting(''app.staff_access'', true) = ''1'')',
            tbl);
    END LOOP;
END
$$;

DROP POLICY IF EXISTS platform_observation_select ON public.organization_stores;
CREATE POLICY platform_observation_select ON public.organization_stores FOR SELECT
    USING (EXISTS (
        SELECT 1 FROM public.account_users observer
        WHERE observer.id::text = current_setting('app.platform_observer_id', true)
          AND observer.role = 'super_admin'
          AND observer.disabled_at IS NULL
    ));

DROP POLICY IF EXISTS platform_observation_select ON public.organization_members;
CREATE POLICY platform_observation_select ON public.organization_members FOR SELECT
    USING (EXISTS (
        SELECT 1 FROM public.account_users observer
        WHERE observer.id::text = current_setting('app.platform_observer_id', true)
          AND observer.role = 'super_admin'
          AND observer.disabled_at IS NULL
    ));

DROP POLICY IF EXISTS billing_lookup ON public.organization_stores;
CREATE POLICY billing_lookup ON public.organization_stores FOR SELECT TO podhub_billing_lookup USING (true);
DROP POLICY IF EXISTS billing_lookup ON public.organization_members;
CREATE POLICY billing_lookup ON public.organization_members FOR SELECT TO podhub_billing_lookup USING (true);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DO $$
DECLARE
    tbl text;
BEGIN
    FOREACH tbl IN ARRAY ARRAY[
        'organization_stores',
        'organization_members',
        'org_invitations',
        'organization_store_groups',
        'organization_store_tags',
        'store_tag_links',
        'store_tombstone_consumptions',
        'store_seller_credentials',
        'store_credential_verifications',
        'sc_listing_bindings',
        'sc_order_quotes',
        'sc_procurements',
        'shipping_inject_operations',
        'shipping_shop_injections',
        'support_grants'
    ] LOOP
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', tbl);
        EXECUTE format('DROP POLICY IF EXISTS staff_all ON public.%I', tbl);
        EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', tbl);
        EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', tbl);
    END LOOP;
END
$$;
DROP POLICY IF EXISTS platform_observation_select ON public.organization_stores;
DROP POLICY IF EXISTS platform_observation_select ON public.organization_members;
DROP POLICY IF EXISTS billing_lookup ON public.organization_stores;
DROP POLICY IF EXISTS billing_lookup ON public.organization_members;
-- +goose StatementEnd
