-- +goose Up
-- 00361 source roles: who may fulfil a source, and who may manage its catalog.
--
-- Two separate tables, not one table with a role column. The two grants are
-- genuinely different: a source has exactly one active fulfiller (the person
-- who may accept and ship packets, and therefore trigger holds and payouts),
-- and any number of catalog managers (read-only product and price visibility
-- over their own source). Modelling them together would force every query to
-- remember which subset it means.
--
-- Both hang off account_users.id, NOT sc_source_members.member_id. Member rows
-- are physically deleted when a member is removed (accounts.go:161 deletes by
-- member_id; :296 deletes members on rebind), so a grant stored against a
-- member id would vanish with the member. Historical packets must still
-- resolve their fulfiller after the membership row is gone.
-- +goose StatementBegin

CREATE TABLE IF NOT EXISTS public.sc_source_fulfillers (
    fulfiller_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id     text NOT NULL REFERENCES public.sc_sources (source_id) ON DELETE RESTRICT,
    user_id       bigint NOT NULL REFERENCES public.account_users (id) ON DELETE RESTRICT,
    status        text NOT NULL DEFAULT 'active',
    created_by    bigint REFERENCES public.account_users (id) ON DELETE RESTRICT,
    created_at_ms bigint NOT NULL,
    revoked_by    bigint REFERENCES public.account_users (id) ON DELETE RESTRICT,
    revoked_at_ms bigint,
    CONSTRAINT ck_sc_source_fulfillers_status
        CHECK (status IN ('active', 'disabled')),
    CONSTRAINT ck_sc_source_fulfillers_revoked
        CHECK ((status = 'disabled') = (revoked_at_ms IS NOT NULL)),
    CONSTRAINT ux_sc_source_fulfillers_user UNIQUE (source_id, user_id)
);

-- Exactly one active fulfiller per source. Partial, because disabled rows stay
-- for the audit trail. This is the constraint dispatch relies on: with two
-- active fulfillers it cannot decide who gets a packet without guessing.
CREATE UNIQUE INDEX IF NOT EXISTS ux_sc_source_fulfillers_one_active
    ON public.sc_source_fulfillers (source_id) WHERE status = 'active';

-- The composite FK on delegate_dispatches (source_id, fulfiller_id) needs a
-- UNIQUE covering exactly those two columns; the primary key alone is not
-- enough. This also guarantees a packet cannot name a fulfiller of another
-- source at the schema level.
ALTER TABLE public.sc_source_fulfillers
    ADD CONSTRAINT ux_sc_source_fulfillers_source UNIQUE (source_id, fulfiller_id);

CREATE TABLE IF NOT EXISTS public.sc_catalog_managers (
    manager_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id     text NOT NULL REFERENCES public.sc_sources (source_id) ON DELETE RESTRICT,
    user_id       bigint NOT NULL REFERENCES public.account_users (id) ON DELETE RESTRICT,
    status        text NOT NULL DEFAULT 'active',
    created_by    bigint REFERENCES public.account_users (id) ON DELETE RESTRICT,
    created_at_ms bigint NOT NULL,
    revoked_by    bigint REFERENCES public.account_users (id) ON DELETE RESTRICT,
    revoked_at_ms bigint,
    CONSTRAINT ck_sc_catalog_managers_status
        CHECK (status IN ('active', 'disabled')),
    CONSTRAINT ck_sc_catalog_managers_revoked
        CHECK ((status = 'disabled') = (revoked_at_ms IS NOT NULL)),
    CONSTRAINT ux_sc_catalog_managers_user UNIQUE (source_id, user_id)
);

CREATE INDEX IF NOT EXISTS ix_sc_catalog_managers_user_active
    ON public.sc_catalog_managers (user_id) WHERE status = 'active';

-- Lookup path for the manager gate: 'is this user an active manager of this
-- source'. Dispatch does not use it; the catalog surface does.
CREATE INDEX IF NOT EXISTS ix_sc_catalog_managers_source_active
    ON public.sc_catalog_managers (source_id) WHERE status = 'active';

-- =======================================================================
-- Backfill: the oldest active member of each source becomes its fulfiller.
--
-- Before this batch any active member of a source could accept that source's
-- packets (00203 let all of them through). Promoting all of them would preserve
-- behaviour but violate the one-active-fulfiller rule, so the oldest active
-- member is the deterministic choice and the only one that keeps dispatch
-- working without an operator decision.
--
-- A source whose members are all inactive gets no fulfiller. Dispatch then
-- records dispatch_blocked_reason = 'no_fulfiller' until an admin grants one:
-- fail-closed, which is the intended behaviour rather than an oversight.
-- =======================================================================
INSERT INTO public.sc_source_fulfillers (source_id, user_id, created_at_ms)
SELECT DISTINCT ON (m.source_id)
       m.source_id,
       m.user_id,
       (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint
  FROM public.sc_source_members m
 WHERE m.status = 'active'
 ORDER BY m.source_id, m.created_at_ms, m.user_id
ON CONFLICT DO NOTHING;

-- =======================================================================
-- RLS. Both are authorization tables: a supplier reads its OWN grant rows
-- (the portal shows who the fulfiller is) but never another source's, and
-- never writes. Staff see everything through app.staff_access, which
-- BeginStaff/WithTx set. BeginAdmin does NOT set it (admin/core/repo/staff.go:15-25),
-- so admin reads go through the staff transaction, not a bare app session.
-- =======================================================================
ALTER TABLE public.sc_source_fulfillers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sc_source_fulfillers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sc_source_fulfillers_member_read ON public.sc_source_fulfillers;
CREATE POLICY sc_source_fulfillers_member_read ON public.sc_source_fulfillers
    FOR SELECT TO podhub_app
    USING (user_id = NULLIF(current_setting('app.current_supplier_user_id', true), '')::bigint);
DROP POLICY IF EXISTS sc_source_fulfillers_staff_all ON public.sc_source_fulfillers;
CREATE POLICY sc_source_fulfillers_staff_all ON public.sc_source_fulfillers
    FOR ALL TO podhub_app
    USING (current_setting('app.staff_access', true) = '1')
    WITH CHECK (current_setting('app.staff_access', true) = '1');

ALTER TABLE public.sc_catalog_managers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sc_catalog_managers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sc_catalog_managers_member_read ON public.sc_catalog_managers;
CREATE POLICY sc_catalog_managers_member_read ON public.sc_catalog_managers
    FOR SELECT TO podhub_app
    USING (user_id = NULLIF(current_setting('app.current_org_user_id', true), '')::bigint);
DROP POLICY IF EXISTS sc_catalog_managers_staff_all ON public.sc_catalog_managers;
CREATE POLICY sc_catalog_managers_staff_all ON public.sc_catalog_managers
    FOR ALL TO podhub_app
    USING (current_setting('app.staff_access', true) = '1')
    WITH CHECK (current_setting('app.staff_access', true) = '1');

-- +goose StatementEnd

-- +goose Down
-- Rust down() refuses a destructive rollback.
-- +goose StatementBegin
SELECT 1;
-- +goose StatementEnd
