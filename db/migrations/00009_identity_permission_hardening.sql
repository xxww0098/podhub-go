-- +goose Up
-- Hardening of the permission, user and supplier-chain user tables. Every rule
-- here closes a hole that was reproduced against the 00001-00008 schema; the
-- matching tests are tests/integration/identity_hardening_test.go.
--
-- Existing rows that break a new rule make this migration fail instead of
-- being rewritten, except where the data is disposable (session and reset
-- tokens) or only differs by case or padding (role).
-- +goose StatementBegin

-- ---------------------------------------------------------------- data checks
DO $$
DECLARE
    bad bigint;
BEGIN
    SELECT count(*) INTO bad FROM public.sc_source_members m
      LEFT JOIN public.account_users u ON u.id = m.user_id
     WHERE u.account_kind IS DISTINCT FROM 'supplier';
    IF bad > 0 THEN RAISE EXCEPTION '% sc_source_members rows point at a non-supplier account', bad; END IF;
    SELECT count(*) INTO bad FROM public.sc_source_fulfillers f
      LEFT JOIN public.account_users u ON u.id = f.user_id
     WHERE u.account_kind IS DISTINCT FROM 'supplier';
    IF bad > 0 THEN RAISE EXCEPTION '% sc_source_fulfillers rows point at a non-supplier account', bad; END IF;
    SELECT count(*) INTO bad FROM public.sc_catalog_managers c
      LEFT JOIN public.account_users u ON u.id = c.user_id
     WHERE u.account_kind IS DISTINCT FROM 'platform';
    IF bad > 0 THEN RAISE EXCEPTION '% sc_catalog_managers rows point at a non-platform account', bad; END IF;
END
$$;

-- Sessions and reset tokens are disposable. Rows for a missing user or whose
-- key is not a SHA-256 digest cannot be valid logins; dropping them signs the
-- holder out, nothing else.
DELETE FROM public.account_sessions s
 WHERE s.token_hash !~ '^[0-9a-f]{64}$'
    OR NOT EXISTS (SELECT 1 FROM public.account_users u WHERE u.id = s.user_id);
DELETE FROM public.auth_email_tokens WHERE token_hash !~ '^[0-9a-f]{64}$';

-- Go compares role with trim and ASCII lower; SQL compared exactly.
UPDATE public.account_users SET role = lower(btrim(role)) WHERE role <> lower(btrim(role));

-- --------------------------------------------------------------- account_users
ALTER TABLE public.account_users
    ADD CONSTRAINT ck_account_users_role CHECK (role IN ('user', 'admin', 'super_admin')),
    ADD CONSTRAINT ck_account_users_email_shape CHECK (
        email = btrim(email)
        AND email ~ '^[^@[:space:]]+@[^@[:space:].]+(\.[^@[:space:].]+)+$'),
    ADD CONSTRAINT ck_account_users_password_hash CHECK (btrim(password_hash) <> ''),
    ADD CONSTRAINT account_users_public_id_key UNIQUE (public_id),
    ADD CONSTRAINT account_users_uuid_key UNIQUE (uuid);

ALTER TABLE public.account_credentials
    ADD CONSTRAINT ck_account_credentials_password_hash CHECK (btrim(password_hash) <> '');

-- Once an agent is bound, the inviter, the time, the rate and the source stay.
-- Clearing any of them also counts as a rewrite.
CREATE OR REPLACE FUNCTION public.account_users_attribution_is_write_once() RETURNS trigger
    LANGUAGE plpgsql
    AS $f$
BEGIN
    IF OLD.invited_by_agent_user_id IS NOT NULL
       AND (NEW.invited_by_agent_user_id IS DISTINCT FROM OLD.invited_by_agent_user_id
         OR NEW.agent_attributed_at IS DISTINCT FROM OLD.agent_attributed_at
         OR NEW.agent_attribution_bps IS DISTINCT FROM OLD.agent_attribution_bps
         OR NEW.agent_attribution_source IS DISTINCT FROM OLD.agent_attribution_source) THEN
        RAISE EXCEPTION 'account_users agent attribution is write-once';
    END IF;
    RETURN NEW;
END;
$f$;
DROP TRIGGER account_users_attribution_no_rewrite ON public.account_users;
CREATE TRIGGER account_users_attribution_no_rewrite
    BEFORE UPDATE OF invited_by_agent_user_id, agent_attributed_at, agent_attribution_bps, agent_attribution_source
    ON public.account_users FOR EACH ROW EXECUTE FUNCTION public.account_users_attribution_is_write_once();

-- The grant tables check account_kind when a row is written. A later flip
-- would leave a supplier holding a platform grant or the reverse.
CREATE FUNCTION public.account_users_kind_is_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $f$
BEGIN
    RAISE EXCEPTION 'account_users_kind_immutable: account % keeps kind %', OLD.id, OLD.account_kind;
END;
$f$;
CREATE TRIGGER account_users_kind_immutable
    BEFORE UPDATE OF account_kind ON public.account_users
    FOR EACH ROW WHEN (NEW.account_kind IS DISTINCT FROM OLD.account_kind)
    EXECUTE FUNCTION public.account_users_kind_is_immutable();

-- account_credentials copies the hash and has exactly one writer: the sync
-- trigger. It runs as its owner so the app roles need no write grant on it.
CREATE OR REPLACE FUNCTION public.sync_account_side_tables() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $f$
BEGIN
    INSERT INTO public.account_credentials (user_id, password_hash, updated_at)
    VALUES (NEW.id, NEW.password_hash, NEW.updated_at)
    ON CONFLICT (user_id) DO UPDATE SET
        password_hash = EXCLUDED.password_hash,
        updated_at = EXCLUDED.updated_at;

    INSERT INTO public.account_profiles (
        user_id, name, target, supplier_id, active_org_id, updated_at
    )
    VALUES (
        NEW.id, NEW.name, NEW.target, NEW.supplier_id, NEW.active_org_id, NEW.updated_at
    )
    ON CONFLICT (user_id) DO UPDATE SET
        name = EXCLUDED.name,
        target = EXCLUDED.target,
        supplier_id = EXCLUDED.supplier_id,
        active_org_id = EXCLUDED.active_org_id,
        updated_at = EXCLUDED.updated_at;

    RETURN NEW;
