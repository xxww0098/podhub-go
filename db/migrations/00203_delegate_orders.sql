-- +goose Up
-- declaration 203 DelegateOrders m20260921_110000_delegate_orders
-- source: migration/src/delegate_orders.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.sc_sources
    ADD COLUMN IF NOT EXISTS accepts_delegate boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.sc_source_members (
    member_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id text NOT NULL REFERENCES public.sc_sources(source_id) ON DELETE RESTRICT,
    user_id bigint NOT NULL REFERENCES public.account_users(id) ON DELETE RESTRICT,
    role text NOT NULL DEFAULT 'member',
    status text NOT NULL DEFAULT 'active',
    created_by bigint NOT NULL REFERENCES public.account_users(id),
    created_at_ms bigint NOT NULL,
    CONSTRAINT ux_sc_source_members_source_user UNIQUE (source_id, user_id),
    CONSTRAINT ck_sc_source_members_role CHECK (role = 'member'),
    CONSTRAINT ck_sc_source_members_status CHECK (status IN ('active', 'disabled'))
);

CREATE TABLE IF NOT EXISTS public.delegate_bindings (
    binding_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id bigint NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
    store_id uuid NOT NULL,
    offer_id text NOT NULL,
    source_id text NOT NULL REFERENCES public.sc_sources(source_id) ON DELETE RESTRICT,
    note text NOT NULL DEFAULT '',
    active boolean NOT NULL DEFAULT true,
    revision bigint NOT NULL DEFAULT 1,
    created_by bigint NOT NULL REFERENCES public.account_users(id),
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT ux_delegate_bindings_store_offer UNIQUE (org_id, store_id, offer_id),
    CONSTRAINT ck_delegate_bindings_offer_id
        CHECK (offer_id = NULLIF(btrim(offer_id), '')),
    CONSTRAINT ck_delegate_bindings_revision CHECK (revision >= 1)
);

CREATE TABLE IF NOT EXISTS public.delegate_assets (
    asset_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id bigint NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
    binding_id uuid NOT NULL REFERENCES public.delegate_bindings(binding_id) ON DELETE CASCADE,
    object_key text NOT NULL,
    object_url text NOT NULL DEFAULT '',
    sha256 text NOT NULL,
    bytes bigint NOT NULL,
    mime text NOT NULL,
    file_name text NOT NULL,
    position integer NOT NULL DEFAULT 0,
    verified_at_ms bigint,
    created_at_ms bigint NOT NULL,
    CONSTRAINT ux_delegate_assets_object_key UNIQUE (org_id, object_key),
    CONSTRAINT ck_delegate_assets_sha256 CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_delegate_assets_bytes CHECK (bytes > 0)
);

CREATE TABLE IF NOT EXISTS public.delegate_orders (
    order_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id bigint NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
    store_id uuid NOT NULL,
    posting_number text NOT NULL,
    seller_note text NOT NULL DEFAULT '',
    posting_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
    logistics jsonb,
    amount_snapshot jsonb,
    cancel_requested boolean NOT NULL DEFAULT false,
    state text NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT ux_delegate_orders_posting UNIQUE (org_id, store_id, posting_number),
    CONSTRAINT ck_delegate_orders_state CHECK (state IN (
        'awaiting_setup', 'ready', 'dispatched', 'in_production',
        'shipped', 'done', 'cancelled'
    ))
);

CREATE TABLE IF NOT EXISTS public.delegate_order_lines (
    line_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id bigint NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
    order_id uuid NOT NULL REFERENCES public.delegate_orders(order_id) ON DELETE CASCADE,
    offer_id text NOT NULL,
    sku bigint NOT NULL DEFAULT 0,
    name text NOT NULL DEFAULT '',
    quantity integer NOT NULL,
    binding_id uuid REFERENCES public.delegate_bindings(binding_id) ON DELETE RESTRICT,
    last_rejected_source_id text REFERENCES public.sc_sources(source_id) ON DELETE SET NULL,
    CONSTRAINT ux_delegate_order_lines_offer UNIQUE (order_id, offer_id),
    CONSTRAINT ck_delegate_order_lines_quantity CHECK (quantity >= 1)
);

