-- +goose Up
-- 00365 catalog RLS.
--
-- Before this migration these six tables had ZERO policies: every podhub_app
-- session could read AND write all of them. The catalog is the platform's
-- shared product reference data, so the arms below describe who reads what.
--
-- Two facts discovered while wiring the read paths, both of which shape the
-- arms:
--
--   1. The catalog is REFERENCE DATA, not tenant data. A seller building a
--      listing card reads sc_products/sc_skus/sc_price_versions for products
--      it does not own, and the storefront reads them anonymously. Scoping
--      reads to the caller's own bindings breaks listing creation and the
--      public catalog (listing_hot_test.go, catalog_whitelist_test.go).
--   2. The factory COST is not reference data. sc_source_offers.cost_cents is
--      the supplier's cost, and leaking it to a seller or the public is a
--      margin leak. It keeps a narrow arm.
--
-- So: reads of published/listed catalog are open to any app session; writes
-- are staff or catalog-manager only; cost is supplier+staff only.
--
-- There is NO "any org GUC" compatibility arm. The pre-flight audit (§10.2)
-- found seven app read paths without a staff marker; naming them here is what
-- keeps this migration honest.
-- +goose StatementBegin

-- =======================================================================
-- sc_sources: a source is a factory, and its existence/name/country/icon are
-- shown to every seller who picks a supplier. Write stays staff/manager.
-- =======================================================================
ALTER TABLE public.sc_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sc_sources FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sc_sources_staff_all ON public.sc_sources;
CREATE POLICY sc_sources_staff_all ON public.sc_sources
    FOR ALL TO podhub_app
    USING (current_setting('app.staff_access', true) = '1')
    WITH CHECK (current_setting('app.staff_access', true) = '1');

DROP POLICY IF EXISTS sc_sources_manager_all ON public.sc_sources;
CREATE POLICY sc_sources_manager_all ON public.sc_sources
    FOR ALL TO podhub_app
    USING (EXISTS (
        SELECT 1 FROM public.sc_catalog_managers m
        WHERE m.source_id = sc_sources.source_id
          AND m.user_id = NULLIF(current_setting('app.current_org_user_id', true), '')::bigint
          AND m.status = 'active'
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM public.sc_catalog_managers m
        WHERE m.source_id = sc_sources.source_id
          AND m.user_id = NULLIF(current_setting('app.current_org_user_id', true), '')::bigint
          AND m.status = 'active'
    ));

-- Reference read: any app session may read a listed source. Unlisted sources
-- are internal (a factory not yet on the storefront) and stay staff/manager
-- only. The supplier portal reads its own source through the separate arm.
DROP POLICY IF EXISTS sc_sources_listed_read ON public.sc_sources;
CREATE POLICY sc_sources_listed_read ON public.sc_sources
    FOR SELECT TO podhub_app
    USING (listed OR source_id = 'src_unassigned');

-- A supplier reads its own source even when it is not listed yet: the portal
-- catalog screen must show the factory its own unlisted products.
DROP POLICY IF EXISTS sc_sources_supplier_read ON public.sc_sources;
CREATE POLICY sc_sources_supplier_read ON public.sc_sources
    FOR SELECT TO podhub_app
    USING (EXISTS (
        SELECT 1 FROM public.sc_source_members sm
        WHERE sm.source_id = sc_sources.source_id
          AND sm.user_id = NULLIF(current_setting('app.current_supplier_user_id', true), '')::bigint
          AND sm.status = 'active'
    ));

-- A seller reads the source behind any of its own bindings, listed or not.
DROP POLICY IF EXISTS sc_sources_seller_read ON public.sc_sources;
CREATE POLICY sc_sources_seller_read ON public.sc_sources
    FOR SELECT TO podhub_app
    USING (EXISTS (
        SELECT 1 FROM public.delegate_bindings b
        WHERE b.source_id = sc_sources.source_id
          AND b.org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    ));

-- =======================================================================
-- sc_source_prop_defs: the property schema of a source. Read follows the
-- source; write stays staff/manager.
-- =======================================================================
ALTER TABLE public.sc_source_prop_defs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sc_source_prop_defs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sc_source_prop_defs_staff_all ON public.sc_source_prop_defs;
CREATE POLICY sc_source_prop_defs_staff_all ON public.sc_source_prop_defs
    FOR ALL TO podhub_app
    USING (current_setting('app.staff_access', true) = '1')
    WITH CHECK (current_setting('app.staff_access', true) = '1');