END;
$f$;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.account_credentials FROM podhub_app, podhub_worker;

-- Accounts are disabled, never erased, by the runtime roles.
REVOKE DELETE ON TABLE public.account_users FROM podhub_app, podhub_worker;

-- ------------------------------------------------- sessions and reset tokens
ALTER TABLE public.account_sessions
    ADD CONSTRAINT account_sessions_user_id_fkey FOREIGN KEY (user_id)
        REFERENCES public.account_users(id) ON DELETE CASCADE,
    ADD CONSTRAINT ck_account_sessions_token_hash CHECK (token_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE public.auth_email_tokens
    ADD CONSTRAINT ck_auth_email_tokens_token_hash CHECK (token_hash ~ '^[0-9a-f]{64}$');

-- --------------------------------------------- workspace membership and owners
ALTER TABLE public.organizations
    ADD CONSTRAINT organizations_owner_user_id_fkey FOREIGN KEY (owner_user_id)
        REFERENCES public.account_users(id) ON DELETE RESTRICT;
ALTER TABLE public.organization_members
    ADD CONSTRAINT organization_members_org_id_fkey FOREIGN KEY (org_id)
        REFERENCES public.organizations(id) ON DELETE CASCADE,
    ADD CONSTRAINT organization_members_user_id_fkey FOREIGN KEY (user_id)
        REFERENCES public.account_users(id) ON DELETE CASCADE;
ALTER TABLE public.org_invitations
    ADD CONSTRAINT org_invitations_org_id_fkey FOREIGN KEY (org_id)
        REFERENCES public.organizations(id) ON DELETE CASCADE,
    ADD CONSTRAINT org_invitations_invited_by_user_id_fkey FOREIGN KEY (invited_by_user_id)
        REFERENCES public.account_users(id) ON DELETE CASCADE,
    ADD CONSTRAINT org_invitations_accepted_user_id_fkey FOREIGN KEY (accepted_user_id)
        REFERENCES public.account_users(id) ON DELETE SET NULL,
    ADD CONSTRAINT ck_org_invitations_role CHECK (role IN ('manager', 'member')),
    ADD CONSTRAINT ck_org_invitations_one_terminal_state
        CHECK (num_nonnulls(accepted_at, revoked_at, declined_at) <= 1);

CREATE FUNCTION public.organization_members_identity_is_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $f$
BEGIN
    RAISE EXCEPTION 'organization_members_identity_immutable: membership % cannot move', OLD.id;
END;
$f$;
CREATE TRIGGER organization_members_identity_immutable
    BEFORE UPDATE OF org_id, user_id ON public.organization_members
    FOR EACH ROW WHEN (NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.user_id IS DISTINCT FROM OLD.user_id)
    EXECUTE FUNCTION public.organization_members_identity_is_immutable();

-- A dissolved workspace keeps its row (dissolved_at); nothing deletes it.
REVOKE DELETE ON TABLE public.organizations FROM podhub_app, podhub_worker;

-- ------------------------------------------------------------ support grants
-- A grant is evidence of staff write access to a tenant. It is issued to a
-- live platform admin by a super admin, lasts at most a day, can only be
-- shortened or revoked, and is never deleted by the runtime roles. The 25 h
-- bound is the 24 h the API allows plus slack for app/database clock skew.
ALTER TABLE public.support_grants
    ADD CONSTRAINT support_grants_org_id_fkey FOREIGN KEY (org_id)
        REFERENCES public.organizations(id) ON DELETE RESTRICT,
    ADD CONSTRAINT support_grants_staff_user_id_fkey FOREIGN KEY (staff_user_id)
        REFERENCES public.account_users(id) ON DELETE RESTRICT,
    ADD CONSTRAINT support_grants_created_by_user_id_fkey FOREIGN KEY (created_by_user_id)
        REFERENCES public.account_users(id) ON DELETE RESTRICT,
    ADD CONSTRAINT ck_support_grants_ttl CHECK (expires_at <= created_at + interval '25 hours');

CREATE FUNCTION public.support_grants_check_parties() RETURNS trigger
    LANGUAGE plpgsql
    AS $f$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.account_users
         WHERE id = NEW.staff_user_id AND account_kind = 'platform'
           AND role IN ('admin', 'super_admin') AND disabled_at IS NULL
    ) THEN
        RAISE EXCEPTION 'support_grants_staff_only: account % is not live platform staff', NEW.staff_user_id;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.account_users
         WHERE id = NEW.created_by_user_id AND role = 'super_admin' AND disabled_at IS NULL
    ) THEN
        RAISE EXCEPTION 'support_grants_issuer_super_admin: account % cannot issue grants', NEW.created_by_user_id;
    END IF;
    RETURN NEW;
END;
$f$;
CREATE TRIGGER support_grants_check_parties
    BEFORE INSERT ON public.support_grants
    FOR EACH ROW EXECUTE FUNCTION public.support_grants_check_parties();