CREATE TABLE IF NOT EXISTS public.delegate_dispatches (
    dispatch_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id bigint NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
    order_id uuid NOT NULL REFERENCES public.delegate_orders(order_id) ON DELETE CASCADE,
    source_id text NOT NULL REFERENCES public.sc_sources(source_id) ON DELETE RESTRICT,
    dispatch_no text NOT NULL,
    payload jsonb NOT NULL,
    state text NOT NULL DEFAULT 'dispatched',
    receipt jsonb,
    attempted_by text NOT NULL DEFAULT 'auto',
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT ux_delegate_dispatches_no UNIQUE (dispatch_no),
    CONSTRAINT ck_delegate_dispatches_state CHECK (state IN (
        'dispatched', 'accepted', 'shipped', 'rejected', 'cancelled'
    ))
);

-- At most one live packet per (order, source): rejected / cancelled / shipped
-- packets do not block a re-dispatch to the same factory.
CREATE UNIQUE INDEX IF NOT EXISTS ux_delegate_dispatches_live
    ON public.delegate_dispatches (order_id, source_id)
    WHERE state = 'dispatched';

-- GC reference-count index only: no other read path. asset_id is a soft
-- reference on purpose — removing an asset row must not un-count the packets
-- that still hold the frozen object identity.
CREATE TABLE IF NOT EXISTS public.delegate_dispatch_assets (
    dispatch_id uuid NOT NULL REFERENCES public.delegate_dispatches(dispatch_id) ON DELETE CASCADE,
    asset_id uuid NOT NULL,
    org_id bigint NOT NULL,
    PRIMARY KEY (dispatch_id, asset_id)
);

CREATE INDEX IF NOT EXISTS ix_sc_source_members_user
    ON public.sc_source_members (user_id);
CREATE INDEX IF NOT EXISTS ix_sc_source_members_source
    ON public.sc_source_members (source_id);
CREATE INDEX IF NOT EXISTS ix_delegate_bindings_store
    ON public.delegate_bindings (org_id, store_id);
CREATE INDEX IF NOT EXISTS ix_delegate_bindings_source
    ON public.delegate_bindings (source_id);
CREATE INDEX IF NOT EXISTS ix_delegate_assets_binding
    ON public.delegate_assets (binding_id);
CREATE INDEX IF NOT EXISTS ix_delegate_orders_store_state
    ON public.delegate_orders (org_id, store_id, state);
CREATE INDEX IF NOT EXISTS ix_delegate_order_lines_order
    ON public.delegate_order_lines (order_id);
CREATE INDEX IF NOT EXISTS ix_delegate_order_lines_binding
    ON public.delegate_order_lines (binding_id);
CREATE INDEX IF NOT EXISTS ix_delegate_dispatches_source_state
    ON public.delegate_dispatches (source_id, state);
CREATE INDEX IF NOT EXISTS ix_delegate_dispatches_order
    ON public.delegate_dispatches (order_id);
CREATE INDEX IF NOT EXISTS ix_delegate_dispatch_assets_asset
    ON public.delegate_dispatch_assets (asset_id);

ALTER TABLE public.sc_source_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sc_source_members FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS supplier_member_self_isolation ON public.sc_source_members;
CREATE POLICY supplier_member_self_isolation ON public.sc_source_members
    FOR ALL TO podhub_app
    USING (user_id = NULLIF(current_setting('app.current_supplier_user_id', true), '')::bigint)
    WITH CHECK (user_id = NULLIF(current_setting('app.current_supplier_user_id', true), '')::bigint);
DROP POLICY IF EXISTS supplier_member_staff_isolation ON public.sc_source_members;
CREATE POLICY supplier_member_staff_isolation ON public.sc_source_members
    FOR ALL TO podhub_app
    USING (current_setting('app.staff_access', true) = '1')
    WITH CHECK (current_setting('app.staff_access', true) = '1');

ALTER TABLE public.delegate_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delegate_bindings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS delegate_org_isolation ON public.delegate_bindings;
CREATE POLICY delegate_org_isolation ON public.delegate_bindings
    FOR ALL TO podhub_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint);
DROP POLICY IF EXISTS delegate_staff_isolation ON public.delegate_bindings;
CREATE POLICY delegate_staff_isolation ON public.delegate_bindings
    FOR ALL TO podhub_app
    USING (current_setting('app.staff_access', true) = '1')
    WITH CHECK (current_setting('app.staff_access', true) = '1');

ALTER TABLE public.delegate_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delegate_assets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS delegate_org_isolation ON public.delegate_assets;
CREATE POLICY delegate_org_isolation ON public.delegate_assets
    FOR ALL TO podhub_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint);