DROP POLICY IF EXISTS sc_source_prop_defs_manager_all ON public.sc_source_prop_defs;
CREATE POLICY sc_source_prop_defs_manager_all ON public.sc_source_prop_defs
    FOR ALL TO podhub_app
    USING (EXISTS (
        SELECT 1 FROM public.sc_catalog_managers m
        WHERE m.source_id = sc_source_prop_defs.source_id
          AND m.user_id = NULLIF(current_setting('app.current_org_user_id', true), '')::bigint
          AND m.status = 'active'
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM public.sc_catalog_managers m
        WHERE m.source_id = sc_source_prop_defs.source_id
          AND m.user_id = NULLIF(current_setting('app.current_org_user_id', true), '')::bigint
          AND m.status = 'active'
    ));

DROP POLICY IF EXISTS sc_source_prop_defs_read ON public.sc_source_prop_defs;
CREATE POLICY sc_source_prop_defs_read ON public.sc_source_prop_defs
    FOR SELECT TO podhub_app
    USING (EXISTS (
        SELECT 1 FROM public.sc_sources s
        WHERE s.source_id = sc_source_prop_defs.source_id AND s.listed
    ));

DROP POLICY IF EXISTS sc_source_prop_defs_supplier_read ON public.sc_source_prop_defs;
CREATE POLICY sc_source_prop_defs_supplier_read ON public.sc_source_prop_defs
    FOR SELECT TO podhub_app
    USING (EXISTS (
        SELECT 1 FROM public.sc_source_members sm
        WHERE sm.source_id = sc_source_prop_defs.source_id
          AND sm.user_id = NULLIF(current_setting('app.current_supplier_user_id', true), '')::bigint
          AND sm.status = 'active'
    ));

DROP POLICY IF EXISTS sc_source_prop_defs_seller_read ON public.sc_source_prop_defs;
CREATE POLICY sc_source_prop_defs_seller_read ON public.sc_source_prop_defs
    FOR SELECT TO podhub_app
    USING (EXISTS (
        SELECT 1 FROM public.delegate_bindings b
        WHERE b.source_id = sc_source_prop_defs.source_id
          AND b.org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    ));

-- =======================================================================
-- sc_products: published products are reference data any seller may attach a
-- card to. published = false hides a product from everyone but staff/manager.
-- =======================================================================
ALTER TABLE public.sc_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sc_products FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sc_products_staff_all ON public.sc_products;
CREATE POLICY sc_products_staff_all ON public.sc_products
    FOR ALL TO podhub_app
    USING (current_setting('app.staff_access', true) = '1')
    WITH CHECK (current_setting('app.staff_access', true) = '1');

DROP POLICY IF EXISTS sc_products_manager_all ON public.sc_products;
CREATE POLICY sc_products_manager_all ON public.sc_products
    FOR ALL TO podhub_app
    USING (EXISTS (
        SELECT 1 FROM public.sc_catalog_managers m
        WHERE m.source_id = sc_products.source_id
          AND m.user_id = NULLIF(current_setting('app.current_org_user_id', true), '')::bigint
          AND m.status = 'active'
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM public.sc_catalog_managers m
        WHERE m.source_id = sc_products.source_id
          AND m.user_id = NULLIF(current_setting('app.current_org_user_id', true), '')::bigint
          AND m.status = 'active'
    ));

DROP POLICY IF EXISTS sc_products_published_read ON public.sc_products;
CREATE POLICY sc_products_published_read ON public.sc_products
    FOR SELECT TO podhub_app
    USING (published);

-- A supplier sees its own source's products even when unpublished: the portal
-- catalog screen lists drafts.
DROP POLICY IF EXISTS sc_products_supplier_read ON public.sc_products;
CREATE POLICY sc_products_supplier_read ON public.sc_products
    FOR SELECT TO podhub_app
    USING (EXISTS (
        SELECT 1 FROM public.sc_source_members sm
        WHERE sm.source_id = sc_products.source_id
          AND sm.user_id = NULLIF(current_setting('app.current_supplier_user_id', true), '')::bigint
          AND sm.status = 'active'
    ));