CREATE FUNCTION public.support_grants_only_shrink() RETURNS trigger
    LANGUAGE plpgsql
    AS $f$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.org_id IS DISTINCT FROM OLD.org_id
       OR NEW.staff_user_id IS DISTINCT FROM OLD.staff_user_id
       OR NEW.reason IS DISTINCT FROM OLD.reason
       OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR (OLD.revoked_at IS NOT NULL
           AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
             OR NEW.expires_at IS DISTINCT FROM OLD.expires_at))
       OR NEW.expires_at > OLD.expires_at THEN
        RAISE EXCEPTION 'support_grants_immutable: grant % may only be shortened or revoked', OLD.id;
    END IF;
    RETURN NEW;
END;
$f$;
CREATE TRIGGER support_grants_only_shrink
    BEFORE UPDATE ON public.support_grants
    FOR EACH ROW EXECUTE FUNCTION public.support_grants_only_shrink();
REVOKE DELETE ON TABLE public.support_grants FROM podhub_app, podhub_worker;

-- ----------------------------------------------- supplier-chain grant tables
-- sc_source_members and sc_source_fulfillers hold supplier accounts,
-- sc_catalog_managers holds platform accounts. This was only checked in Go.
CREATE FUNCTION public.grant_requires_account_kind() RETURNS trigger
    LANGUAGE plpgsql
    AS $f$
DECLARE
    got text;
BEGIN
    SELECT account_kind INTO got FROM public.account_users WHERE id = NEW.user_id;
    IF got IS DISTINCT FROM TG_ARGV[0] THEN
        RAISE EXCEPTION '%: account % must be a % account', TG_NAME, NEW.user_id, TG_ARGV[0];
    END IF;
    RETURN NEW;
END;
$f$;
CREATE TRIGGER sc_source_members_account_kind BEFORE INSERT ON public.sc_source_members
    FOR EACH ROW EXECUTE FUNCTION public.grant_requires_account_kind('supplier');
CREATE TRIGGER sc_source_fulfillers_account_kind BEFORE INSERT ON public.sc_source_fulfillers
    FOR EACH ROW EXECUTE FUNCTION public.grant_requires_account_kind('supplier');
CREATE TRIGGER sc_catalog_managers_account_kind BEFORE INSERT ON public.sc_catalog_managers
    FOR EACH ROW EXECUTE FUNCTION public.grant_requires_account_kind('platform');

-- A grant row is revoked and revived through status. Moving it to another
-- account or source would turn it into a grant nobody issued.
CREATE FUNCTION public.grant_identity_is_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $f$
BEGIN
    RAISE EXCEPTION 'grant_identity_immutable: % row cannot change account or source', TG_TABLE_NAME;
END;
$f$;
CREATE TRIGGER sc_source_members_identity_immutable BEFORE UPDATE OF source_id, user_id ON public.sc_source_members
    FOR EACH ROW WHEN (NEW.source_id IS DISTINCT FROM OLD.source_id OR NEW.user_id IS DISTINCT FROM OLD.user_id)
    EXECUTE FUNCTION public.grant_identity_is_immutable();
CREATE TRIGGER sc_source_fulfillers_identity_immutable BEFORE UPDATE OF source_id, user_id ON public.sc_source_fulfillers
    FOR EACH ROW WHEN (NEW.source_id IS DISTINCT FROM OLD.source_id OR NEW.user_id IS DISTINCT FROM OLD.user_id)
    EXECUTE FUNCTION public.grant_identity_is_immutable();
CREATE TRIGGER sc_catalog_managers_identity_immutable BEFORE UPDATE OF source_id, user_id ON public.sc_catalog_managers
    FOR EACH ROW WHEN (NEW.source_id IS DISTINCT FROM OLD.source_id OR NEW.user_id IS DISTINCT FROM OLD.user_id)
    EXECUTE FUNCTION public.grant_identity_is_immutable();

-- A supplier session reads its own membership and packets. Writes belong to
-- staff (the *_staff_* policies) and to the packet functions below.
DROP POLICY supplier_member_self_isolation ON public.sc_source_members;
CREATE POLICY supplier_member_self_read ON public.sc_source_members FOR SELECT TO podhub_app
    USING (user_id = (NULLIF(current_setting('app.current_supplier_user_id'::text, true), ''::text))::bigint);

DROP POLICY delegate_fulfiller_isolation ON public.delegate_dispatches;
CREATE POLICY delegate_fulfiller_read ON public.delegate_dispatches FOR SELECT TO podhub_app
    USING (fulfiller_id IN (
        SELECT f.fulfiller_id FROM public.sc_source_fulfillers f
         WHERE f.user_id = (NULLIF(current_setting('app.current_supplier_user_id'::text, true), ''::text))::bigint));
DROP POLICY delegate_fulfiller_isolation ON public.delegate_settlements;
CREATE POLICY delegate_fulfiller_read ON public.delegate_settlements FOR SELECT TO podhub_app
    USING (EXISTS (
        SELECT 1 FROM public.delegate_dispatches d
         WHERE d.dispatch_id = delegate_settlements.dispatch_id
           AND d.fulfiller_id IN (
               SELECT f.fulfiller_id FROM public.sc_source_fulfillers f
                WHERE f.user_id = (NULLIF(current_setting('app.current_supplier_user_id'::text, true), ''::text))::bigint)));