DROP POLICY IF EXISTS delegate_staff_isolation ON public.delegate_assets;
CREATE POLICY delegate_staff_isolation ON public.delegate_assets
    FOR ALL TO podhub_app
    USING (current_setting('app.staff_access', true) = '1')
    WITH CHECK (current_setting('app.staff_access', true) = '1');

ALTER TABLE public.delegate_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delegate_orders FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS delegate_org_isolation ON public.delegate_orders;
CREATE POLICY delegate_org_isolation ON public.delegate_orders
    FOR ALL TO podhub_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint);
DROP POLICY IF EXISTS delegate_staff_isolation ON public.delegate_orders;
CREATE POLICY delegate_staff_isolation ON public.delegate_orders
    FOR ALL TO podhub_app
    USING (current_setting('app.staff_access', true) = '1')
    WITH CHECK (current_setting('app.staff_access', true) = '1');

ALTER TABLE public.delegate_order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delegate_order_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS delegate_org_isolation ON public.delegate_order_lines;
CREATE POLICY delegate_org_isolation ON public.delegate_order_lines
    FOR ALL TO podhub_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint);
DROP POLICY IF EXISTS delegate_staff_isolation ON public.delegate_order_lines;
CREATE POLICY delegate_staff_isolation ON public.delegate_order_lines
    FOR ALL TO podhub_app
    USING (current_setting('app.staff_access', true) = '1')
    WITH CHECK (current_setting('app.staff_access', true) = '1');

ALTER TABLE public.delegate_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delegate_dispatches FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS delegate_org_isolation ON public.delegate_dispatches;
CREATE POLICY delegate_org_isolation ON public.delegate_dispatches
    FOR ALL TO podhub_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint);
DROP POLICY IF EXISTS delegate_staff_isolation ON public.delegate_dispatches;
CREATE POLICY delegate_staff_isolation ON public.delegate_dispatches
    FOR ALL TO podhub_app
    USING (current_setting('app.staff_access', true) = '1')
    WITH CHECK (current_setting('app.staff_access', true) = '1');
-- Supplier arm: an active member of the packet's source factory reads the
-- packet without holding any Workspace. The subquery runs under the same
-- self-isolation arm of sc_source_members, so it composes with the GUC the
-- supplier middleware sets per request.
DROP POLICY IF EXISTS delegate_source_isolation ON public.delegate_dispatches;
CREATE POLICY delegate_source_isolation ON public.delegate_dispatches
    FOR ALL TO podhub_app
    USING (EXISTS (
        SELECT 1 FROM public.sc_source_members m
        WHERE m.source_id = delegate_dispatches.source_id
          AND m.user_id = NULLIF(current_setting('app.current_supplier_user_id', true), '')::bigint
          AND m.status = 'active'
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM public.sc_source_members m
        WHERE m.source_id = delegate_dispatches.source_id
          AND m.user_id = NULLIF(current_setting('app.current_supplier_user_id', true), '')::bigint
          AND m.status = 'active'
    ));

ALTER TABLE public.delegate_dispatch_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delegate_dispatch_assets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS delegate_org_isolation ON public.delegate_dispatch_assets;
CREATE POLICY delegate_org_isolation ON public.delegate_dispatch_assets
    FOR ALL TO podhub_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint);
DROP POLICY IF EXISTS delegate_staff_isolation ON public.delegate_dispatch_assets;
CREATE POLICY delegate_staff_isolation ON public.delegate_dispatch_assets
    FOR ALL TO podhub_app
    USING (current_setting('app.staff_access', true) = '1')
    WITH CHECK (current_setting('app.staff_access', true) = '1');

-- 卖家侧「无活跃成员」警告（spec §E.28）的唯一合法读面：SECURITY DEFINER
-- 只泄漏计数，成员行（email 等）留在 sc_source_members 的自读臂后面。
CREATE OR REPLACE FUNCTION public.delegate_source_active_member_count(p_source_id text)
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT count(*)::bigint FROM public.sc_source_members
    WHERE source_id = p_source_id AND status = 'active';
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
    public.sc_source_members,
    public.delegate_bindings,
    public.delegate_assets,
    public.delegate_orders,
    public.delegate_order_lines,
    public.delegate_dispatches,
    public.delegate_dispatch_assets
TO podhub_app, podhub_worker;

GRANT EXECUTE ON FUNCTION public.delegate_source_active_member_count(text)
TO podhub_app, podhub_worker;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