-- A seller reads products of the sources it is bound to, published or not.
DROP POLICY IF EXISTS sc_products_seller_read ON public.sc_products;
CREATE POLICY sc_products_seller_read ON public.sc_products
    FOR SELECT TO podhub_app
    USING (EXISTS (
        SELECT 1 FROM public.delegate_bindings b
        WHERE b.source_id = sc_products.source_id
          AND b.org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    ));

-- =======================================================================
-- sc_skus: same rule, joined through sc_products because there is no
-- source_id column on a SKU.
-- =======================================================================
ALTER TABLE public.sc_skus ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sc_skus FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sc_skus_staff_all ON public.sc_skus;
CREATE POLICY sc_skus_staff_all ON public.sc_skus
    FOR ALL TO podhub_app
    USING (current_setting('app.staff_access', true) = '1')
    WITH CHECK (current_setting('app.staff_access', true) = '1');

DROP POLICY IF EXISTS sc_skus_manager_all ON public.sc_skus;
CREATE POLICY sc_skus_manager_all ON public.sc_skus
    FOR ALL TO podhub_app
    USING (EXISTS (
        SELECT 1 FROM public.sc_products p
        JOIN public.sc_catalog_managers m ON m.source_id = p.source_id
        WHERE p.product_id = sc_skus.product_id
          AND m.user_id = NULLIF(current_setting('app.current_org_user_id', true), '')::bigint
          AND m.status = 'active'
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM public.sc_products p
        JOIN public.sc_catalog_managers m ON m.source_id = p.source_id
        WHERE p.product_id = sc_skus.product_id
          AND m.user_id = NULLIF(current_setting('app.current_org_user_id', true), '')::bigint
          AND m.status = 'active'
    ));

DROP POLICY IF EXISTS sc_skus_published_read ON public.sc_skus;
CREATE POLICY sc_skus_published_read ON public.sc_skus
    FOR SELECT TO podhub_app
    USING (published);

DROP POLICY IF EXISTS sc_skus_supplier_read ON public.sc_skus;
CREATE POLICY sc_skus_supplier_read ON public.sc_skus
    FOR SELECT TO podhub_app
    USING (EXISTS (
        SELECT 1 FROM public.sc_products p
        JOIN public.sc_source_members sm ON sm.source_id = p.source_id
        WHERE p.product_id = sc_skus.product_id
          AND sm.user_id = NULLIF(current_setting('app.current_supplier_user_id', true), '')::bigint
          AND sm.status = 'active'
    ));

DROP POLICY IF EXISTS sc_skus_seller_read ON public.sc_skus;
CREATE POLICY sc_skus_seller_read ON public.sc_skus
    FOR SELECT TO podhub_app
    USING (EXISTS (
        SELECT 1 FROM public.sc_products p
        JOIN public.delegate_bindings b ON b.source_id = p.source_id
        WHERE p.product_id = sc_skus.product_id
          AND b.org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    ));

-- =======================================================================
-- sc_source_offers: the factory COST. Narrow on purpose.
--
-- No generic read arm. A seller or an anonymous visitor reading cost_cents
-- would be able to compute the platform's margin, and nothing on the seller
-- or storefront side needs it.
-- =======================================================================
ALTER TABLE public.sc_source_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sc_source_offers FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sc_source_offers_staff_all ON public.sc_source_offers;
CREATE POLICY sc_source_offers_staff_all ON public.sc_source_offers
    FOR ALL TO podhub_app
    USING (current_setting('app.staff_access', true) = '1')
    WITH CHECK (current_setting('app.staff_access', true) = '1');

-- Plan 8.2 grants the manager "change cost_cents / shipping_cost_cents" and
-- "create / edit / delete sc_products and sc_skus". Those two grants only
-- compose if the manager may also INSERT an offer: a new SKU needs a supply
-- record, and without one the seller's LEFT JOIN yields NULL and the portal
-- renders a silent CNY 0.00 (the same failure fixed in supplier/repo/catalog.go).
--
-- DELETE stays out. A manager removes a row by archiving the product, and the
-- offer row is small and tied to the sku, so leaving it behind is harmless;
-- whereas DELETE plus INSERT is exactly the upsert shape x1 uses, and mirroring
-- it here would let a manager drop an offer by racing a re-create. The manager
-- writer must use INSERT ... ON CONFLICT DO UPDATE instead, which needs only
-- INSERT + UPDATE and cannot destroy the row.
DROP POLICY IF EXISTS sc_source_offers_manager_all ON public.sc_source_offers;
DROP POLICY IF EXISTS sc_source_offers_manager_read ON public.sc_source_offers;
DROP POLICY IF EXISTS sc_source_offers_manager_insert ON public.sc_source_offers;
CREATE POLICY sc_source_offers_manager_insert ON public.sc_source_offers
    FOR INSERT TO podhub_app
    WITH CHECK (EXISTS (
        SELECT 1 FROM public.sc_catalog_managers m
        WHERE m.source_id = sc_source_offers.source_id
          AND m.user_id = NULLIF(current_setting('app.current_org_user_id', true), '')::bigint
          AND m.status = 'active'
    ));