-- ------------------------------------------------- packet functions (definer)
-- Executable by podhub_app and running as owner, so each now checks that the
-- caller is the user it names. Before, any session could pass another
-- fulfiller's id and ship their packet.
CREATE OR REPLACE FUNCTION public.delegate_supplier_accept(p_dispatch_id uuid, p_supplier_user_id bigint, p_fulfiller_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_source text;
    v_state text;
    v_order uuid;
    v_fulfiller uuid;
    v_order_state text;
BEGIN
    -- The caller must be the user the arguments name. These functions are
    -- SECURITY DEFINER and executable by podhub_app, so without this a session
    -- could act as any fulfiller by passing that user's id. COALESCE is
    -- load-bearing: current_setting(..., true) is NULL when the GUC is unset,
    -- and plpgsql does not run IF on NULL.
    IF NOT COALESCE(
        current_setting('app.staff_access', true) = '1'
        OR p_supplier_user_id = NULLIF(current_setting('app.current_supplier_user_id', true), '')::bigint,
        false
    ) THEN
        RAISE EXCEPTION 'DELEGATE_FORBIDDEN';
    END IF;
    SELECT d.order_id, d.source_id, d.fulfiller_id
    INTO v_order, v_source, v_fulfiller
    FROM public.delegate_dispatches d
    WHERE d.dispatch_id = p_dispatch_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'DELEGATE_NOT_FOUND';
    END IF;
    -- The packet must name this fulfiller, and this fulfiller must still be
    -- the active grant of this user on this source. Both halves matter: the
    -- first alone would let a disabled fulfiller act, the second alone would
    -- let a fulfiller act on another factory's packet.
    IF v_fulfiller IS DISTINCT FROM p_fulfiller_id THEN
        RAISE EXCEPTION 'DELEGATE_FORBIDDEN';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.sc_source_fulfillers f
        WHERE f.fulfiller_id = p_fulfiller_id
          AND f.source_id = v_source
          AND f.user_id = p_supplier_user_id
          AND f.status = 'active'
    ) THEN
        RAISE EXCEPTION 'DELEGATE_FORBIDDEN';
    END IF;

    SELECT o.state INTO v_order_state
    FROM public.delegate_orders o
    WHERE o.order_id = v_order
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'DELEGATE_NOT_FOUND';
    END IF;
    SELECT d.source_id, d.state, d.fulfiller_id
    INTO v_source, v_state, v_fulfiller
    FROM public.delegate_dispatches d
    WHERE d.dispatch_id = p_dispatch_id
    FOR UPDATE;
    -- Lock-then-recheck: a rebind between the first read and this lock must
    -- not let this call proceed on a packet it no longer owns.
    IF v_fulfiller IS DISTINCT FROM p_fulfiller_id THEN
        RAISE EXCEPTION 'DELEGATE_FORBIDDEN';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.sc_source_fulfillers f
        WHERE f.fulfiller_id = p_fulfiller_id
          AND f.source_id = v_source
          AND f.user_id = p_supplier_user_id
          AND f.status = 'active'
    ) THEN
        RAISE EXCEPTION 'DELEGATE_FORBIDDEN';
    END IF;
    IF v_order_state IN ('cancelled', 'done') THEN
        RAISE EXCEPTION 'DELEGATE_TERMINAL';
    END IF;
    IF v_state = 'accepted' THEN
        RETURN 'accepted';
    END IF;
    IF v_state <> 'dispatched' THEN
        RAISE EXCEPTION 'DELEGATE_TERMINAL';
    END IF;

    UPDATE public.delegate_dispatches
    SET state = 'accepted',
        updated_at_ms = (extract(epoch from clock_timestamp()) * 1000)::bigint
    WHERE dispatch_id = p_dispatch_id AND state = 'dispatched';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'DELEGATE_TERMINAL';
    END IF;
    PERFORM public.delegate_supplier_recompute_order_state(
        v_order, (extract(epoch from clock_timestamp()) * 1000)::bigint);
    RETURN 'accepted';
END;
$function$;

CREATE OR REPLACE FUNCTION public.delegate_supplier_reject(p_dispatch_id uuid, p_supplier_user_id bigint, p_reason text, p_fulfiller_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_source text;
    v_state text;
    v_order uuid;
    v_fulfiller uuid;
    v_order_state text;
BEGIN
    -- The caller must be the user the arguments name. These functions are
    -- SECURITY DEFINER and executable by podhub_app, so without this a session
    -- could act as any fulfiller by passing that user's id. COALESCE is
    -- load-bearing: current_setting(..., true) is NULL when the GUC is unset,
    -- and plpgsql does not run IF on NULL.
    IF NOT COALESCE(
        current_setting('app.staff_access', true) = '1'
        OR p_supplier_user_id = NULLIF(current_setting('app.current_supplier_user_id', true), '')::bigint,
        false
    ) THEN
        RAISE EXCEPTION 'DELEGATE_FORBIDDEN';
    END IF;
    SELECT d.order_id, d.source_id, d.fulfiller_id
    INTO v_order, v_source, v_fulfiller
    FROM public.delegate_dispatches d
    WHERE d.dispatch_id = p_dispatch_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'DELEGATE_NOT_FOUND';
    END IF;
    IF v_fulfiller IS DISTINCT FROM p_fulfiller_id THEN
        RAISE EXCEPTION 'DELEGATE_FORBIDDEN';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.sc_source_fulfillers f
        WHERE f.fulfiller_id = p_fulfiller_id
          AND f.source_id = v_source
          AND f.user_id = p_supplier_user_id
          AND f.status = 'active'
    ) THEN
        RAISE EXCEPTION 'DELEGATE_FORBIDDEN';
    END IF;

    SELECT o.state INTO v_order_state
    FROM public.delegate_orders o
    WHERE o.order_id = v_order
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'DELEGATE_NOT_FOUND';
    END IF;
    SELECT d.source_id, d.state, d.fulfiller_id
    INTO v_source, v_state, v_fulfiller
    FROM public.delegate_dispatches d
    WHERE d.dispatch_id = p_dispatch_id
    FOR UPDATE;
    IF v_fulfiller IS DISTINCT FROM p_fulfiller_id THEN
        RAISE EXCEPTION 'DELEGATE_FORBIDDEN';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.sc_source_fulfillers f
        WHERE f.fulfiller_id = p_fulfiller_id
          AND f.source_id = v_source
          AND f.user_id = p_supplier_user_id
          AND f.status = 'active'
    ) THEN
        RAISE EXCEPTION 'DELEGATE_FORBIDDEN';
    END IF;
    IF v_order_state IN ('cancelled', 'done') OR v_state <> 'dispatched' THEN
        RAISE EXCEPTION 'DELEGATE_TERMINAL';
    END IF;

    UPDATE public.delegate_dispatches
    SET state = 'rejected',
        receipt = jsonb_build_object('reason', COALESCE(p_reason, ''), 'at_ms',
            (extract(epoch from clock_timestamp()) * 1000)::bigint),
        updated_at_ms = (extract(epoch from clock_timestamp()) * 1000)::bigint
    WHERE dispatch_id = p_dispatch_id AND state = 'dispatched';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'DELEGATE_TERMINAL';
    END IF;
    -- The latch is per fulfiller now: latch the rows frozen in THIS packet's
    -- payload, to the fulfiller that just rejected. The old writer set
    -- last_rejected_source_id, which is why a rebind inside one source left
    -- the line permanently undispatchable.
    UPDATE public.delegate_order_lines l
    SET last_rejected_fulfiller_id = p_fulfiller_id
    FROM public.delegate_dispatches d
    WHERE d.dispatch_id = p_dispatch_id
      AND l.order_id = d.order_id
      AND d.payload->'lines' @> to_jsonb(jsonb_build_array(
          jsonb_build_object('line_id', l.line_id::text)));
    PERFORM public.delegate_supplier_recompute_order_state(
        v_order, (extract(epoch from clock_timestamp()) * 1000)::bigint);
    RETURN 'rejected';
