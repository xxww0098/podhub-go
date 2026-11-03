-- +goose Up
-- Factories own members independently of the product libraries bound to them.
CREATE TABLE public.sc_factories (
    factory_id text PRIMARY KEY,
    name text NOT NULL UNIQUE,
    country text NOT NULL DEFAULT '',
    contact text NOT NULL DEFAULT '',
    internal_note text NOT NULL DEFAULT '',
    icon text NOT NULL DEFAULT '',
    created_by_account_uuid text NOT NULL DEFAULT '',
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL
);

INSERT INTO public.sc_factories
    (factory_id, name, country, contact, internal_note, icon, created_by_account_uuid, created_at_ms, updated_at_ms)
SELECT s.source_id, s.name, s.country, s.contact, s.internal_note, s.icon,
       s.created_by_account_uuid, s.created_at_ms, s.updated_at_ms
FROM public.sc_sources s
WHERE s.source_id <> 'src_unassigned'
   OR EXISTS (SELECT 1 FROM public.sc_source_members m WHERE m.source_id = s.source_id);

ALTER TABLE public.sc_sources ADD COLUMN factory_id text REFERENCES public.sc_factories(factory_id) ON DELETE RESTRICT;
UPDATE public.sc_sources s SET factory_id = s.source_id
WHERE EXISTS (SELECT 1 FROM public.sc_factories f WHERE f.factory_id = s.source_id);
CREATE INDEX ix_sc_sources_factory ON public.sc_sources(factory_id);

ALTER TABLE public.sc_source_members DROP CONSTRAINT sc_source_members_source_id_fkey;
ALTER TABLE public.sc_source_members RENAME TO sc_factory_members;
ALTER TABLE public.sc_factory_members RENAME COLUMN source_id TO factory_id;
ALTER TABLE public.sc_factory_members ADD CONSTRAINT sc_factory_members_factory_id_fkey
    FOREIGN KEY (factory_id) REFERENCES public.sc_factories(factory_id) ON DELETE RESTRICT;
ALTER TABLE public.sc_factory_members RENAME CONSTRAINT ux_sc_source_members_source_user TO ux_sc_factory_members_factory_user;
ALTER INDEX public.ix_sc_source_members_source RENAME TO ix_sc_factory_members_factory;
ALTER INDEX public.ix_sc_source_members_user RENAME TO ix_sc_factory_members_user;
ALTER TRIGGER sc_source_members_account_kind ON public.sc_factory_members RENAME TO sc_factory_members_account_kind;
DROP TRIGGER sc_source_members_identity_immutable ON public.sc_factory_members;

-- +goose StatementBegin
CREATE FUNCTION public.factory_member_identity_is_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'factory_member_identity_immutable: member cannot change account or factory';
END;
$$;
-- +goose StatementEnd
CREATE TRIGGER sc_factory_members_identity_immutable BEFORE UPDATE OF factory_id, user_id ON public.sc_factory_members
    FOR EACH ROW WHEN (NEW.factory_id IS DISTINCT FROM OLD.factory_id OR NEW.user_id IS DISTINCT FROM OLD.user_id)
    EXECUTE FUNCTION public.factory_member_identity_is_immutable();

ALTER TABLE public.sc_factories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sc_factories FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sc_factories TO podhub_app, podhub_worker;
CREATE POLICY sc_factories_staff_all ON public.sc_factories TO podhub_app
    USING (current_setting('app.staff_access', true) = '1')
    WITH CHECK (current_setting('app.staff_access', true) = '1');
CREATE POLICY sc_factories_supplier_read ON public.sc_factories FOR SELECT TO podhub_app
    USING (EXISTS (SELECT 1 FROM public.sc_factory_members m
        WHERE m.factory_id = sc_factories.factory_id AND m.status = 'active'
          AND m.user_id = NULLIF(current_setting('app.current_supplier_user_id', true), '')::bigint));

-- +goose StatementBegin
CREATE FUNCTION public.supplier_member_of_source(p_source_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO pg_catalog, public AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.sc_sources s
        JOIN public.sc_factory_members m ON m.factory_id = s.factory_id
        WHERE s.source_id = p_source_id AND m.status = 'active'
          AND m.user_id = NULLIF(current_setting('app.current_supplier_user_id', true), '')::bigint
    );
$$;
-- +goose StatementEnd
REVOKE ALL ON FUNCTION public.supplier_member_of_source(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.supplier_member_of_source(text) TO podhub_app;

DROP POLICY sc_sources_supplier_read ON public.sc_sources;
CREATE POLICY sc_sources_supplier_read ON public.sc_sources FOR SELECT TO podhub_app
    USING (public.supplier_member_of_source(source_id));
DROP POLICY sc_products_supplier_read ON public.sc_products;
CREATE POLICY sc_products_supplier_read ON public.sc_products FOR SELECT TO podhub_app
    USING (public.supplier_member_of_source(source_id));
DROP POLICY sc_source_offers_supplier_read ON public.sc_source_offers;
CREATE POLICY sc_source_offers_supplier_read ON public.sc_source_offers FOR SELECT TO podhub_app
    USING (public.supplier_member_of_source(source_id));
DROP POLICY sc_source_prop_defs_supplier_read ON public.sc_source_prop_defs;
CREATE POLICY sc_source_prop_defs_supplier_read ON public.sc_source_prop_defs FOR SELECT TO podhub_app
    USING (public.supplier_member_of_source(source_id));
DROP POLICY sc_skus_supplier_read ON public.sc_skus;
CREATE POLICY sc_skus_supplier_read ON public.sc_skus FOR SELECT TO podhub_app USING (EXISTS (
    SELECT 1 FROM public.sc_products p WHERE p.product_id = sc_skus.product_id
      AND public.supplier_member_of_source(p.source_id)
));
DROP POLICY sc_price_versions_supplier_read ON public.sc_price_versions;
CREATE POLICY sc_price_versions_supplier_read ON public.sc_price_versions FOR SELECT TO podhub_app USING (EXISTS (
    SELECT 1 FROM public.sc_skus k JOIN public.sc_products p ON p.product_id = k.product_id
    WHERE k.sku_id = sc_price_versions.sku_id AND public.supplier_member_of_source(p.source_id)
));

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION public.delegate_source_active_member_count(p_source_id text) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO public AS $$
    SELECT count(*)::bigint FROM public.sc_sources s
    JOIN public.sc_factory_members m ON m.factory_id = s.factory_id
    WHERE s.source_id = p_source_id AND m.status = 'active';
$$;
-- +goose StatementEnd

-- +goose Down
-- One factory can have multiple libraries; collapsing them would discard identity.
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'factory/catalog separation cannot be rolled back without data loss'; END $$;
-- +goose StatementEnd