CREATE POLICY sc_source_offers_manager_read ON public.sc_source_offers
    FOR SELECT TO podhub_app
    USING (EXISTS (
        SELECT 1 FROM public.sc_catalog_managers m
        WHERE m.source_id = sc_source_offers.source_id
          AND m.user_id = NULLIF(current_setting('app.current_org_user_id', true), '')::bigint
          AND m.status = 'active'
    ));

DROP POLICY IF EXISTS sc_source_offers_manager_update ON public.sc_source_offers;
CREATE POLICY sc_source_offers_manager_update ON public.sc_source_offers
    FOR UPDATE TO podhub_app
    USING (EXISTS (
        SELECT 1 FROM public.sc_catalog_managers m
        WHERE m.source_id = sc_source_offers.source_id
          AND m.user_id = NULLIF(current_setting('app.current_org_user_id', true), '')::bigint
          AND m.status = 'active'
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM public.sc_catalog_managers m
        WHERE m.source_id = sc_source_offers.source_id
          AND m.user_id = NULLIF(current_setting('app.current_org_user_id', true), '')::bigint
          AND m.status = 'active'
    ));

DROP POLICY IF EXISTS sc_source_offers_supplier_read ON public.sc_source_offers;
CREATE POLICY sc_source_offers_supplier_read ON public.sc_source_offers
    FOR SELECT TO podhub_app
    USING (EXISTS (
        SELECT 1 FROM public.sc_source_members sm
        WHERE sm.source_id = sc_source_offers.source_id
          AND sm.user_id = NULLIF(current_setting('app.current_supplier_user_id', true), '')::bigint
          AND sm.status = 'active'
    ));

-- There is deliberately NO seller-settlement read arm here.
--
-- An arm keyed on "the seller has a dispatch from this source" is not a
-- settlement read: it exposes EVERY offer of that source, because the join
-- can only reach source_id, not the offer_ids inside the dispatch payload.
-- One dispatch would therefore hand the seller the factory's whole cost
-- sheet and let it reconstruct the platform's margin.
--
-- The settlement path does not need the arm: delegate/settle runs inside
-- lockedOrgWrite / Receipt, which both set app.staff_access = '1' before
-- reading, so the staff_all arm above serves it.

-- =======================================================================
-- sc_price_versions: the platform SELLING price.
--
-- The manager arm is FOR SELECT only. Price history is an audit record: a
-- catalog manager may read what a price was and when it changed, but must not
-- rewrite history or insert a version. Price writes stay with staff.
-- =======================================================================
ALTER TABLE public.sc_price_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sc_price_versions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sc_price_versions_staff_all ON public.sc_price_versions;
CREATE POLICY sc_price_versions_staff_all ON public.sc_price_versions
    FOR ALL TO podhub_app
    USING (current_setting('app.staff_access', true) = '1')
    WITH CHECK (current_setting('app.staff_access', true) = '1');

DROP POLICY IF EXISTS sc_price_versions_manager_read ON public.sc_price_versions;
CREATE POLICY sc_price_versions_manager_read ON public.sc_price_versions
    FOR SELECT TO podhub_app
    USING (EXISTS (
        SELECT 1 FROM public.sc_skus k
        JOIN public.sc_products p ON p.product_id = k.product_id
        JOIN public.sc_catalog_managers m ON m.source_id = p.source_id
        WHERE k.sku_id = sc_price_versions.sku_id
          AND m.user_id = NULLIF(current_setting('app.current_org_user_id', true), '')::bigint
          AND m.status = 'active'
    ));