END;
$function$;

CREATE OR REPLACE FUNCTION public.delegate_supplier_ship(p_dispatch_id uuid, p_supplier_user_id bigint, p_tracking_no text, p_note text, p_now_ms bigint, p_fulfiller_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_source text;
    v_state text;
    v_order uuid;
    v_fulfiller uuid;
    v_order_state text;
BEGIN
    -- The caller must be the user the arguments name. These functions are
    -- SECURITY DEFINER and executable by podhub_app, so without this a session
    -- could act as any fulfiller by passing that user's id. COALESCE is
    -- load-bearing: current_setting(..., true) is NULL when the GUC is unset,
    -- and plpgsql does not run IF on NULL.
    IF NOT COALESCE(
        current_setting('app.staff_access', true) = '1'
        OR p_supplier_user_id = NULLIF(current_setting('app.current_supplier_user_id', true), '')::bigint,
        false
    ) THEN
        RAISE EXCEPTION 'DELEGATE_FORBIDDEN';
    END IF;
    SELECT d.order_id, d.source_id, d.fulfiller_id
    INTO v_order, v_source, v_fulfiller
    FROM public.delegate_dispatches d
    WHERE d.dispatch_id = p_dispatch_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'DELEGATE_NOT_FOUND';
    END IF;
    IF v_fulfiller IS DISTINCT FROM p_fulfiller_id THEN
        RAISE EXCEPTION 'DELEGATE_FORBIDDEN';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.sc_source_fulfillers f
        WHERE f.fulfiller_id = p_fulfiller_id
          AND f.source_id = v_source
          AND f.user_id = p_supplier_user_id
          AND f.status = 'active'
    ) THEN
        RAISE EXCEPTION 'DELEGATE_FORBIDDEN';
    END IF;

    SELECT o.state INTO v_order_state
    FROM public.delegate_orders o
    WHERE o.order_id = v_order
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'DELEGATE_NOT_FOUND';
    END IF;
    SELECT d.source_id, d.state, d.fulfiller_id
    INTO v_source, v_state, v_fulfiller
    FROM public.delegate_dispatches d
    WHERE d.dispatch_id = p_dispatch_id
    FOR UPDATE;
    IF v_fulfiller IS DISTINCT FROM p_fulfiller_id THEN
        RAISE EXCEPTION 'DELEGATE_FORBIDDEN';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.sc_source_fulfillers f
        WHERE f.fulfiller_id = p_fulfiller_id
          AND f.source_id = v_source
          AND f.user_id = p_supplier_user_id
          AND f.status = 'active'
    ) THEN
        RAISE EXCEPTION 'DELEGATE_FORBIDDEN';
    END IF;
    IF v_order_state IN ('cancelled', 'done') OR v_state <> 'accepted' THEN
        RAISE EXCEPTION 'DELEGATE_TERMINAL';
    END IF;

    UPDATE public.delegate_dispatches
    SET state = 'shipped',
        receipt = jsonb_build_object(
            'tracking_no', COALESCE(p_tracking_no, ''),
            'note', COALESCE(p_note, ''),
            'at_ms', p_now_ms),
        updated_at_ms = p_now_ms
    WHERE dispatch_id = p_dispatch_id AND state = 'accepted';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'DELEGATE_TERMINAL';
    END IF;
    PERFORM public.delegate_supplier_recompute_order_state(v_order, p_now_ms);
    RETURN 'shipped';
END;
$function$;

-- Definer functions that resolve names through a bare 'public' path also
-- search pg_temp first, where podhub_app may create objects. Search it last.
DO $$
DECLARE
    fn regprocedure;
BEGIN
    FOR fn IN
        SELECT p.oid::regprocedure FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prosecdef
           AND (p.proname LIKE 'delegate\_%' OR p.proname LIKE 'supplier\_%')
           AND p.proconfig = ARRAY['search_path=public']
    LOOP
        EXECUTE format('ALTER FUNCTION %s SET search_path TO public, pg_temp', fn);
    END LOOP;
END
$$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DO $$
DECLARE
    fn regprocedure;
BEGIN
    FOR fn IN
        SELECT p.oid::regprocedure FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prosecdef
           AND (p.proname LIKE 'delegate\_%' OR p.proname LIKE 'supplier\_%')
           AND p.proconfig = ARRAY['search_path=public, pg_temp']
    LOOP
        EXECUTE format('ALTER FUNCTION %s SET search_path TO public', fn);
    END LOOP;
END
$$;
CREATE OR REPLACE FUNCTION public.delegate_supplier_accept(p_dispatch_id uuid, p_supplier_user_id bigint, p_fulfiller_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_source text;
    v_state text;
    v_order uuid;
    v_fulfiller uuid;
    v_order_state text;
BEGIN
    SELECT d.order_id, d.source_id, d.fulfiller_id
    INTO v_order, v_source, v_fulfiller
    FROM public.delegate_dispatches d
    WHERE d.dispatch_id = p_dispatch_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'DELEGATE_NOT_FOUND';
    END IF;
    -- The packet must name this fulfiller, and this fulfiller must still be
    -- the active grant of this user on this source. Both halves matter: the
    -- first alone would let a disabled fulfiller act, the second alone would
    -- let a fulfiller act on another factory's packet.
    IF v_fulfiller IS DISTINCT FROM p_fulfiller_id THEN
        RAISE EXCEPTION 'DELEGATE_FORBIDDEN';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.sc_source_fulfillers f
        WHERE f.fulfiller_id = p_fulfiller_id
          AND f.source_id = v_source
          AND f.user_id = p_supplier_user_id
          AND f.status = 'active'
    ) THEN
        RAISE EXCEPTION 'DELEGATE_FORBIDDEN';
    END IF;

    SELECT o.state INTO v_order_state
    FROM public.delegate_orders o
    WHERE o.order_id = v_order
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'DELEGATE_NOT_FOUND';
    END IF;
    SELECT d.source_id, d.state, d.fulfiller_id
    INTO v_source, v_state, v_fulfiller
    FROM public.delegate_dispatches d
    WHERE d.dispatch_id = p_dispatch_id
    FOR UPDATE;
    -- Lock-then-recheck: a rebind between the first read and this lock must
    -- not let this call proceed on a packet it no longer owns.
    IF v_fulfiller IS DISTINCT FROM p_fulfiller_id THEN
        RAISE EXCEPTION 'DELEGATE_FORBIDDEN';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.sc_source_fulfillers f
        WHERE f.fulfiller_id = p_fulfiller_id
          AND f.source_id = v_source
          AND f.user_id = p_supplier_user_id
          AND f.status = 'active'
    ) THEN
        RAISE EXCEPTION 'DELEGATE_FORBIDDEN';
    END IF;
    IF v_order_state IN ('cancelled', 'done') THEN
        RAISE EXCEPTION 'DELEGATE_TERMINAL';
    END IF;
    IF v_state = 'accepted' THEN
        RETURN 'accepted';
    END IF;
    IF v_state <> 'dispatched' THEN
        RAISE EXCEPTION 'DELEGATE_TERMINAL';
    END IF;

    UPDATE public.delegate_dispatches
    SET state = 'accepted',
        updated_at_ms = (extract(epoch from clock_timestamp()) * 1000)::bigint
    WHERE dispatch_id = p_dispatch_id AND state = 'dispatched';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'DELEGATE_TERMINAL';
    END IF;
    PERFORM public.delegate_supplier_recompute_order_state(
        v_order, (extract(epoch from clock_timestamp()) * 1000)::bigint);
    RETURN 'accepted';
END;
$function$;

CREATE OR REPLACE FUNCTION public.delegate_supplier_reject(p_dispatch_id uuid, p_supplier_user_id bigint, p_reason text, p_fulfiller_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_source text;
    v_state text;
    v_order uuid;
    v_fulfiller uuid;
    v_order_state text;
BEGIN
    SELECT d.order_id, d.source_id, d.fulfiller_id
    INTO v_order, v_source, v_fulfiller
    FROM public.delegate_dispatches d
    WHERE d.dispatch_id = p_dispatch_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'DELEGATE_NOT_FOUND';
    END IF;
    IF v_fulfiller IS DISTINCT FROM p_fulfiller_id THEN
        RAISE EXCEPTION 'DELEGATE_FORBIDDEN';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.sc_source_fulfillers f
        WHERE f.fulfiller_id = p_fulfiller_id
          AND f.source_id = v_source
          AND f.user_id = p_supplier_user_id
          AND f.status = 'active'
    ) THEN
        RAISE EXCEPTION 'DELEGATE_FORBIDDEN';
    END IF;

    SELECT o.state INTO v_order_state
    FROM public.delegate_orders o
    WHERE o.order_id = v_order
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'DELEGATE_NOT_FOUND';
    END IF;
    SELECT d.source_id, d.state, d.fulfiller_id
    INTO v_source, v_state, v_fulfiller
    FROM public.delegate_dispatches d
    WHERE d.dispatch_id = p_dispatch_id
    FOR UPDATE;
    IF v_fulfiller IS DISTINCT FROM p_fulfiller_id THEN
        RAISE EXCEPTION 'DELEGATE_FORBIDDEN';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.sc_source_fulfillers f
        WHERE f.fulfiller_id = p_fulfiller_id
          AND f.source_id = v_source
          AND f.user_id = p_supplier_user_id
          AND f.status = 'active'
    ) THEN
        RAISE EXCEPTION 'DELEGATE_FORBIDDEN';
    END IF;
    IF v_order_state IN ('cancelled', 'done') OR v_state <> 'dispatched' THEN
        RAISE EXCEPTION 'DELEGATE_TERMINAL';
    END IF;

    UPDATE public.delegate_dispatches
    SET state = 'rejected',
        receipt = jsonb_build_object('reason', COALESCE(p_reason, ''), 'at_ms',
            (extract(epoch from clock_timestamp()) * 1000)::bigint),
        updated_at_ms = (extract(epoch from clock_timestamp()) * 1000)::bigint
    WHERE dispatch_id = p_dispatch_id AND state = 'dispatched';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'DELEGATE_TERMINAL';
    END IF;
    -- The latch is per fulfiller now: latch the rows frozen in THIS packet's
    -- payload, to the fulfiller that just rejected. The old writer set
    -- last_rejected_source_id, which is why a rebind inside one source left
    -- the line permanently undispatchable.
    UPDATE public.delegate_order_lines l
    SET last_rejected_fulfiller_id = p_fulfiller_id
    FROM public.delegate_dispatches d
    WHERE d.dispatch_id = p_dispatch_id
      AND l.order_id = d.order_id
      AND d.payload->'lines' @> to_jsonb(jsonb_build_array(
          jsonb_build_object('line_id', l.line_id::text)));
    PERFORM public.delegate_supplier_recompute_order_state(
        v_order, (extract(epoch from clock_timestamp()) * 1000)::bigint);
    RETURN 'rejected';