-- Selling price of a published SKU is reference data: it is what the seller
-- pays the platform, and listing cards quote it.
DROP POLICY IF EXISTS sc_price_versions_published_read ON public.sc_price_versions;
CREATE POLICY sc_price_versions_published_read ON public.sc_price_versions
    FOR SELECT TO podhub_app
    USING (EXISTS (
        SELECT 1 FROM public.sc_skus k
        WHERE k.sku_id = sc_price_versions.sku_id AND k.published
    ));

DROP POLICY IF EXISTS sc_price_versions_supplier_read ON public.sc_price_versions;
CREATE POLICY sc_price_versions_supplier_read ON public.sc_price_versions
    FOR SELECT TO podhub_app
    USING (EXISTS (
        SELECT 1 FROM public.sc_skus k
        JOIN public.sc_products p ON p.product_id = k.product_id
        JOIN public.sc_source_members sm ON sm.source_id = p.source_id
        WHERE k.sku_id = sc_price_versions.sku_id
          AND sm.user_id = NULLIF(current_setting('app.current_supplier_user_id', true), '')::bigint
          AND sm.status = 'active'
    ));

DROP POLICY IF EXISTS sc_price_versions_seller_read ON public.sc_price_versions;
CREATE POLICY sc_price_versions_seller_read ON public.sc_price_versions
    FOR SELECT TO podhub_app
    USING (EXISTS (
        SELECT 1 FROM public.sc_skus k
        JOIN public.sc_products p ON p.product_id = k.product_id
        JOIN public.delegate_bindings b ON b.source_id = p.source_id
        WHERE k.sku_id = sc_price_versions.sku_id
          AND b.org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    ));

-- =======================================================================
-- Manager column guard on sc_sources.
--
-- Plan 8.2 lets a catalog manager edit its own source row but reserves two
-- flags to the platform: `listed` (is this factory on the storefront) and
-- `accepts_delegate` (does it take delegate work). A RLS WITH CHECK cannot
-- express "this column may not change" because it only sees the NEW row --
-- referencing OLD there is rejected by PostgreSQL. So the restriction is a
-- trigger: it runs for every UPDATE, and it compares OLD/NEW only when the
-- session is a manager session (staff passes, because staff_all is the
-- platform's own arm).
-- =======================================================================
CREATE OR REPLACE FUNCTION public.sc_sources_manager_pin_flags()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $pin$
BEGIN
    -- Staff bypass the pin; the staff_all policy is the platform's own arm.
    IF COALESCE(current_setting('app.staff_access', true) = '1', false) THEN
        RETURN NEW;
    END IF;
    -- Only a manager session can reach an UPDATE at all (that is the only
    -- write arm for podhub_app outside staff), but guard the check anyway:
    -- an unknown session must not inherit the bypass by accident.
    IF NOT EXISTS (
        SELECT 1 FROM public.sc_catalog_managers m
        WHERE m.source_id = OLD.source_id
          AND m.user_id = NULLIF(current_setting('app.current_org_user_id', true), '')::bigint
          AND m.status = 'active'
    ) THEN
        RETURN NEW;
    END IF;
    IF NEW.listed IS DISTINCT FROM OLD.listed
       OR NEW.accepts_delegate IS DISTINCT FROM OLD.accepts_delegate THEN
        RAISE EXCEPTION 'CATALOG_MANAGER_FLAG_FORBIDDEN'
            USING DETAIL = 'listed and accepts_delegate are platform-only'
                  ', a catalog manager may not change them';
    END IF;
    RETURN NEW;
END
$pin$;

DROP TRIGGER IF EXISTS trg_sc_sources_manager_pin_flags ON public.sc_sources;
CREATE TRIGGER trg_sc_sources_manager_pin_flags
    BEFORE UPDATE ON public.sc_sources
    FOR EACH ROW
    EXECUTE FUNCTION public.sc_sources_manager_pin_flags();

-- =======================================================================
-- Assert the flags rather than trusting the statements above.
-- =======================================================================
DO $guard$
DECLARE
    v_bad text;
BEGIN
    SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO v_bad
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN ('sc_sources','sc_source_prop_defs','sc_products',
                        'sc_skus','sc_source_offers','sc_price_versions')
      AND NOT (c.relrowsecurity AND c.relforcerowsecurity);
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION '00365: RLS not enabled+forced on %', v_bad;
    END IF;
END
$guard$;

-- +goose StatementEnd

-- +goose Down
-- Rust down() refuses a destructive rollback.
-- +goose StatementBegin
SELECT 1;
-- +goose StatementEnd