END;
$function$;

CREATE OR REPLACE FUNCTION public.delegate_supplier_ship(p_dispatch_id uuid, p_supplier_user_id bigint, p_tracking_no text, p_note text, p_now_ms bigint, p_fulfiller_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_source text;
    v_state text;
    v_order uuid;
    v_fulfiller uuid;
    v_order_state text;
BEGIN
    SELECT d.order_id, d.source_id, d.fulfiller_id
    INTO v_order, v_source, v_fulfiller
    FROM public.delegate_dispatches d
    WHERE d.dispatch_id = p_dispatch_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'DELEGATE_NOT_FOUND';
    END IF;
    IF v_fulfiller IS DISTINCT FROM p_fulfiller_id THEN
        RAISE EXCEPTION 'DELEGATE_FORBIDDEN';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.sc_source_fulfillers f
        WHERE f.fulfiller_id = p_fulfiller_id
          AND f.source_id = v_source
          AND f.user_id = p_supplier_user_id
          AND f.status = 'active'
    ) THEN
        RAISE EXCEPTION 'DELEGATE_FORBIDDEN';
    END IF;

    SELECT o.state INTO v_order_state
    FROM public.delegate_orders o
    WHERE o.order_id = v_order
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'DELEGATE_NOT_FOUND';
    END IF;
    SELECT d.source_id, d.state, d.fulfiller_id
    INTO v_source, v_state, v_fulfiller
    FROM public.delegate_dispatches d
    WHERE d.dispatch_id = p_dispatch_id
    FOR UPDATE;
    IF v_fulfiller IS DISTINCT FROM p_fulfiller_id THEN
        RAISE EXCEPTION 'DELEGATE_FORBIDDEN';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.sc_source_fulfillers f
        WHERE f.fulfiller_id = p_fulfiller_id
          AND f.source_id = v_source
          AND f.user_id = p_supplier_user_id
          AND f.status = 'active'
    ) THEN
        RAISE EXCEPTION 'DELEGATE_FORBIDDEN';
    END IF;
    IF v_order_state IN ('cancelled', 'done') OR v_state <> 'accepted' THEN
        RAISE EXCEPTION 'DELEGATE_TERMINAL';
    END IF;

    UPDATE public.delegate_dispatches
    SET state = 'shipped',
        receipt = jsonb_build_object(
            'tracking_no', COALESCE(p_tracking_no, ''),
            'note', COALESCE(p_note, ''),
            'at_ms', p_now_ms),
        updated_at_ms = p_now_ms
    WHERE dispatch_id = p_dispatch_id AND state = 'accepted';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'DELEGATE_TERMINAL';
    END IF;
    PERFORM public.delegate_supplier_recompute_order_state(v_order, p_now_ms);
    RETURN 'shipped';
END;
$function$;

DROP POLICY delegate_fulfiller_read ON public.delegate_settlements;
CREATE POLICY delegate_fulfiller_isolation ON public.delegate_settlements TO podhub_app
    USING (EXISTS (
        SELECT 1 FROM public.delegate_dispatches d
         WHERE d.dispatch_id = delegate_settlements.dispatch_id
           AND d.fulfiller_id IN (
               SELECT f.fulfiller_id FROM public.sc_source_fulfillers f
                WHERE f.user_id = (NULLIF(current_setting('app.current_supplier_user_id'::text, true), ''::text))::bigint)))
    WITH CHECK (EXISTS (
        SELECT 1 FROM public.delegate_dispatches d
         WHERE d.dispatch_id = delegate_settlements.dispatch_id
           AND d.fulfiller_id IN (
               SELECT f.fulfiller_id FROM public.sc_source_fulfillers f
                WHERE f.user_id = (NULLIF(current_setting('app.current_supplier_user_id'::text, true), ''::text))::bigint
                  AND f.status = 'active')));
DROP POLICY delegate_fulfiller_read ON public.delegate_dispatches;
CREATE POLICY delegate_fulfiller_isolation ON public.delegate_dispatches TO podhub_app
    USING (fulfiller_id IN (
        SELECT f.fulfiller_id FROM public.sc_source_fulfillers f
         WHERE f.user_id = (NULLIF(current_setting('app.current_supplier_user_id'::text, true), ''::text))::bigint))
    WITH CHECK (fulfiller_id IN (
        SELECT f.fulfiller_id FROM public.sc_source_fulfillers f
         WHERE f.user_id = (NULLIF(current_setting('app.current_supplier_user_id'::text, true), ''::text))::bigint
           AND f.status = 'active'));
DROP POLICY supplier_member_self_read ON public.sc_source_members;
CREATE POLICY supplier_member_self_isolation ON public.sc_source_members TO podhub_app
    USING (user_id = (NULLIF(current_setting('app.current_supplier_user_id'::text, true), ''::text))::bigint)
    WITH CHECK (user_id = (NULLIF(current_setting('app.current_supplier_user_id'::text, true), ''::text))::bigint);

DROP TRIGGER sc_catalog_managers_identity_immutable ON public.sc_catalog_managers;
DROP TRIGGER sc_source_fulfillers_identity_immutable ON public.sc_source_fulfillers;
DROP TRIGGER sc_source_members_identity_immutable ON public.sc_source_members;
DROP FUNCTION public.grant_identity_is_immutable();
DROP TRIGGER sc_catalog_managers_account_kind ON public.sc_catalog_managers;
DROP TRIGGER sc_source_fulfillers_account_kind ON public.sc_source_fulfillers;
DROP TRIGGER sc_source_members_account_kind ON public.sc_source_members;
DROP FUNCTION public.grant_requires_account_kind();

GRANT DELETE ON TABLE public.support_grants TO podhub_app, podhub_worker;
DROP TRIGGER support_grants_only_shrink ON public.support_grants;
DROP FUNCTION public.support_grants_only_shrink();
DROP TRIGGER support_grants_check_parties ON public.support_grants;
DROP FUNCTION public.support_grants_check_parties();
ALTER TABLE public.support_grants
    DROP CONSTRAINT ck_support_grants_ttl,
    DROP CONSTRAINT support_grants_created_by_user_id_fkey,
    DROP CONSTRAINT support_grants_staff_user_id_fkey,
    DROP CONSTRAINT support_grants_org_id_fkey;

GRANT DELETE ON TABLE public.organizations TO podhub_app, podhub_worker;
DROP TRIGGER organization_members_identity_immutable ON public.organization_members;
DROP FUNCTION public.organization_members_identity_is_immutable();
ALTER TABLE public.org_invitations
    DROP CONSTRAINT ck_org_invitations_one_terminal_state,
    DROP CONSTRAINT ck_org_invitations_role,
    DROP CONSTRAINT org_invitations_accepted_user_id_fkey,
    DROP CONSTRAINT org_invitations_invited_by_user_id_fkey,
    DROP CONSTRAINT org_invitations_org_id_fkey;
ALTER TABLE public.organization_members
    DROP CONSTRAINT organization_members_user_id_fkey,
    DROP CONSTRAINT organization_members_org_id_fkey;
ALTER TABLE public.organizations DROP CONSTRAINT organizations_owner_user_id_fkey;

ALTER TABLE public.auth_email_tokens DROP CONSTRAINT ck_auth_email_tokens_token_hash;
ALTER TABLE public.account_sessions
    DROP CONSTRAINT ck_account_sessions_token_hash,
    DROP CONSTRAINT account_sessions_user_id_fkey;

GRANT DELETE ON TABLE public.account_users TO podhub_app, podhub_worker;
GRANT INSERT, UPDATE, DELETE ON TABLE public.account_credentials TO podhub_app, podhub_worker;
CREATE OR REPLACE FUNCTION public.sync_account_side_tables() RETURNS trigger
    LANGUAGE plpgsql
    AS $f$
BEGIN
    INSERT INTO public.account_credentials (user_id, password_hash, updated_at)
    VALUES (NEW.id, NEW.password_hash, NEW.updated_at)
    ON CONFLICT (user_id) DO UPDATE SET
        password_hash = EXCLUDED.password_hash,
        updated_at = EXCLUDED.updated_at;

    INSERT INTO public.account_profiles (
        user_id, name, target, supplier_id, active_org_id, updated_at
    )
    VALUES (
        NEW.id, NEW.name, NEW.target, NEW.supplier_id, NEW.active_org_id, NEW.updated_at
    )
    ON CONFLICT (user_id) DO UPDATE SET
        name = EXCLUDED.name,
        target = EXCLUDED.target,
        supplier_id = EXCLUDED.supplier_id,
        active_org_id = EXCLUDED.active_org_id,
        updated_at = EXCLUDED.updated_at;

    RETURN NEW;
END;
$f$;
DROP TRIGGER account_users_kind_immutable ON public.account_users;
DROP FUNCTION public.account_users_kind_is_immutable();
DROP TRIGGER account_users_attribution_no_rewrite ON public.account_users;
CREATE OR REPLACE FUNCTION public.account_users_attribution_is_write_once() RETURNS trigger
    LANGUAGE plpgsql
    AS $f$
BEGIN
    IF OLD.invited_by_agent_user_id IS NOT NULL
       AND NEW.invited_by_agent_user_id IS DISTINCT FROM OLD.invited_by_agent_user_id THEN
        RAISE EXCEPTION 'account_users.invited_by_agent_user_id is write-once';
    END IF;
    RETURN NEW;
END;
$f$;
CREATE TRIGGER account_users_attribution_no_rewrite BEFORE UPDATE OF invited_by_agent_user_id
    ON public.account_users FOR EACH ROW EXECUTE FUNCTION public.account_users_attribution_is_write_once();
ALTER TABLE public.account_credentials DROP CONSTRAINT ck_account_credentials_password_hash;
ALTER TABLE public.account_users
    DROP CONSTRAINT account_users_uuid_key,
    DROP CONSTRAINT account_users_public_id_key,
    DROP CONSTRAINT ck_account_users_password_hash,
    DROP CONSTRAINT ck_account_users_email_shape,
    DROP CONSTRAINT ck_account_users_role;
-- +goose StatementEnd
