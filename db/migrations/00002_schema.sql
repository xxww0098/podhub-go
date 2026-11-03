-- +goose Up
-- Complete schema at the goose head. This file replaces the 368 incremental
-- migrations that built it; see docs/architecture.md for why the history was
-- squashed. It is a pg_dump --schema-only of a database migrated to head with
-- River's own tables excluded, plus the role-owned functions re-homed and the
-- default privileges decoupled from the dumping role.
--
-- Do not hand-edit: internal/platform/db/migrate_guard_test.go pins the bytes
-- in db/migrations.sha256. A schema change is a new migration above this one.
-- +goose StatementBegin
--
-- PostgreSQL database dump
--


-- Dumped from database version 16.15
-- Dumped by pg_dump version 16.15

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;

--
-- Name: btree_gist; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;


--
-- Name: EXTENSION btree_gist; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION btree_gist IS 'support for indexing common datatypes in GiST';


--
-- Name: pg_stat_statements; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA public;


--
-- Name: EXTENSION pg_stat_statements; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_stat_statements IS 'track planning and execution statistics of all SQL statements executed';


--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: account_users_attribution_is_write_once(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.account_users_attribution_is_write_once() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF OLD.invited_by_agent_user_id IS NOT NULL
       AND NEW.invited_by_agent_user_id IS DISTINCT FROM OLD.invited_by_agent_user_id THEN
        RAISE EXCEPTION 'account_users.invited_by_agent_user_id is write-once';
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: agent_commission_ledger_is_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_commission_ledger_is_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'agent_commission_ledger rows are immutable';
END;
$$;


--
-- Name: automation_grant_authority_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.automation_grant_authority_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF ROW(NEW.user_id,NEW.org_id,NEW.scope_kind,NEW.source_ids,NEW.actions,NEW.token_hash)
       IS DISTINCT FROM ROW(OLD.user_id,OLD.org_id,OLD.scope_kind,OLD.source_ids,OLD.actions,OLD.token_hash) THEN
        RAISE EXCEPTION 'automation grant authority is immutable';
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: billing_consume_redeem_code(bigint, bigint, bigint, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.billing_consume_redeem_code(p_id bigint, p_user bigint, p_org bigint, p_used_at_ms bigint) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
    n integer;
BEGIN
    IF NULLIF(current_setting('app.current_org_id', true), '')::bigint IS DISTINCT FROM p_org THEN
        RAISE EXCEPTION 'billing redeem org mismatch' USING ERRCODE = '42501';
    END IF;
    UPDATE public.redeem_codes
       SET used = true,
           used_by_user_id = p_user,
           used_by_org_id = p_org,
           used_at_ms = p_used_at_ms,
           updated_at = clock_timestamp()
     WHERE id = p_id AND used = false;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END;
$$;


--
-- Name: billing_due_drains(bigint, timestamp with time zone, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.billing_due_drains(deadline_seconds bigint, at_time timestamp with time zone, batch_size integer) RETURNS TABLE(org_id bigint, drain_id bigint, deadline_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
 SELECT e.org_id,e.id,e.effective_at+deadline_seconds*interval '1 second'
 FROM public.subscription_events e WHERE e.kind='drain'
 AND NOT EXISTS(SELECT 1 FROM public.subscription_events d WHERE d.org_id=e.org_id AND d.kind='drain_done' AND (d.breakdown->>'drain_event_id')::bigint=e.id)
 AND e.effective_at+deadline_seconds*interval '1 second'<=at_time
 ORDER BY e.id LIMIT greatest(0,least(batch_size,1000))
$$;


--
-- Name: billing_due_subscriptions(timestamp with time zone, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.billing_due_subscriptions(at_time timestamp with time zone, batch_size integer) RETURNS TABLE(org_id bigint)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
 SELECT s.org_id FROM public.subscriptions s WHERE s.status='active' AND
 (s.term_end<=at_time OR EXISTS (SELECT 1 FROM public.subscription_periods p
   WHERE p.org_id=s.org_id AND p.starts_at<=at_time AND at_time<p.ends_at
   AND (p.plan_key,p.stores,p.starts_at) IS DISTINCT FROM (s.plan_key,s.stores,s.term_start)))
 ORDER BY s.updated_at LIMIT greatest(0,least(batch_size,1000))
$$;


--
-- Name: billing_lock_payment_order(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.billing_lock_payment_order(p_public_id text) RETURNS bigint
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
    SELECT org_id FROM public.payment_orders WHERE public_id = p_public_id FOR UPDATE
$$;


--
-- Name: billing_lock_redeem_code(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.billing_lock_redeem_code(p_code text) RETURNS TABLE(id bigint, wallet_cents bigint, used boolean, expires_at timestamp with time zone, revoked_at timestamp with time zone)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
    SELECT id,
           wallet_cents,
           used,
           expires_at,
           revoked_at
      FROM public.redeem_codes
     WHERE upper(code) = upper(p_code)
     LIMIT 1
     FOR UPDATE
$$;


--
-- Name: billing_owner_paid_orders(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.billing_owner_paid_orders(p_user_id bigint) RETURNS bigint
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
    SELECT count(*)::bigint
      FROM public.payment_orders o
      JOIN public.organizations g ON g.id = o.org_id
     WHERE g.owner_user_id = p_user_id
       AND o.status = 'paid'
$$;


--
-- Name: billing_payment_order_brief(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.billing_payment_order_brief(p_id bigint) RETURNS TABLE(public_id text, product text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
    SELECT o.public_id, o.product::text
      FROM public.payment_orders o
     WHERE o.id = p_id
$$;


--
-- Name: billing_payment_order_org(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.billing_payment_order_org(p_public_id text) RETURNS bigint
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
    SELECT org_id FROM public.payment_orders WHERE public_id = p_public_id
$$;


--
-- Name: billing_reap_subscription_orders(timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.billing_reap_subscription_orders(at_time timestamp with time zone) RETURNS bigint
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
 WITH closed AS (
 UPDATE public.payment_orders SET status='canceled',canceled_at=at_time,updated_at=at_time
 WHERE status='pending' AND product='subscription' AND provider='manual' AND payment_deadline_at<=at_time
 RETURNING 1)
 SELECT count(*) FROM closed
$$;


--
-- Name: billing_replay_candidates(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.billing_replay_candidates(p_seconds bigint) RETURNS TABLE(id bigint, public_id character varying, org_id bigint, product text, status character varying, topup_microfen bigint, ledger_status character varying)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
    SELECT o.id,
           o.public_id,
           o.org_id,
           o.product::text,
           o.status,
           COALESCE(o.topup_microfen, 0),
           l.status
      FROM public.payment_orders o
      JOIN public.payment_callback_ledger l ON l.payment_reference = o.public_id
     WHERE o.status = 'pending'
       AND o.created_at < clock_timestamp() - (p_seconds || ' seconds')::interval
     ORDER BY o.id
$$;


--
-- Name: bump_listing_view_revision(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bump_listing_view_revision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.view_revision := OLD.view_revision + 1;
  RETURN NEW;
END $$;


--
-- Name: check_ai_image_owner(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_ai_image_owner() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE target uuid; BEGIN
 IF TG_TABLE_NAME='ai_image_sets' THEN target := NEW.source_object_id; ELSE target := NEW.object_id; END IF;
 IF target IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.storage_objects WHERE id=target AND owner_org_id=NEW.org_id AND dedupe_scope='org:'||NEW.org_id::text||':image' AND state='live') THEN
  RAISE EXCEPTION 'image object belongs to another workspace or is not live' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;


--
-- Name: delegate_credit_fulfiller_wallet(uuid, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delegate_credit_fulfiller_wallet(p_dispatch_id uuid, p_now_ms bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_source text;
    v_amount bigint;
    v_pinned uuid;
    v_balance bigint;
    v_held bigint;
    v_exists boolean;
    v_next_balance bigint;
BEGIN
    SELECT s.source_id, s.amount_microfen, d.fulfiller_id
      INTO v_source, v_amount, v_pinned
      FROM public.delegate_settlements s
      JOIN public.delegate_dispatches d ON d.dispatch_id = s.dispatch_id
     WHERE s.dispatch_id = p_dispatch_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION '结算没有写入';
    END IF;

    -- Caller must be the packet's pinned fulfiller, or staff. The Go caller
    -- is already behind delegate_supplier_ship's gate; repeating it keeps
    -- this function from being callable on its own for someone else's packet.
    --
    -- COALESCE is load-bearing, not tidiness. current_setting(..., true)
    -- returns NULL when the GUC is unset, so staff_access = '1' is NULL,
    -- NULL OR false is NULL, and plpgsql's IF does not run on NULL. Without
    -- the COALESCE the guard would silently pass for exactly the caller it
    -- exists to stop: a supplier session that never sets staff_access.
    IF NOT (
        COALESCE(current_setting('app.staff_access', true) = '1', false)
        OR EXISTS (
            SELECT 1 FROM public.sc_source_fulfillers f
             WHERE f.fulfiller_id = v_pinned
               AND f.user_id = NULLIF(current_setting('app.current_supplier_user_id', true), '')::bigint
        )
    ) THEN
        RAISE EXCEPTION 'DELEGATE_FORBIDDEN';
    END IF;

    INSERT INTO public.supplier_wallets (source_id, balance_microfen, held_microfen, updated_at_ms)
    VALUES (v_source, 0, 0, p_now_ms)
    ON CONFLICT (source_id) DO NOTHING;

    SELECT balance_microfen, held_microfen INTO v_balance, v_held
      FROM public.supplier_wallets WHERE source_id = v_source FOR UPDATE;

    SELECT EXISTS (
        SELECT 1 FROM public.supplier_wallet_ledger
         WHERE source_id = v_source AND entry_type = 'credit'
           AND idempotency_key = 'delegate:' || p_dispatch_id::text
    ) INTO v_exists;
    IF v_exists THEN
        RETURN;
    END IF;

    v_next_balance := v_balance + v_amount;
    IF v_next_balance < 0 OR v_held < 0 OR v_held > v_next_balance THEN
        RAISE EXCEPTION '结算金额超出范围';
    END IF;

    UPDATE public.supplier_wallets
       SET balance_microfen = v_next_balance, updated_at_ms = p_now_ms
     WHERE source_id = v_source;

    INSERT INTO public.supplier_wallet_ledger
        (source_id, entry_type, idempotency_key, amount_microfen, held_delta_microfen,
         balance_after_microfen, held_after_microfen, created_at_ms)
    VALUES (v_source, 'credit', 'delegate:' || p_dispatch_id::text, v_amount, 0,
            v_next_balance, v_held, p_now_ms);
END;
$$;


--
-- Name: delegate_source_active_fulfiller_count(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delegate_source_active_fulfiller_count(p_source_id text) RETURNS bigint
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    SELECT count(*)::bigint FROM public.sc_source_fulfillers
    WHERE source_id = p_source_id AND status = 'active';
$$;


--
-- Name: delegate_source_active_fulfiller_id(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delegate_source_active_fulfiller_id(p_source_id text) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    SELECT f.fulfiller_id FROM public.sc_source_fulfillers f
    WHERE f.source_id = p_source_id AND f.status = 'active'
    ORDER BY f.created_at_ms, f.fulfiller_id
    LIMIT 1;
$$;


--
-- Name: delegate_source_active_member_count(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delegate_source_active_member_count(p_source_id text) RETURNS bigint
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    SELECT count(*)::bigint FROM public.sc_source_members
    WHERE source_id = p_source_id AND status = 'active';
$$;


--
-- Name: delegate_supplier_accept(uuid, bigint, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delegate_supplier_accept(p_dispatch_id uuid, p_supplier_user_id bigint, p_fulfiller_id uuid) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
$$;


--
-- Name: delegate_supplier_recompute_order_state(uuid, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delegate_supplier_recompute_order_state(p_order_id uuid, p_now_ms bigint) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_line record;
    v_count integer := 0;
    v_all_shipped boolean := true;
    v_any_accepted boolean := false;
    v_any_live boolean := false;
    v_all_ready boolean := true;
    v_state text;
BEGIN
    FOR v_line IN
        SELECT (b.active IS TRUE AND EXISTS (
                    SELECT 1 FROM public.delegate_assets a
                    WHERE a.binding_id = b.binding_id
                      AND a.verified_at_ms IS NOT NULL)) AS ready,
               (SELECT d.state FROM public.delegate_dispatches d
                WHERE d.order_id = l.order_id
                  AND d.payload->'lines' @> to_jsonb(jsonb_build_array(
                      jsonb_build_object('line_id', l.line_id::text)))
                ORDER BY d.created_at_ms DESC, d.dispatch_id DESC
                LIMIT 1) AS packet_state
        FROM public.delegate_order_lines l
        LEFT JOIN public.delegate_bindings b ON b.binding_id = l.binding_id
        WHERE l.order_id = p_order_id
    LOOP
        v_count := v_count + 1;
        IF v_line.packet_state = 'shipped' THEN
            v_any_live := true;
            v_any_accepted := true;
        ELSIF v_line.packet_state = 'accepted' THEN
            v_any_live := true;
            v_any_accepted := true;
            v_all_shipped := false;
        ELSIF v_line.packet_state = 'dispatched' THEN
            v_any_live := true;
            v_all_shipped := false;
        ELSE
            -- rejected / cancelled / 无包：行回可派发池（latch 另行拦自动重派）。
            v_all_shipped := false;
        END IF;
        IF NOT v_line.ready THEN
            v_all_ready := false;
        END IF;
    END LOOP;
    IF v_count = 0 THEN
        v_state := 'awaiting_setup';
    ELSIF v_all_shipped THEN
        v_state := 'shipped';
    ELSIF v_any_accepted THEN
        v_state := 'in_production';
    ELSIF v_any_live THEN
        v_state := 'dispatched';
    ELSIF v_all_ready THEN
        v_state := 'ready';
    ELSE
        v_state := 'awaiting_setup';
    END IF;
    UPDATE public.delegate_orders
    SET state = v_state, updated_at_ms = p_now_ms
    WHERE order_id = p_order_id AND state NOT IN ('done', 'cancelled');
    RETURN v_state;
END;
$$;


--
-- Name: delegate_supplier_reject(uuid, bigint, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delegate_supplier_reject(p_dispatch_id uuid, p_supplier_user_id bigint, p_reason text, p_fulfiller_id uuid) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
$$;


--
-- Name: delegate_supplier_ship(uuid, bigint, text, text, bigint, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delegate_supplier_ship(p_dispatch_id uuid, p_supplier_user_id bigint, p_tracking_no text, p_note text, p_now_ms bigint, p_fulfiller_id uuid) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
$$;


--
-- Name: execution_member_active(bigint, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.execution_member_active(p_org_id bigint, p_user_id bigint) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.organization_members
         WHERE org_id = p_org_id
           AND user_id = p_user_id
           AND status = 'active'
    )
$$;


--
-- Name: execution_quota_user_limit(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.execution_quota_user_limit(p_class text) RETURNS bigint
    LANGUAGE sql IMMUTABLE
    AS $$ SELECT CASE p_class
 WHEN 'ai_ocr' THEN 8::bigint WHEN 'cloud_upload' THEN 2::bigint
 WHEN 'all_execution' THEN 8::bigint WHEN 'verify' THEN 2::bigint ELSE 0::bigint END $$;


--
-- Name: guard_media_lease_reference_identity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_media_lease_reference_identity() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
    identity text;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        identity := public.media_gc_image_identity(OLD.object_key);
        IF identity IS NOT NULL THEN
            PERFORM public.lock_media_reference_identity(split_part(identity,':',1)::uuid,split_part(identity,':',2));
        END IF;
    END IF;
    IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.object_key IS DISTINCT FROM OLD.object_key) THEN
        identity := public.media_gc_image_identity(NEW.object_key);
        IF identity IS NOT NULL THEN
            PERFORM public.lock_media_reference_identity(split_part(identity,':',1)::uuid,split_part(identity,':',2));
        END IF;
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;

    identity := public.media_gc_image_identity(NEW.object_key);
    IF identity IS NOT NULL AND NEW.retired_at IS NULL AND NEW.deleted_at IS NULL
       AND (TG_OP='INSERT' OR OLD.retired_at IS NULL) THEN
        -- The shared fence is held before this distinct SPI statement. This
        -- VOLATILE lookup uses a fresh READ COMMITTED snapshot, including a GC
        -- retirement committed after the outer INSERT's statement began.
        -- Old registry hashes/batches/accounts are not physical generations:
        -- even a different PK cannot grant the same exact retired object key.
        IF EXISTS (
            SELECT 1 FROM public.media_object_leases prior
            WHERE public.media_gc_image_identity(prior.object_key)=identity
              AND prior.object_key=NEW.object_key AND prior.retired_at IS NOT NULL
        ) THEN
            RAISE EXCEPTION 'media object is retired; upload under a new key' USING ERRCODE = 'P0M01';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: guard_media_lease_retirement(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_media_lease_retirement() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
    IF TG_OP = 'TRUNCATE' THEN
        RAISE EXCEPTION 'media retirement registry cannot be truncated' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'DELETE' THEN
        IF OLD.retired_at IS NOT NULL THEN
            RAISE EXCEPTION 'retired media identity cannot be removed' USING ERRCODE = '23514';
        END IF;
        RETURN OLD;
    END IF;

    IF TG_OP = 'UPDATE' AND OLD.retired_at IS NOT NULL
       AND NEW.retired_at IS DISTINCT FROM OLD.retired_at THEN
        RAISE EXCEPTION 'media retirement is irreversible' USING ERRCODE = '23514';
    END IF;
    -- Existing explicit image-delete receipts do not know the new column.
    -- Videos have no batch generation, so their explicit receipt remains reusable.
    IF NEW.deleted_at IS NOT NULL AND NEW.retired_at IS NULL
       AND public.is_media_gc_image_key(NEW.object_key) THEN
        NEW.retired_at := NEW.deleted_at;
    END IF;

    IF TG_OP = 'UPDATE' AND (OLD.retired_at IS NOT NULL OR NEW.retired_at IS NOT NULL) THEN
        IF ROW(NEW.workspace_uuid, NEW.batch_id, NEW.content_hash, NEW.org_id,
               NEW.object_key, NEW.media_account_id, NEW.storage_revision,
               NEW.first_seen_at, NEW.last_hit_at, NEW.created_at,
               NEW.verification_status, NEW.verified_at, NEW.verified_byte_length,
               NEW.verified_width, NEW.verified_height)
           IS DISTINCT FROM
           ROW(OLD.workspace_uuid, OLD.batch_id, OLD.content_hash, OLD.org_id,
               OLD.object_key, OLD.media_account_id, OLD.storage_revision,
               OLD.first_seen_at, OLD.last_hit_at, OLD.created_at,
               OLD.verification_status, OLD.verified_at, OLD.verified_byte_length,
               OLD.verified_width, OLD.verified_height)
           OR NEW.expires_at > OLD.expires_at
           OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at)
           OR (NEW.public_ready_at IS NOT NULL AND NEW.public_ready_at IS DISTINCT FROM OLD.public_ready_at)
           OR (NEW.public_url IS NOT NULL AND NEW.public_url IS DISTINCT FROM OLD.public_url) THEN
            RAISE EXCEPTION 'retired media identity cannot be reused or renewed' USING ERRCODE = '23514';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;


--
-- Name: guard_media_reference_write(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_media_reference_write() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
    reference_text text;
    exact_key text;
    reference_url text;
    images jsonb;
    match_kind text;
    scope_org bigint;
    scope_workspace uuid;
    now_at timestamptz := clock_timestamp();
    identities record;
    workspaces uuid[];
    digests text[];
    live_workspaces uuid[];
    live_batches text[];
    live_digests text[];
    has_retired boolean;
BEGIN
    CASE TG_TABLE_NAME
    WHEN 'listing_rows' THEN
        IF NOT (NEW.submission_state IN ('queued','submitting','unknown')
            OR (NEW.media_state='ready' AND NEW.submission_state NOT IN ('accepted','cancelled')
                AND NEW.updated_at >= now_at - interval '7 days')
            OR (NEW.submission_state='accepted' AND NEW.updated_at >= now_at - interval '7 days')) THEN
            RETURN NEW;
        END IF;
        images := CASE WHEN jsonb_typeof(NEW.payload->'media'->'images')='array'
                       THEN NEW.payload->'media'->'images' ELSE '[]'::jsonb END;
        reference_text := images::text;
        scope_org := NEW.org_id;
        match_kind := 'listing';
    WHEN 'store_products' THEN
        IF NEW.gone_at_ms IS NOT NULL OR COALESCE(NEW.primary_image,'')='' THEN RETURN NEW; END IF;
        reference_text := NEW.primary_image;
        reference_url := NEW.primary_image;
        scope_org := NEW.org_id;
        match_kind := 'url';
    WHEN 'supplier_media_objects' THEN
        -- Supplier objects intentionally retain matching keys across every
        -- Workspace. Adding an org predicate here would narrow GC protection.
        exact_key := COALESCE(NEW.object_key,'');
        reference_url := COALESCE(NEW.public_url,'');
        reference_text := exact_key || E'\n' || reference_url;
        match_kind := 'supplier';
    WHEN 'media_blobs' THEN
        IF NEW.state='deleted' THEN RETURN NEW; END IF;
        exact_key := NEW.storage_key;
        reference_text := exact_key;
        scope_org := NEW.org_id;
        match_kind := 'key';
    WHEN 'media_uploads' THEN
        IF NEW.state<>'pending' OR NEW.expires_at<=now_at THEN RETURN NEW; END IF;
        exact_key := NEW.storage_key;
        reference_text := exact_key;
        scope_org := NEW.org_id;
        match_kind := 'key';
    WHEN 'jobs' THEN
        IF NEW.state NOT IN ('queued','running','retry_wait','uncertain') THEN RETURN NEW; END IF;
        reference_text := NEW.payload::text;
        scope_org := NEW.org_id;
        match_kind := 'job';
    ELSE
        RAISE EXCEPTION 'unexpected media reference table';
    END CASE;

    -- Every candidate contains this delimiter. Ordinary external URLs and
    -- unrelated Job payloads therefore avoid even an organization lookup;
    -- this fast rejection cannot narrow the embedded-key match set below.
    IF reference_text IS NULL OR position('/sha256/' in lower(reference_text))=0 THEN
        RETURN NEW;
    END IF;
    -- The extractor does not query the registry; only matching physical
    -- identities go on to indexed lease lookups and row locks.
    IF scope_org IS NOT NULL THEN
        SELECT o.uuid INTO scope_workspace FROM public.organizations o WHERE o.id=scope_org;
        IF scope_workspace IS NULL THEN RETURN NEW; END IF;
    END IF;
    FOR identities IN
        SELECT c.workspace_uuid, c.content_hash
        FROM public.media_reference_candidates(reference_text) c
        ORDER BY c.workspace_uuid, c.content_hash
    LOOP
        PERFORM public.lock_media_reference_identity(identities.workspace_uuid, identities.content_hash);
        workspaces := array_append(workspaces, identities.workspace_uuid);
        digests := array_append(digests, identities.content_hash);
    END LOOP;
    IF workspaces IS NULL THEN RETURN NEW; END IF;

    -- Drain the ordered locking subquery before issuing a single batch UPDATE.
    -- NOWAIT also handles multi-row business transactions that visit different
    -- objects in opposite orders: retry, never wait while holding the other row.
    SELECT array_agg(l.workspace_uuid), array_agg(l.batch_id), array_agg(l.content_hash)
      INTO live_workspaces, live_batches, live_digests
      FROM (
        SELECT lease.workspace_uuid, lease.batch_id, lease.content_hash
        FROM public.media_object_leases lease
        JOIN unnest(workspaces,digests) AS wanted(workspace_uuid,content_hash)
          ON public.media_gc_image_identity(lease.object_key)=wanted.workspace_uuid::text||':'||wanted.content_hash
        WHERE lease.retired_at IS NULL AND lease.deleted_at IS NULL
          AND (scope_workspace IS NULL OR lease.workspace_uuid=scope_workspace)
          AND CASE match_kind
            WHEN 'listing' THEN EXISTS (SELECT 1 FROM jsonb_array_elements(images) img WHERE
                lower(COALESCE(img->>'object_key',''))=lower(lease.object_key)
                OR (COALESCE(img->>'public_url','')<>'' AND
                    (position(lower(lease.object_key) in lower(img->>'public_url'))>0
                     OR (COALESCE(lease.public_url,'')<>'' AND
                         split_part(split_part(img->>'public_url','?',1),'#',1)
                         =split_part(split_part(lease.public_url,'?',1),'#',1)))))
            WHEN 'url' THEN position(lower(lease.object_key) in lower(reference_url))>0
                OR (COALESCE(lease.public_url,'')<>'' AND
                    split_part(split_part(reference_url,'?',1),'#',1)
                    =split_part(split_part(lease.public_url,'?',1),'#',1))
            WHEN 'supplier' THEN exact_key=lease.object_key
                OR position(lower(lease.object_key) in lower(reference_url))>0
                OR (COALESCE(lease.public_url,'')<>'' AND reference_url<>'' AND
                    split_part(split_part(reference_url,'?',1),'#',1)
                    =split_part(split_part(lease.public_url,'?',1),'#',1))
            WHEN 'key' THEN exact_key=lease.object_key
            WHEN 'job' THEN position(lease.object_key in reference_text)>0
                OR (COALESCE(lease.public_url,'')<>'' AND position(lease.public_url in reference_text)>0)
            ELSE false END
        ORDER BY lease.workspace_uuid, lease.batch_id, lease.content_hash
        FOR NO KEY UPDATE OF lease NOWAIT
      ) l;

    UPDATE public.media_object_leases lease
       SET expires_at=GREATEST(lease.expires_at,now_at+interval '4 hours'), updated_at=clock_timestamp()
      FROM unnest(live_workspaces,live_batches,live_digests) AS live(workspace_uuid,batch_id,content_hash)
     WHERE lease.workspace_uuid=live.workspace_uuid AND lease.batch_id=live.batch_id
       AND lease.content_hash=live.content_hash AND lease.retired_at IS NULL AND lease.deleted_at IS NULL;

    IF TG_TABLE_NAME IN ('store_products','jobs') THEN
        -- Observations are persisted even when an image is retired. Their use
        -- boundaries/read models decide availability from stronger evidence.
        RETURN NEW;
    END IF;

    -- Retirement cannot be reversed, so observations of retired objects need
    -- no row lock and must not delay GC's completion receipt. This is a second
    -- statement after locking the live set: a concurrent explicit retirement
    -- committed while that set was selected is still observed here. Pinning is
    -- intentionally conservative; invalidation needs a positive identity:
    -- an explicit exact key or the saved full public URL (query/fragment aside).
    -- An external host/path or wrapper URL merely containing the key is unknown.
    SELECT EXISTS (
        SELECT 1 FROM public.media_object_leases lease
        JOIN unnest(workspaces,digests) AS wanted(workspace_uuid,content_hash)
          ON public.media_gc_image_identity(lease.object_key)=wanted.workspace_uuid::text||':'||wanted.content_hash
        WHERE (lease.retired_at IS NOT NULL OR lease.deleted_at IS NOT NULL)
          AND (scope_workspace IS NULL OR lease.workspace_uuid=scope_workspace)
          AND CASE match_kind
            WHEN 'listing' THEN EXISTS (SELECT 1 FROM jsonb_array_elements(images) img WHERE
                img->>'object_key'=lease.object_key
                OR (COALESCE(lease.public_url,'')<>'' AND COALESCE(img->>'public_url','')<>'' AND
                    split_part(split_part(img->>'public_url','?',1),'#',1)
                    =split_part(split_part(lease.public_url,'?',1),'#',1)))
            WHEN 'supplier' THEN exact_key=lease.object_key
                OR (COALESCE(lease.public_url,'')<>'' AND reference_url<>'' AND
                    split_part(split_part(reference_url,'?',1),'#',1)
                    =split_part(split_part(lease.public_url,'?',1),'#',1))
            WHEN 'key' THEN exact_key=lease.object_key
            ELSE false END
    ) INTO has_retired;

    IF has_retired THEN
        IF TG_TABLE_NAME IN ('supplier_media_objects','media_blobs','media_uploads') THEN
            RAISE EXCEPTION 'media object is retired; upload under a new key' USING ERRCODE = 'P0M01';
        ELSIF TG_TABLE_NAME='listing_rows' THEN
          IF NEW.media_state='ready' THEN
            -- Preserve remote receipts, paid content and media evidence. This
            -- is only the usability projection; the existing row-version and
            -- stream triggers publish it with the same atomic business write.
            NEW.media_state := 'failed';
            NEW.payload := jsonb_set(NEW.payload, '{failureLog}',
                (CASE WHEN jsonb_typeof(NEW.payload->'failureLog')='array'
                      THEN NEW.payload->'failureLog' ELSE '[]'::jsonb END)
                || jsonb_build_array(jsonb_build_object(
                    'stage','media','code','MEDIA_OBJECT_MISSING',
                    'message','图片已进入不可逆回收；请用「一键准备」重新上传图片后再发送（不会重新识图）',
                    'occurred_at_ms',floor(extract(epoch from clock_timestamp())*1000))), true);
          END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: guard_submission_offer(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_submission_offer() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.state NOT IN ('queued', 'submitting') THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' AND NEW.state = OLD.state
       AND NEW.offer_id IS NOT DISTINCT FROM OLD.offer_id THEN RETURN NEW; END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('listing-store:' || NEW.store_id::text, 0));
    -- Let the existing idempotency constraint return its original Intent.
    IF TG_OP = 'INSERT' AND EXISTS (
        SELECT 1 FROM public.submission_intents i
         WHERE i.org_id = NEW.org_id AND i.store_id = NEW.store_id
           AND i.client_operation_id = NEW.client_operation_id
    ) THEN RETURN NEW; END IF;

    -- An unproven (`unknown`) effect fences its offer like an in-flight or
    -- accepted one; only the operator release retires it.
    IF NULLIF(btrim(NEW.offer_id), '') IS NULL OR EXISTS (
        SELECT 1 FROM public.submission_intents i
         WHERE i.org_id = NEW.org_id AND i.store_id = NEW.store_id AND i.id <> NEW.id
           AND i.state IN ('queued', 'submitting', 'unknown', 'accepted')
           AND (i.offer_id = NEW.offer_id OR i.offer_id IS NULL)
    ) THEN
        RAISE EXCEPTION 'submission_intents_offer_busy: unresolved Store/offer effect'
            USING ERRCODE = '23505', CONSTRAINT = 'submission_intents_offer_busy';
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: is_media_gc_image_key(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_media_gc_image_key(object_key text) RETURNS boolean
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    SET search_path TO 'pg_catalog'
    AS $_$
    SELECT object_key ~* '(^|/)(teams|workspaces)/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/sha256/[0-9a-f]{64}\.(jpg|png)$'
       AND object_key !~ '(^|/)\.\.?(/|$)'
       AND object_key !~* '(^|/)videos/(teams|workspaces)/[^/]+/sha256/[^/]+$'
       -- Reserved media-core healthcheck PNG digest; it is never an image lease.
       AND object_key !~* '/sha256/aa7bb0431aaeb198a77c26a14fe6dd714a75e4d7db94e3e1238a1fdcbfe1f8d4\.(jpg|png)$';
$_$;


--
-- Name: lock_media_reference_identity(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.lock_media_reference_identity(p_workspace uuid, p_digest text) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN
    -- The post-fence lookups require a fresh statement snapshot. Repeatable
    -- snapshots could miss retirement committed before this shared lock was
    -- acquired and then admit another primary key for the same physical key.
    -- Reject only managed-image writes; read-only observations are unaffected.
    IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'media reference writes require read committed isolation' USING ERRCODE = '25001';
    END IF;
    -- Shared locks allow reference writers and registry insertion to coexist.
    -- They are NOT unique admission and do not replace lease row locks. Even
    -- absent registry identities are covered until the business writer commits.
    -- GC takes the exclusive form, then a separate READ COMMITTED statement
    -- rechecks references before retirement; no lock spans the origin request.
    IF NOT pg_try_advisory_xact_lock_shared(hashtextextended(
        'podhub:media-reference:v1:' || p_workspace::text || ':' || lower(p_digest), 0)) THEN
        RAISE EXCEPTION 'media reference is busy; retry the transaction' USING ERRCODE = '55P03';
    END IF;
END;
$$;


--
-- Name: lock_storage_key_shared(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.lock_storage_key_shared(p_bucket_identity text, p_object_key text) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN
    IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'storage reference writes require read committed isolation' USING ERRCODE = '25001';
    END IF;
    IF NOT pg_try_advisory_xact_lock_shared(public.storage_key_fence(p_bucket_identity, p_object_key)) THEN
        RAISE EXCEPTION 'storage object is busy; retry the transaction' USING ERRCODE = '55P03';
    END IF;
END;
$$;


--
-- Name: media_gc_image_identity(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.media_gc_image_identity(object_key text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
    SELECT CASE WHEN public.is_media_gc_image_key(object_key)
        THEN lower((regexp_match(object_key,
            '(?:teams|workspaces)/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12})/sha256/([0-9a-f]{64})\.(?:jpg|png)$',
            'i'))[1])::uuid::text || ':' || lower((regexp_match(object_key,
            '(?:teams|workspaces)/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12})/sha256/([0-9a-f]{64})\.(?:jpg|png)$',
            'i'))[2])
        END;
$_$;


--
-- Name: media_reference_candidates(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.media_reference_candidates(reference_text text) RETURNS TABLE(workspace_uuid uuid, content_hash text)
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    SET search_path TO 'pg_catalog'
    AS $$
    SELECT DISTINCT parts[1]::uuid, lower(parts[2])
    FROM regexp_matches(reference_text,
        '(?:teams|workspaces)/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12})/sha256/([0-9a-f]{64})\.(?:jpg|png)',
        'gi') AS matches(parts);
$$;


--
-- Name: notify_ozon_jobs_wake(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_ozon_jobs_wake() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
    PERFORM pg_notify('ozon_jobs_wake', NEW.kind);
    RETURN NEW;
END;
$$;


--
-- Name: payment_order_agreement_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.payment_order_agreement_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.purchase_agreement IS DISTINCT FROM OLD.purchase_agreement THEN
        RAISE EXCEPTION 'payment order purchase agreement is immutable';
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: payment_order_subscription_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.payment_order_subscription_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.subscription_snapshot IS DISTINCT FROM OLD.subscription_snapshot THEN
        RAISE EXCEPTION 'payment order subscription snapshot is immutable';
    END IF;
    RETURN NEW;
END
$$;


--
-- Name: prompt_revisions_append_only(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prompt_revisions_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- Product deletion cascades into this table. current_query() is the client
    -- statement, which names sc_products and not this table. A direct rewrite
    -- names prompt_revisions and is refused, including for the table owner.
    IF TG_OP = 'DELETE' AND position('prompt_revisions' in current_query()) = 0 THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'prompt revisions are append-only';
END;
$$;


--
-- Name: prune_aged_inbox(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prune_aged_inbox(older_seconds bigint) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
    deleted bigint;
BEGIN
    IF older_seconds IS NULL OR older_seconds < 0 THEN
        older_seconds := 0;
    END IF;
    DELETE FROM public.event_inbox_events
     WHERE received_at < clock_timestamp() - (older_seconds::text || ' seconds')::interval;
    GET DIAGNOSTICS deleted = ROW_COUNT;
    RETURN deleted;
END;
$$;


--
-- Name: reap_stale_execution_permits(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reap_stale_execution_permits(p_limit bigint) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
DECLARE
    stale record;
    n bigint := 0;
BEGIN
    FOR stale IN
        SELECT holder_kind, holder_id, lease_epoch
          FROM (
                SELECT p.holder_kind, p.holder_id, p.lease_epoch
                  FROM public.execution_permits p
                 WHERE p.released_at IS NULL
                   AND (
                        (p.holder_kind = 'job' AND NOT EXISTS (
                            SELECT 1
                            FROM public.jobs j
                            WHERE j.id = CASE
                                    WHEN p.holder_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                    THEN p.holder_id::uuid
                                END
                              AND j.lease_epoch = p.lease_epoch
                              AND j.state IN ('running', 'uncertain')
                              AND NOT (
                                  j.state = 'uncertain'
                                  AND j.kind = 'ai.recognize'
                                  AND j.lease_until IS NOT NULL
                                  AND j.lease_until <= clock_timestamp() - interval '180 seconds'
                                  AND NOT EXISTS (
                                      SELECT 1 FROM public.ai_requests a
                                      WHERE a.org_id = j.org_id
                                        AND a.job_id = j.id
                                        AND a.status NOT IN ('settled', 'failed', 'unbilled_unknown')
                                  )
                              )
                        ))
                        OR (p.holder_kind IN ('ocr', 'upload_unit', 'verify')
                            AND p.expires_at IS NOT NULL
                            AND p.expires_at < clock_timestamp())
                   )
                 GROUP BY p.holder_kind, p.holder_id, p.lease_epoch
                 ORDER BY p.holder_kind, p.holder_id, p.lease_epoch
                 LIMIT GREATEST(p_limit, 1)
          ) stale_holders
         ORDER BY holder_kind, holder_id, lease_epoch
    LOOP
        IF public.release_execution_permit(stale.holder_kind, stale.holder_id, stale.lease_epoch) THEN
            n := n + 1;
        END IF;
    END LOOP;
    RETURN n;
END
$_$;


--
-- Name: refresh_account_queue_head(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.refresh_account_queue_head() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE u bigint:=COALESCE(NEW.submitter_user_id,OLD.submitter_user_id);
 l text:=COALESCE(NEW.lane,OLD.lane); oq bigint:=0; nq bigint:=0; orc bigint:=0; nr bigint:=0;
BEGIN
 IF TG_OP='UPDATE' AND (NEW.submitter_user_id<>OLD.submitter_user_id OR NEW.lane<>OLD.lane) THEN
  RAISE EXCEPTION 'Job execution User and lane are immutable';
 END IF;
 IF TG_OP<>'INSERT' AND NOT (OLD.kind IN ('media.render','media.upload') AND OLD.executor = 'browser') THEN
  IF OLD.state IN ('queued','retry_wait') THEN oq:=OLD.cost_units; END IF;
  IF OLD.state='running' THEN orc:=OLD.cost_units; END IF;
 END IF;
 IF TG_OP<>'DELETE' AND NOT (NEW.kind IN ('media.render','media.upload') AND NEW.executor = 'browser') THEN
  IF NEW.state IN ('queued','retry_wait') THEN nq:=NEW.cost_units; END IF;
  IF NEW.state='running' THEN nr:=NEW.cost_units; END IF;
 END IF;
 IF oq=0 AND nq=0 AND orc=0 AND nr=0 THEN RETURN COALESCE(NEW,OLD); END IF;
 INSERT INTO public.account_queue_head(user_id,lane) VALUES(u,l) ON CONFLICT DO NOTHING;
 UPDATE public.account_queue_head SET queued_cost=queued_cost-oq+nq,running_cost=running_cost-orc+nr
 WHERE user_id=u AND lane=l;
 UPDATE public.account_queue_head SET oldest_job_at=(SELECT min(run_at) FROM public.jobs
  WHERE submitter_user_id=u AND lane=l AND state IN ('queued','retry_wait') AND NOT (kind IN ('media.render','media.upload') AND executor = 'browser')) WHERE user_id=u AND lane=l;
 DELETE FROM public.account_queue_head WHERE user_id=u AND lane=l AND queued_cost=0 AND running_cost=0;
 RETURN COALESCE(NEW,OLD);
END $$;


--
-- Name: register_execution_demand(text, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.register_execution_demand(p_class text, p_user_id bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
    IF p_user_id <= 0 THEN
        RAISE EXCEPTION 'execution requires a positive User';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM public.execution_quota
        WHERE class = p_class
          AND user_id = 0
          AND NOT (class = 'ai_ocr' AND hard_limit = 0)
    ) THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('eq-live:' || p_class, 0));
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('eq-user:' || p_class || ':' || p_user_id::text, 0));
    INSERT INTO public.execution_quota(class, user_id, hard_limit)
    VALUES (p_class, p_user_id, public.execution_quota_user_limit(p_class))
    ON CONFLICT DO NOTHING;
    INSERT INTO public.execution_fairness(class, user_id, request_until)
    VALUES (p_class, p_user_id, clock_timestamp() + interval '30 seconds')
    ON CONFLICT (class, user_id) DO UPDATE SET request_until = excluded.request_until;
END
$$;


--
-- Name: release_execution_permit(text, text, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.release_execution_permit(p_holder_kind text, p_holder_id text, p_lease_epoch bigint) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    released_row record;
    did boolean := false;
    live_class text;
BEGIN
    FOR live_class IN
        SELECT DISTINCT p.class
        FROM public.execution_permits p
        JOIN public.execution_quota g ON g.class = p.class AND g.user_id = 0
        WHERE p.holder_kind = p_holder_kind
          AND p.holder_id = p_holder_id
          AND p.lease_epoch = p_lease_epoch
          AND p.released_at IS NULL
          AND NOT (g.class = 'ai_ocr' AND g.hard_limit = 0)
        ORDER BY p.class
    LOOP
        PERFORM pg_advisory_xact_lock(hashtextextended('eq-live:' || live_class, 0));
    END LOOP;

    IF p_holder_kind = 'job' THEN
      IF EXISTS (
        SELECT 1 FROM public.execution_permits owned
        WHERE owned.holder_kind = 'job'
          AND owned.holder_id = p_holder_id
          AND owned.lease_epoch = p_lease_epoch
          AND owned.released_at IS NULL
          AND (
              EXISTS (
                  SELECT 1 FROM public.ai_requests a
                  WHERE a.org_id = owned.org_id
                    AND a.job_id = p_holder_id::uuid
                    AND a.operation = 'ocr'
                    AND a.status IN ('held', 'dispatching')
              )
              OR EXISTS (
                  SELECT 1 FROM public.execution_permits unit
                  WHERE unit.holder_kind = 'upload_unit'
                    AND unit.org_id = owned.org_id
                    AND unit.holder_id LIKE ('job:' || p_holder_id || ':' || p_lease_epoch::text || ':%')
                    AND unit.released_at IS NULL
              )
          )
      ) THEN
        RETURN false;
      END IF;
    END IF;

    FOR released_row IN
        UPDATE public.execution_permits
           SET released_at = clock_timestamp()
         WHERE holder_kind = p_holder_kind
           AND holder_id = p_holder_id
           AND lease_epoch = p_lease_epoch
           AND released_at IS NULL
     RETURNING class, user_id
    LOOP
        did := true;
        UPDATE public.execution_quota
           SET used = used - 1
         WHERE class = released_row.class
           AND user_id = released_row.user_id
           AND used > 0;
    END LOOP;
    RETURN did;
END
$$;


--
-- Name: resolve_listing_credential_issues(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.resolve_listing_credential_issues() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 UPDATE submission_intents SET submission_issues = (
   SELECT jsonb_agg(CASE WHEN issue->>'scope' = 'store'
     AND issue->>'resolvedAtMs' IS NULL
     AND issue->>'retryAfterMs' IS NULL
     AND (issue->>'credentialRevision')::bigint <> NEW.credential_revision
   THEN jsonb_set(issue, '{resolvedAtMs}', to_jsonb((extract(epoch from clock_timestamp()) * 1000)::bigint))
   ELSE issue END ORDER BY ord)
   FROM jsonb_array_elements(submission_issues) WITH ORDINALITY e(issue, ord)
 ), updated_at = clock_timestamp()
 WHERE org_id = NEW.org_id AND store_id = NEW.uuid
 AND submission_issues @> '[{"scope":"store","resolvedAtMs":null}]'::jsonb;
 RETURN NEW;
END;
$$;


--
-- Name: sc_sources_manager_pin_flags(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sc_sources_manager_pin_flags() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
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
$$;


--
-- Name: seal_listing_row_events(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.seal_listing_row_events() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  c record;
  total int;
  lo int;
  hi int;
  chunk_n int;
  chunk_ids uuid[];
  chunk_rows uuid[];
  facts jsonb;
  now_revs jsonb;
  drifted uuid[];
  resealed jsonb;
  base_seq bigint;
BEGIN
  -- Seal guard (db-write-amp 05 / D-03): the heavy projection reads run
  -- BEFORE the cursor critical section opens; inside it only the counter
  -- advance, a cheap view_revision re-check, a bounded per-drifted-row
  -- recompute and the batched seq assignment remain — never a full projection
  -- query and never a new business row lock. Guard soundness: every concurrent
  -- change to a frozen fact input bumps listing_rows.view_revision (BEFORE
  -- UPDATE trigger bump_listing_view_revision, plus the Intent touch and the
  -- template fanout triggers). jobs state moves without touching the row
  -- (claim/lease paths): a stale frozen latest_media_job is accepted and
  -- self-heals through the next event or a client snapshot refresh.
  -- db-write-amp 08: events without a `rowId` are Card-level (payload frozen
  -- by the staging trigger); they take a seq in the shared per-card space but
  -- are skipped by the row facts precompute, never drift (a NULL key never
  -- compares distinct) and are sealed exactly as staged.

  -- ① Optimistic precompute — no cursor lock is held here. One entry per
  -- (org, card, rowId) this transaction staged; rows that moved away or were
  -- deleted are absent, and absence seals as removed. Map keys carry org and
  -- card because a move stages the same rowId on two cards in one transaction.
  SELECT coalesce(jsonb_object_agg(
           s.org_id::text || ':' || s.stream_card_id::text || ':' || s.row_id::text,
           jsonb_build_object('vr', r.view_revision, 'facts', to_jsonb(r) || jsonb_build_object('latest_intent', COALESCE((
          SELECT to_jsonb(i) FROM submission_intents i
            WHERE i.org_id = r.org_id AND i.listing_row_id = r.id
            ORDER BY i.row_revision DESC, i.created_at DESC, i.id DESC LIMIT 1), '{}'::jsonb),
          'current_template_sha256', COALESCE((SELECT CASE WHEN card.supplier_product_id IS NULL
            THEN card.payload->>'psdTemplateSha256' ELSE '' END FROM listing_cards card
            WHERE card.org_id = r.org_id AND card.id = r.card_id), ''),
          'latest_media_job', COALESCE((SELECT jsonb_build_object('kind', j.kind, 'state', j.state, 'result_ref', j.result_ref)
            FROM jobs j WHERE j.org_id = r.org_id AND j.aggregate_id = r.id
              AND j.aggregate_type = 'listing_row' AND j.kind IN ('media.render', 'media.upload')
              AND j.payload->>'executor' = 'browser'
              AND j.payload->>'sourceSha256' = r.payload->'source'->>'sha256'
              AND (EXISTS (SELECT 1 FROM listing_cards card WHERE card.org_id = r.org_id
                         AND card.id = r.card_id AND card.supplier_product_id IS NOT NULL)
                   OR j.payload->>'psdTemplateSha256' = (SELECT card.payload->>'psdTemplateSha256' FROM listing_cards card
                     WHERE card.org_id = r.org_id AND card.id = r.card_id))
              AND (j.kind = 'media.render' OR j.payload->>'manifestDigest' = r.payload->'renderEvidence'->>'manifest_digest')
            ORDER BY j.input_revision DESC, j.created_at DESC, j.id DESC LIMIT 1), '{}'::jsonb)))), '{}'::jsonb)
    INTO facts
    FROM (SELECT DISTINCT org_id, stream_card_id, (payload->>'rowId')::uuid AS row_id
            FROM listing_row_events
           WHERE stream_txid = txid_current() AND stream_seq IS NULL
             AND payload->>'rowId' IS NOT NULL) s
    JOIN listing_rows r
      ON r.org_id = s.org_id AND r.card_id = s.stream_card_id AND r.id = s.row_id;

  -- All business writes have finished. Sort cards before locking their counters
  -- so a multi-card transaction cannot reverse another transaction's order.
  FOR c IN
    SELECT ev.org_id, ev.stream_card_id,
           array_agg(ev.id ORDER BY ev.created_at, ev.id) AS ids,
           array_agg((ev.payload->>'rowId')::uuid ORDER BY ev.created_at, ev.id) AS row_ids
      FROM listing_row_events ev
     WHERE ev.stream_txid = txid_current() AND ev.stream_seq IS NULL
     GROUP BY ev.org_id, ev.stream_card_id
     ORDER BY ev.org_id, ev.stream_card_id
  LOOP
    -- A single card with a batch larger than the chunk advances the counter
    -- once per chunk: the critical-section statements stay bounded.
    total := coalesce(array_length(c.ids, 1), 0);
    FOR lo IN 1..total BY 256 LOOP
      hi := lo + 256 - 1;
      IF hi > total THEN hi := total; END IF;
      chunk_ids := c.ids[lo:hi];
      chunk_rows := c.row_ids[lo:hi];
      chunk_n := hi - lo + 1;

      -- ② Critical section opens: take this chunk's seq range.
      INSERT INTO listing_card_cursors (org_id, card_id)
        VALUES (c.org_id, c.stream_card_id) ON CONFLICT DO NOTHING;
      UPDATE listing_card_cursors SET seq = seq + chunk_n
        WHERE org_id = c.org_id AND card_id = c.stream_card_id
        RETURNING seq - chunk_n INTO base_seq;

      -- ③ Guard: re-read only the affected rows' view_revision (one cheap
      -- primary-key lookup per chunk) and recompute just the drifted rows.
      -- The card filter matches the precompute predicate, so a row that left
      -- this card re-seals as removed exactly like a live facts query would.
      SELECT coalesce(jsonb_object_agg(r.id::text, r.view_revision), '{}'::jsonb)
        INTO now_revs
        FROM listing_rows r
        WHERE r.org_id = c.org_id AND r.card_id = c.stream_card_id
          AND r.id = ANY(chunk_rows);
      SELECT coalesce(array_agg(DISTINCT (ev.payload->>'rowId')::uuid), ARRAY[]::uuid[])
        INTO drifted
        FROM listing_row_events ev
        WHERE ev.id = ANY(chunk_ids)
          AND (facts -> (ev.org_id::text || ':' || ev.stream_card_id::text || ':' || (ev.payload->>'rowId'))) -> 'vr'
              IS DISTINCT FROM (now_revs -> (ev.payload->>'rowId'));
      IF cardinality(drifted) > 0 THEN
        SELECT coalesce(jsonb_object_agg(
                 r.org_id::text || ':' || r.card_id::text || ':' || r.id::text,
                 jsonb_build_object('vr', r.view_revision, 'facts', to_jsonb(r) || jsonb_build_object('latest_intent', COALESCE((
          SELECT to_jsonb(i) FROM submission_intents i
            WHERE i.org_id = r.org_id AND i.listing_row_id = r.id
            ORDER BY i.row_revision DESC, i.created_at DESC, i.id DESC LIMIT 1), '{}'::jsonb),
          'current_template_sha256', COALESCE((SELECT CASE WHEN card.supplier_product_id IS NULL
            THEN card.payload->>'psdTemplateSha256' ELSE '' END FROM listing_cards card
            WHERE card.org_id = r.org_id AND card.id = r.card_id), ''),
          'latest_media_job', COALESCE((SELECT jsonb_build_object('kind', j.kind, 'state', j.state, 'result_ref', j.result_ref)
            FROM jobs j WHERE j.org_id = r.org_id AND j.aggregate_id = r.id
              AND j.aggregate_type = 'listing_row' AND j.kind IN ('media.render', 'media.upload')
              AND j.payload->>'executor' = 'browser'
              AND j.payload->>'sourceSha256' = r.payload->'source'->>'sha256'
              AND (EXISTS (SELECT 1 FROM listing_cards card WHERE card.org_id = r.org_id
                         AND card.id = r.card_id AND card.supplier_product_id IS NOT NULL)
                   OR j.payload->>'psdTemplateSha256' = (SELECT card.payload->>'psdTemplateSha256' FROM listing_cards card
                     WHERE card.org_id = r.org_id AND card.id = r.card_id))
              AND (j.kind = 'media.render' OR j.payload->>'manifestDigest' = r.payload->'renderEvidence'->>'manifest_digest')
            ORDER BY j.input_revision DESC, j.created_at DESC, j.id DESC LIMIT 1), '{}'::jsonb)))), '{}'::jsonb)
          INTO resealed
          FROM listing_rows r
          WHERE r.org_id = c.org_id AND r.card_id = c.stream_card_id AND r.id = ANY(drifted);
        facts := (facts - (SELECT array_agg(c.org_id::text || ':' || c.stream_card_id::text || ':' || d::text)
                             FROM unnest(drifted) AS d)) || resealed;
      END IF;

      -- ④ One statement per chunk assigns seq + frozen payload; absent map
      -- entries seal as removed with a null row, exactly like the previous
      -- per-event facts query missing the row. Card-level events (no rowId)
      -- keep their staged payload verbatim. ⑤ The surrounding transaction's
      -- COMMIT closes the critical section.
      WITH ranked AS (
        SELECT ev.id, base_seq + row_number() OVER (ORDER BY ev.created_at, ev.id) AS seq
          FROM listing_row_events ev
         WHERE ev.id = ANY(chunk_ids)
      )
      UPDATE listing_row_events e
         SET stream_seq = ranked.seq,
             payload = CASE WHEN e.payload->>'rowId' IS NULL THEN e.payload
               ELSE e.payload || jsonb_build_object(
                 'removed', (facts -> (e.org_id::text || ':' || e.stream_card_id::text || ':' || (e.payload->>'rowId'))) IS NULL,
                 'row', (facts -> (e.org_id::text || ':' || e.stream_card_id::text || ':' || (e.payload->>'rowId'))) -> 'facts') END
        FROM ranked
       WHERE e.id = ranked.id;
    END LOOP;
    PERFORM pg_notify('listing_card_events', c.stream_card_id::text || ' ' || (base_seq + chunk_n)::text);
  END LOOP;
  RETURN NULL;
END $$;


--
-- Name: stage_listing_card_event(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.stage_listing_card_event() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- One card-level invalidation per transaction and Card (merged by the
  -- partial unique index). The payload has no `rowId` — that absence is what
  -- makes the event card-level — and carries the reason plus the new template
  -- identity; a cleared template ships as '' like the row facts projection.
  INSERT INTO listing_row_events (id, org_id, payload, stream_card_id, stream_txid)
  VALUES (gen_random_uuid(), NEW.org_id,
          jsonb_build_object('reason', 'template_changed',
                             'psdTemplateSha256', COALESCE(NEW.payload->>'psdTemplateSha256', '')),
          NEW.id, txid_current())
  ON CONFLICT (stream_txid, org_id, stream_card_id)
    WHERE stream_seq IS NULL AND payload->>'rowId' IS NULL
  DO UPDATE SET payload = EXCLUDED.payload;
  RETURN NULL;
END $$;


--
-- Name: stage_listing_row_event(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.stage_listing_row_event() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE r record;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.card_id IS DISTINCT FROM NEW.card_id THEN
    INSERT INTO listing_row_events (id, org_id, payload, stream_card_id, stream_txid)
    VALUES (gen_random_uuid(), OLD.org_id,
            jsonb_build_object('rowId', OLD.id, 'removed', true), OLD.card_id, txid_current())
    ON CONFLICT (stream_txid, org_id, stream_card_id, (payload->>'rowId'))
      WHERE stream_seq IS NULL
    DO UPDATE SET payload = EXCLUDED.payload;
  END IF;
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  INSERT INTO listing_row_events (id, org_id, payload, stream_card_id, stream_txid)
  VALUES (gen_random_uuid(), r.org_id,
          jsonb_build_object('rowId', r.id, 'removed', TG_OP = 'DELETE'), r.card_id, txid_current())
  ON CONFLICT (stream_txid, org_id, stream_card_id, (payload->>'rowId'))
    WHERE stream_seq IS NULL
  DO UPDATE SET payload = EXCLUDED.payload;
  RETURN NULL;
END $$;


--
-- Name: storage_key_fence(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.storage_key_fence(p_bucket_identity text, p_object_key text) RETURNS bigint
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    SET search_path TO 'pg_catalog'
    AS $$
    SELECT hashtextextended('storage-key:v1:' || p_bucket_identity || ':' || p_object_key, 0)
$$;


--
-- Name: storage_ref_candidates(jsonb, text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.storage_ref_candidates(p_row jsonb, p_paths text[]) RETURNS uuid[]
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'pg_catalog'
    AS $_$
DECLARE
    v_out uuid[] := '{}';
    v_path text;
    v_value jsonb;
    v_item jsonb;
    v_text text;
BEGIN
    IF p_row IS NULL THEN
        RETURN v_out;
    END IF;
    FOREACH v_path IN ARRAY p_paths LOOP
        v_value := p_row -> v_path;
        CONTINUE WHEN v_value IS NULL OR jsonb_typeof(v_value) = 'null';
        IF jsonb_typeof(v_value) = 'string' THEN
            v_text := v_value #>> '{}';
            IF v_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
                v_out := v_out || v_text::uuid;
            END IF;
        ELSIF jsonb_typeof(v_value) = 'array' THEN
            FOR v_item IN SELECT value FROM jsonb_array_elements(v_value) LOOP
                IF jsonb_typeof(v_item) = 'string' THEN
                    v_text := v_item #>> '{}';
                ELSIF jsonb_typeof(v_item) = 'object' THEN
                    v_text := COALESCE(v_item ->> 'objectId', v_item ->> 'object_id');
                ELSE
                    v_text := NULL;
                END IF;
                IF v_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
                    v_out := v_out || v_text::uuid;
                END IF;
            END LOOP;
        END IF;
    END LOOP;
    RETURN ARRAY(SELECT DISTINCT x FROM unnest(v_out) AS x ORDER BY x);
END;
$_$;


--
-- Name: subscription_capacity(bigint, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.subscription_capacity(workspace bigint, at_time timestamp with time zone) RETURNS TABLE(plan_key text, purchased_stores bigint, stores bigint, members bigint, keep_stores uuid[])
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
    -- Members are not sold. Every workspace gets the global cap of 10; it must
    -- equal billing/domain.MemberCap, which the integration suite checks.
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


--
-- Name: subscription_member_allowed(bigint, bigint, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.subscription_member_allowed(workspace bigint, member bigint, at_time timestamp with time zone) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
    WITH entitlement AS (
        SELECT members AS capacity FROM public.subscription_capacity(workspace,at_time)
    ), ranked AS (
        SELECT id, role, row_number() OVER (ORDER BY (role = 'owner') DESC, join_order, id) AS rn
          FROM public.organization_members
         WHERE org_id = workspace AND status = 'active' AND NOT manual_disabled
    )
    SELECT COALESCE((SELECT r.role = 'owner' OR r.rn <= COALESCE(e.capacity, 1)
                      FROM ranked r LEFT JOIN entitlement e ON true WHERE r.id = member), false)
$$;


--
-- Name: subscription_store_allowed(bigint, uuid, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.subscription_store_allowed(workspace bigint, store uuid, at_time timestamp with time zone) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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


--
-- Name: supplier_dispatch_quote(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.supplier_dispatch_quote(p_dispatch_id uuid) RETURNS TABLE(line_count integer, missing_count integer, total_cents bigint)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    SELECT COUNT(*)::integer,
           COALESCE(SUM(CASE WHEN priced.unit_cents IS NULL OR priced.unit_cents <= 0 THEN 1 ELSE 0 END), 0)::integer,
           COALESCE(SUM(CASE WHEN priced.unit_cents > 0 THEN GREATEST(COALESCE(l.quantity, 1), 1)::bigint * priced.unit_cents ELSE 0 END), 0)::bigint
    FROM public.delegate_dispatches d
    JOIN public.sc_source_fulfillers f ON f.fulfiller_id = d.fulfiller_id AND f.source_id = d.source_id
    CROSS JOIN LATERAL jsonb_to_recordset(COALESCE(d.payload->'lines', '[]'::jsonb)) AS l(offer_id text, quantity integer)
    LEFT JOIN LATERAL (
        SELECT COALESCE(o.cost_cents, 0) + COALESCE(o.shipping_cost_cents, 0) AS unit_cents
        FROM public.sc_skus k
        JOIN public.sc_source_offers o ON o.sku_id = k.sku_id AND o.source_id = d.source_id
        WHERE k.platform_code = l.offer_id
        LIMIT 1
    ) priced ON true
    WHERE d.dispatch_id = p_dispatch_id
      AND f.user_id = NULLIF(current_setting('app.current_supplier_user_id', true), '')::bigint;
$$;


--
-- Name: supplier_fulfiller_sources(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.supplier_fulfiller_sources() RETURNS TABLE(source_id text, name text, country text, icon text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    SELECT s.source_id, COALESCE(s.name, ''), COALESCE(s.country, ''), COALESCE(s.icon, '')
    FROM public.sc_sources s
    WHERE EXISTS (
        SELECT 1 FROM public.sc_source_fulfillers f
        WHERE f.source_id = s.source_id
          AND f.user_id = NULLIF(current_setting('app.current_supplier_user_id', true), '')::bigint
          AND (f.status = 'active' OR EXISTS (
              SELECT 1 FROM public.delegate_dispatches d
              WHERE d.fulfiller_id = f.fulfiller_id AND d.source_id = f.source_id
          ))
    )
    ORDER BY s.source_id;
$$;


--
-- Name: sync_account_side_tables(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_account_side_tables() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


--
-- Name: sync_storage_object_refs(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_storage_object_refs() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
    v_owner_kind text := TG_ARGV[0];
    v_paths text[] := string_to_array(TG_ARGV[1], ',');
    v_owner_column text := TG_ARGV[2];
    v_org_column text := TG_ARGV[3];
    v_old_ids uuid[] := '{}';
    v_new_ids uuid[] := '{}';
    v_owner text;
    v_org bigint;
    v_object uuid;
    v_identity text;
    v_key text;
    v_state text;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        v_old_ids := public.storage_ref_candidates(to_jsonb(OLD), v_paths);
    END IF;
    IF TG_OP <> 'DELETE' THEN
        v_new_ids := public.storage_ref_candidates(to_jsonb(NEW), v_paths);
    END IF;

    IF TG_OP = 'DELETE' THEN
        v_owner := to_jsonb(OLD) ->> v_owner_column;
    ELSE
        v_owner := to_jsonb(NEW) ->> v_owner_column;
    END IF;
    IF v_owner IS NULL OR v_owner = '' THEN
        RAISE EXCEPTION 'storage reference owner is empty' USING ERRCODE = 'P0S02';
    END IF;
    IF v_org_column <> '' THEN
        IF TG_OP = 'DELETE' THEN
            v_org := NULLIF(to_jsonb(OLD) ->> v_org_column, '')::bigint;
        ELSE
            v_org := NULLIF(to_jsonb(NEW) ->> v_org_column, '')::bigint;
        END IF;
    END IF;

    FOREACH v_object IN ARRAY v_old_ids LOOP
        CONTINUE WHEN v_object = ANY (v_new_ids);
        SELECT bucket_identity, object_key INTO v_identity, v_key
          FROM public.storage_objects WHERE id = v_object;
        IF FOUND THEN
            PERFORM public.lock_storage_key_shared(v_identity, v_key);
        END IF;
        DELETE FROM public.storage_object_refs
         WHERE object_id = v_object AND owner_kind = v_owner_kind AND owner_id = v_owner;
    END LOOP;

    FOREACH v_object IN ARRAY v_new_ids LOOP
        CONTINUE WHEN v_object = ANY (v_old_ids);
        SELECT bucket_identity, object_key, state INTO v_identity, v_key, v_state
          FROM public.storage_objects WHERE id = v_object FOR KEY SHARE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'storage object does not exist' USING ERRCODE = 'P0S03';
        END IF;
        IF v_state <> 'live' THEN
            RAISE EXCEPTION 'storage object is not live' USING ERRCODE = 'P0S04';
        END IF;
        PERFORM public.lock_storage_key_shared(v_identity, v_key);
        INSERT INTO public.storage_object_refs (object_id, owner_kind, owner_id, owner_org_id)
        VALUES (v_object, v_owner_kind, v_owner, v_org)
        ON CONFLICT (object_id, owner_kind, owner_id) DO NOTHING;
    END LOOP;
    RETURN NULL;
END;
$$;


--
-- Name: touch_listing_intent_row(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_listing_intent_row() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE listing_rows SET updated_at = clock_timestamp()
    WHERE org_id = COALESCE(NEW.org_id, OLD.org_id)
      AND id = COALESCE(NEW.listing_row_id, OLD.listing_row_id);
  RETURN NULL;
END $$;


--
-- Name: try_grant_execution_permit(text[], bigint, bigint, text, text, bigint, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.try_grant_execution_permit(p_classes text[], p_org_id bigint, p_user_id bigint, p_holder_kind text, p_holder_id text, p_lease_epoch bigint, p_expires_at timestamp with time zone) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    c text;
    missing text[];
    next_user bigint;
    inserted bigint;
BEGIN
    IF p_org_id <= 0 OR p_user_id <= 0 OR p_holder_id = ''
       OR cardinality(p_classes) IS NULL OR cardinality(p_classes) = 0 THEN
        RETURN false;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.organization_members
        WHERE org_id = p_org_id AND user_id = p_user_id AND status = 'active'
    ) THEN
        RETURN false;
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.execution_permits
        WHERE holder_kind = p_holder_kind
          AND holder_id = p_holder_id
          AND lease_epoch = p_lease_epoch
          AND class = ANY (p_classes)
          AND (released_at IS NOT NULL OR org_id <> p_org_id OR user_id IS DISTINCT FROM p_user_id)
    ) THEN
        RETURN false;
    END IF;
    SELECT array_agg(DISTINCT x) INTO missing
    FROM unnest(p_classes) x
    WHERE NOT EXISTS (
        SELECT 1 FROM public.execution_permits p
        WHERE p.holder_kind = p_holder_kind
          AND p.holder_id = p_holder_id
          AND p.lease_epoch = p_lease_epoch
          AND p.class = x
    );
    IF missing IS NULL THEN
        RETURN true;
    END IF;
    -- All finite class locks before any User lock, so this cannot invert
    -- against lock_execution_quota (classes, then the User).
    FOR c IN
        SELECT t.x
        FROM unnest(missing) AS t(x)
        WHERE EXISTS (
            SELECT 1 FROM public.execution_quota g
            WHERE g.class = t.x
              AND g.user_id = 0
              AND NOT (g.class = 'ai_ocr' AND g.hard_limit = 0)
        )
        ORDER BY t.x
    LOOP
        PERFORM pg_advisory_xact_lock(hashtextextended('eq-live:' || c, 0));
    END LOOP;
    FOR c IN
        SELECT t.x FROM unnest(missing) AS t(x) ORDER BY t.x
    LOOP
        PERFORM public.register_execution_demand(c, p_user_id);
    END LOOP;
    FOREACH c IN ARRAY missing LOOP
        SELECT f.user_id INTO next_user
        FROM public.execution_fairness f
        JOIN public.execution_quota q ON q.class = f.class AND q.user_id = f.user_id
        JOIN public.execution_fairness_cursor cur ON cur.class = f.class
        WHERE f.class = c
          AND f.request_until > clock_timestamp()
          AND q.used < q.hard_limit
        ORDER BY (f.user_id > cur.last_user_id) DESC, f.user_id
        LIMIT 1;
        IF next_user IS DISTINCT FROM p_user_id THEN
            RETURN false;
        END IF;
    END LOOP;
    INSERT INTO public.execution_permits (
        holder_kind, holder_id, lease_epoch, class, org_id, user_id, expires_at
    )
    SELECT p_holder_kind, p_holder_id, p_lease_epoch, x, p_org_id, p_user_id, p_expires_at
    FROM unnest(missing) AS t(x)
    WHERE (
        SELECT COALESCE(bool_and(
            (
                (g.hard_limit = 0 AND g.class = 'ai_ocr')
                OR (
                    SELECT count(*)::bigint
                    FROM public.execution_permits p
                    WHERE p.class = need.class AND p.released_at IS NULL
                ) < g.hard_limit
            )
            AND (
                SELECT count(*)::bigint
                FROM public.execution_permits p
                WHERE p.class = need.class
                  AND p.user_id = p_user_id
                  AND p.released_at IS NULL
            ) < u.hard_limit
        ), false)
        FROM unnest(missing) AS need(class)
        JOIN public.execution_quota g ON g.class = need.class AND g.user_id = 0
        JOIN public.execution_quota u ON u.class = need.class AND u.user_id = p_user_id
    );
    GET DIAGNOSTICS inserted = ROW_COUNT;
    IF inserted IS DISTINCT FROM cardinality(missing) THEN
        RETURN false;
    END IF;
    UPDATE public.execution_quota
       SET used = used + 1
     WHERE class = ANY (missing) AND user_id = p_user_id;
    UPDATE public.execution_fairness_cursor
       SET last_user_id = p_user_id
     WHERE class = ANY (missing);
    DELETE FROM public.execution_fairness
     WHERE class = ANY (missing) AND user_id = p_user_id;
    RETURN true;
END
$$;


--
-- Name: try_lock_storage_key_exclusive(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.try_lock_storage_key_exclusive(p_bucket_identity text, p_object_key text) RETURNS boolean
    LANGUAGE sql STRICT
    SET search_path TO 'pg_catalog'
    AS $$
    SELECT pg_try_advisory_xact_lock(public.storage_key_fence(p_bucket_identity, p_object_key))
$$;


--
-- Name: wallet_ledger_is_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.wallet_ledger_is_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'wallet_ledger rows are immutable';
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: account_admin_totp; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_admin_totp (
    user_id bigint NOT NULL,
    secret_nonce bytea NOT NULL,
    secret_ciphertext bytea NOT NULL,
    confirmed_at timestamp with time zone,
    recovery_hashes text[] DEFAULT '{}'::text[] NOT NULL,
    failed_attempts integer DEFAULT 0 NOT NULL,
    failures_reset_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT ck_account_admin_totp_ciphertext CHECK (((octet_length(secret_ciphertext) >= 17) AND (octet_length(secret_ciphertext) <= 128))),
    CONSTRAINT ck_account_admin_totp_failures CHECK ((failed_attempts >= 0)),
    CONSTRAINT ck_account_admin_totp_nonce CHECK ((octet_length(secret_nonce) = 12))
);


--
-- Name: account_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_credentials (
    user_id bigint NOT NULL,
    password_hash character varying(255) NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: account_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_profiles (
    user_id bigint NOT NULL,
    name character varying(255) NOT NULL,
    target character varying(64) DEFAULT '/workspace'::character varying NOT NULL,
    supplier_id character varying(64) DEFAULT ''::character varying NOT NULL,
    active_org_id bigint,
    updated_at timestamp with time zone NOT NULL,
    avatar_bytes bytea,
    avatar_updated_at_ms bigint,
    name_changed_at_ms bigint
);


--
-- Name: account_queue_cursor; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_queue_cursor (
    lane text NOT NULL,
    last_user_id bigint DEFAULT 0 NOT NULL
);


--
-- Name: account_queue_head; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_queue_head (
    user_id bigint NOT NULL,
    lane text NOT NULL,
    queued_cost bigint DEFAULT 0 NOT NULL,
    running_cost bigint DEFAULT 0 NOT NULL,
    oldest_job_at timestamp with time zone,
    CONSTRAINT account_queue_head_check CHECK (((queued_cost >= 0) AND (running_cost >= 0)))
);


--
-- Name: account_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_sessions (
    token_hash character varying(128) NOT NULL,
    user_id bigint NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    admin_step_up_until timestamp with time zone
);


--
-- Name: account_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_users (
    id bigint NOT NULL,
    public_id character varying(64) NOT NULL,
    uuid uuid DEFAULT gen_random_uuid() NOT NULL,
    email character varying(320) NOT NULL,
    password_hash character varying(255) NOT NULL,
    role character varying(32) DEFAULT 'user'::character varying NOT NULL,
    name character varying(255) NOT NULL,
    target character varying(64) DEFAULT '/workspace'::character varying NOT NULL,
    supplier_id character varying(64) DEFAULT ''::character varying NOT NULL,
    plan character varying(32) DEFAULT 'free'::character varying NOT NULL,
    disabled_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    active_org_id bigint,
    invited_by_agent_user_id bigint,
    agent_attributed_at timestamp with time zone,
    agent_attribution_bps integer,
    agent_attribution_source character varying(16),
    last_login_at timestamp with time zone,
    email_verified_at timestamp with time zone,
    account_kind text DEFAULT 'platform'::text NOT NULL,
    must_change_password boolean DEFAULT false NOT NULL,
    CONSTRAINT account_users_agent_attribution_bps_range CHECK (((agent_attribution_bps IS NULL) OR ((agent_attribution_bps >= 0) AND (agent_attribution_bps <= 10000)))),
    CONSTRAINT account_users_agent_attribution_source_known CHECK (((agent_attribution_source IS NULL) OR ((agent_attribution_source)::text = ANY ((ARRAY['register'::character varying, 'claim'::character varying])::text[])))),
    CONSTRAINT account_users_not_self_invited CHECK (((invited_by_agent_user_id IS NULL) OR (invited_by_agent_user_id <> id))),
    CONSTRAINT ck_account_users_kind CHECK ((account_kind = ANY (ARRAY['platform'::text, 'supplier'::text]))),
    CONSTRAINT ck_account_users_supplier_is_user CHECK (((account_kind = 'platform'::text) OR ((role)::text = 'user'::text)))
);


--
-- Name: account_users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.account_users ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.account_users_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: agent_commission_ledger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_commission_ledger (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    entry_type character varying(24) NOT NULL,
    idempotency_key character varying(128) NOT NULL,
    amount_cents bigint NOT NULL,
    held_delta_cents bigint NOT NULL,
    balance_before_cents bigint NOT NULL,
    balance_after_cents bigint NOT NULL,
    held_before_cents bigint NOT NULL,
    held_after_cents bigint NOT NULL,
    commission_id bigint,
    withdrawal_id bigint,
    note text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT agent_commission_ledger_balance_applies CHECK ((balance_after_cents = (balance_before_cents + amount_cents))),
    CONSTRAINT agent_commission_ledger_held_applies CHECK ((held_after_cents = (held_before_cents + held_delta_cents))),
    CONSTRAINT agent_commission_ledger_type_known CHECK (((entry_type)::text = ANY ((ARRAY['commission'::character varying, 'transfer_out'::character varying, 'withdrawal_hold'::character varying, 'withdrawal_paid'::character varying, 'withdrawal_release'::character varying])::text[])))
);


--
-- Name: agent_commission_ledger_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.agent_commission_ledger ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.agent_commission_ledger_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: agent_commission_wallets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_commission_wallets (
    user_id bigint NOT NULL,
    balance_cents bigint DEFAULT 0 NOT NULL,
    held_cents bigint DEFAULT 0 NOT NULL,
    version bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT agent_commission_wallets_balance_nonneg CHECK ((balance_cents >= 0)),
    CONSTRAINT agent_commission_wallets_held_bounds CHECK (((held_cents >= 0) AND (held_cents <= balance_cents)))
);


--
-- Name: agent_commissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_commissions (
    id bigint NOT NULL,
    agent_user_id bigint NOT NULL,
    invitee_user_id bigint NOT NULL,
    payment_order_id bigint NOT NULL,
    org_id bigint NOT NULL,
    order_amount_cents bigint NOT NULL,
    rebate_bps integer NOT NULL,
    amount_cents bigint NOT NULL,
    ledger_idempotency_key character varying(128),
    status character varying(16) NOT NULL,
    note text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT agent_commissions_bps_range CHECK (((rebate_bps >= 0) AND (rebate_bps <= 10000))),
    CONSTRAINT agent_commissions_status_shape CHECK (((((status)::text = 'credited'::text) AND (amount_cents > 0) AND (ledger_idempotency_key IS NOT NULL)) OR (((status)::text = 'skipped'::text) AND (amount_cents = 0) AND (ledger_idempotency_key IS NULL))))
);


--
-- Name: agent_commissions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.agent_commissions ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.agent_commissions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: agent_rebate_policy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_rebate_policy (
    singleton boolean DEFAULT true NOT NULL,
    default_rebate_bps integer NOT NULL,
    updated_by_user_id bigint,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    min_order_cents bigint DEFAULT 10000 NOT NULL,
    attribution_validity_days integer DEFAULT 365 NOT NULL,
    min_withdraw_cents bigint DEFAULT 10000 NOT NULL,
    CONSTRAINT agent_rebate_policy_bps_range CHECK (((default_rebate_bps >= 0) AND (default_rebate_bps <= 10000))),
    CONSTRAINT agent_rebate_policy_min_order_nonneg CHECK ((min_order_cents >= 0)),
    CONSTRAINT agent_rebate_policy_min_withdraw_nonneg CHECK ((min_withdraw_cents >= 0)),
    CONSTRAINT agent_rebate_policy_singleton CHECK (singleton),
    CONSTRAINT agent_rebate_policy_validity_range CHECK (((attribution_validity_days >= 0) AND (attribution_validity_days <= 3650)))
);


--
-- Name: agent_withdrawals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_withdrawals (
    id bigint NOT NULL,
    public_id character varying(32) NOT NULL,
    user_id bigint NOT NULL,
    amount_cents bigint NOT NULL,
    channel character varying(16) NOT NULL,
    account character varying(128) NOT NULL,
    real_name character varying(64) NOT NULL,
    status character varying(16) NOT NULL,
    reference character varying(128),
    reject_reason character varying(200),
    requested_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    decided_at timestamp with time zone,
    decided_by_user_id bigint,
    CONSTRAINT agent_withdrawals_amount_pos CHECK ((amount_cents > 0)),
    CONSTRAINT agent_withdrawals_channel_known CHECK (((channel)::text = ANY ((ARRAY['alipay'::character varying, 'wechat'::character varying])::text[]))),
    CONSTRAINT agent_withdrawals_status_known CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'paid'::character varying, 'rejected'::character varying])::text[]))),
    CONSTRAINT agent_withdrawals_terminal_shape CHECK (((((status)::text = 'pending'::text) AND (decided_at IS NULL) AND (decided_by_user_id IS NULL) AND (reference IS NULL) AND (reject_reason IS NULL)) OR (((status)::text = 'paid'::text) AND (decided_at IS NOT NULL) AND (decided_by_user_id IS NOT NULL) AND (reject_reason IS NULL)) OR (((status)::text = 'rejected'::text) AND (decided_at IS NOT NULL) AND (decided_by_user_id IS NOT NULL) AND (reject_reason IS NOT NULL) AND (btrim((reject_reason)::text) <> ''::text))))
);


--
-- Name: agent_withdrawals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.agent_withdrawals ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.agent_withdrawals_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: agents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agents (
    user_id bigint NOT NULL,
    invite_code character varying(32) NOT NULL,
    status character varying(16) DEFAULT 'active'::character varying NOT NULL,
    created_by_user_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    review_flagged_at timestamp with time zone,
    payout_channel character varying(16),
    payout_account character varying(128),
    payout_real_name character varying(64),
    CONSTRAINT agents_invite_code_shape CHECK (((invite_code)::text ~ '^[A-Z0-9]{4,32}$'::text)),
    CONSTRAINT agents_payout_complete CHECK ((((payout_channel IS NULL) AND (payout_account IS NULL) AND (payout_real_name IS NULL)) OR (((payout_channel)::text = ANY ((ARRAY['alipay'::character varying, 'wechat'::character varying])::text[])) AND (payout_account IS NOT NULL) AND (btrim((payout_account)::text) <> ''::text) AND (payout_real_name IS NOT NULL) AND (btrim((payout_real_name)::text) <> ''::text)))),
    CONSTRAINT agents_status_known CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'disabled'::character varying])::text[])))
);


--
-- Name: ai_billing_ratio_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_billing_ratio_documents (
    id bigint NOT NULL,
    org_id bigint,
    kind text NOT NULL,
    document jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT ai_billing_ratio_documents_document_check CHECK ((jsonb_typeof(document) = 'object'::text)),
    CONSTRAINT ai_billing_ratio_documents_kind_check CHECK ((kind = ANY (ARRAY['model_ratio'::text, 'model_price'::text, 'completion_ratio'::text, 'cache_ratio'::text, 'create_cache_ratio'::text, 'group_ratio'::text, 'image_ratio'::text, 'audio_ratio'::text, 'audio_completion_ratio'::text, 'billing_expr'::text])))
);

ALTER TABLE ONLY public.ai_billing_ratio_documents FORCE ROW LEVEL SECURITY;


--
-- Name: ai_billing_ratio_documents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ai_billing_ratio_documents_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ai_billing_ratio_documents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ai_billing_ratio_documents_id_seq OWNED BY public.ai_billing_ratio_documents.id;


--
-- Name: ai_consume_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_consume_logs (
    id bigint NOT NULL,
    org_id bigint NOT NULL,
    ai_request_id bigint,
    user_id bigint NOT NULL,
    created_at bigint NOT NULL,
    type integer NOT NULL,
    content text DEFAULT ''::text NOT NULL,
    username text DEFAULT ''::text NOT NULL,
    token_name text DEFAULT ''::text NOT NULL,
    model_name text DEFAULT ''::text NOT NULL,
    quota bigint DEFAULT 0 NOT NULL,
    prompt_tokens integer DEFAULT 0 NOT NULL,
    completion_tokens integer DEFAULT 0 NOT NULL,
    use_time integer DEFAULT 0 NOT NULL,
    is_stream boolean DEFAULT false NOT NULL,
    channel integer DEFAULT 0 NOT NULL,
    token_id bigint DEFAULT 0 NOT NULL,
    "group" text DEFAULT ''::text NOT NULL,
    ip text DEFAULT ''::text NOT NULL,
    request_id character varying(64) DEFAULT ''::character varying NOT NULL,
    upstream_request_id character varying(128) DEFAULT ''::character varying NOT NULL,
    other jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT ai_consume_logs_type_check CHECK (((type >= 0) AND (type <= 7)))
);

ALTER TABLE ONLY public.ai_consume_logs FORCE ROW LEVEL SECURITY;


--
-- Name: ai_consume_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ai_consume_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ai_consume_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ai_consume_logs_id_seq OWNED BY public.ai_consume_logs.id;


--
-- Name: ai_image_set_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_image_set_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    set_id uuid NOT NULL,
    org_id bigint NOT NULL,
    ordinal smallint NOT NULL,
    request_id bigint NOT NULL,
    object_id uuid,
    CONSTRAINT ai_image_set_items_ordinal_check CHECK (((ordinal >= 0) AND (ordinal <= 2)))
);

ALTER TABLE ONLY public.ai_image_set_items FORCE ROW LEVEL SECURITY;


--
-- Name: ai_image_sets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_image_sets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id bigint NOT NULL,
    user_id bigint NOT NULL,
    idempotency_key character varying(128) NOT NULL,
    input_sha256 text NOT NULL,
    source_sha256 text NOT NULL,
    model text NOT NULL,
    source_object_id uuid,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT ai_image_sets_input_sha256_check CHECK ((input_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT ai_image_sets_source_sha256_check CHECK ((source_sha256 ~ '^[0-9a-f]{64}$'::text))
);

ALTER TABLE ONLY public.ai_image_sets FORCE ROW LEVEL SECURITY;


--
-- Name: ai_price_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_price_schedules (
    id bigint NOT NULL,
    model character varying(128) NOT NULL,
    input_microfen_per_million bigint NOT NULL,
    cached_input_microfen_per_million bigint NOT NULL,
    output_microfen_per_million bigint NOT NULL,
    reasoning_microfen_per_million bigint NOT NULL,
    max_request_microfen bigint NOT NULL,
    effective_from timestamp with time zone NOT NULL,
    created_by_user_id bigint,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    billing_mode text DEFAULT 'token'::text NOT NULL,
    per_request_microfen bigint DEFAULT 0 NOT NULL,
    CONSTRAINT ai_price_schedules_billing_mode_shape CHECK ((((billing_mode = 'token'::text) AND (per_request_microfen = 0)) OR ((billing_mode = 'per_request'::text) AND (per_request_microfen > 0)))),
    CONSTRAINT ai_price_schedules_hold_positive CHECK ((max_request_microfen > 0)),
    CONSTRAINT ai_price_schedules_rates_nonneg CHECK (((input_microfen_per_million >= 0) AND (cached_input_microfen_per_million >= 0) AND (output_microfen_per_million >= 0) AND (reasoning_microfen_per_million >= 0)))
);


--
-- Name: ai_price_schedules_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ai_price_schedules_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ai_price_schedules_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ai_price_schedules_id_seq OWNED BY public.ai_price_schedules.id;


--
-- Name: ai_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_requests (
    id bigint NOT NULL,
    public_id character varying(64) NOT NULL,
    org_id bigint NOT NULL,
    user_id bigint NOT NULL,
    idempotency_key character varying(512) NOT NULL,
    model character varying(128) NOT NULL,
    upstream_account_id character varying(64) NOT NULL,
    status character varying(32) NOT NULL,
    price_schedule_id bigint,
    input_microfen_per_million bigint DEFAULT 0 NOT NULL,
    cached_input_microfen_per_million bigint DEFAULT 0 NOT NULL,
    output_microfen_per_million bigint DEFAULT 0 NOT NULL,
    reasoning_microfen_per_million bigint DEFAULT 0 NOT NULL,
    held_microfen bigint DEFAULT 0 NOT NULL,
    prompt_tokens bigint DEFAULT 0 NOT NULL,
    cached_prompt_tokens bigint DEFAULT 0 NOT NULL,
    completion_tokens bigint DEFAULT 0 NOT NULL,
    reasoning_completion_tokens bigint DEFAULT 0 NOT NULL,
    uncached_input_microfen bigint DEFAULT 0 NOT NULL,
    cached_input_microfen bigint DEFAULT 0 NOT NULL,
    output_microfen bigint DEFAULT 0 NOT NULL,
    reasoning_microfen bigint DEFAULT 0 NOT NULL,
    total_microfen bigint DEFAULT 0 NOT NULL,
    upstream_response_id character varying(128),
    error_class character varying(48),
    response_body jsonb,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    dispatched_at timestamp with time zone,
    settled_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    billing_mode text DEFAULT 'token'::text NOT NULL,
    per_request_microfen bigint DEFAULT 0 NOT NULL,
    operation character varying(32) DEFAULT 'ai_token'::character varying NOT NULL,
    thinking_depth character varying(16),
    channel_name character varying(80),
    api_format character varying(32),
    job_id uuid,
    input_fingerprint text,
    authorized_units bigint,
    binding_hash text,
    binding_status text,
    charged_microfen bigint DEFAULT 0 NOT NULL,
    absorbed_microfen bigint DEFAULT 0 NOT NULL,
    ocr_prompt jsonb,
    CONSTRAINT ai_requests_api_format_known CHECK (((api_format IS NULL) OR ((api_format)::text = ANY ((ARRAY['chat_completions'::character varying, 'responses'::character varying, 'anthropic_messages'::character varying, 'images_generations'::character varying])::text[])))),
    CONSTRAINT ai_requests_binding_status_known CHECK (((binding_status IS NULL) OR (binding_status = ANY (ARRAY['bound'::text, 'legacy_unverified'::text])))),
    CONSTRAINT ai_requests_channel_name_valid CHECK (((channel_name IS NULL) OR (((char_length((channel_name)::text) >= 1) AND (char_length((channel_name)::text) <= 80)) AND ((channel_name)::text = btrim((channel_name)::text))))),
    CONSTRAINT ai_requests_charged_split CHECK (((charged_microfen >= 0) AND (absorbed_microfen >= 0) AND ((charged_microfen + absorbed_microfen) = total_microfen))),
    CONSTRAINT ai_requests_charges_nonneg CHECK (((uncached_input_microfen >= 0) AND (cached_input_microfen >= 0) AND (output_microfen >= 0) AND (reasoning_microfen >= 0) AND (total_microfen >= 0))),
    CONSTRAINT ai_requests_hold_nonneg CHECK ((held_microfen >= 0)),
    CONSTRAINT ai_requests_operation_known CHECK (((operation)::text = ANY ((ARRAY['ai_token'::character varying, 'ocr'::character varying, 'image'::character varying])::text[]))),
    CONSTRAINT ai_requests_status_known CHECK (((status)::text = ANY ((ARRAY['held'::character varying, 'dispatching'::character varying, 'settled'::character varying, 'failed'::character varying, 'unbilled_unknown'::character varying])::text[]))),
    CONSTRAINT ai_requests_thinking_depth_known CHECK (((thinking_depth IS NULL) OR ((thinking_depth)::text = ANY ((ARRAY['low'::character varying, 'medium'::character varying, 'high'::character varying])::text[])))),
    CONSTRAINT ai_requests_tokens_nonneg CHECK (((prompt_tokens >= 0) AND (completion_tokens >= 0) AND (cached_prompt_tokens >= 0) AND (reasoning_completion_tokens >= 0))),
    CONSTRAINT ai_requests_total_is_sum CHECK ((((billing_mode = 'token'::text) AND (total_microfen = (((uncached_input_microfen + cached_input_microfen) + output_microfen) + reasoning_microfen))) OR ((billing_mode = 'per_request'::text) AND (uncached_input_microfen = 0) AND (cached_input_microfen = 0) AND (output_microfen = 0) AND (reasoning_microfen = 0) AND ((total_microfen = 0) OR (((per_request_microfen - total_microfen) >= 0) AND ((per_request_microfen - total_microfen) <= 1))))))
);

ALTER TABLE ONLY public.ai_requests FORCE ROW LEVEL SECURITY;


--
-- Name: ai_requests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ai_requests_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ai_requests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ai_requests_id_seq OWNED BY public.ai_requests.id;


--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_logs (
    id bigint NOT NULL,
    org_id bigint NOT NULL,
    user_id bigint NOT NULL,
    module character varying(64) NOT NULL,
    entity_type character varying(64) NOT NULL,
    entity_id character varying(128) NOT NULL,
    api_method character varying(16) NOT NULL,
    api_path character varying(512) NOT NULL,
    action character varying(64) NOT NULL,
    status character varying(64) NOT NULL,
    result character varying(64) NOT NULL,
    message text NOT NULL,
    shop_id bigint,
    created_at_ms bigint NOT NULL,
    created_at timestamp with time zone NOT NULL,
    actor_kind character varying(16) DEFAULT 'user'::character varying NOT NULL,
    support_grant_id bigint,
    writer_lease_id bigint,
    writer_fence_token bigint,
    CONSTRAINT audit_logs_actor_kind_known CHECK (((actor_kind)::text = ANY (ARRAY[('user'::character varying)::text, ('staff'::character varying)::text]))),
    CONSTRAINT audit_logs_staff_needs_grant CHECK ((((actor_kind)::text <> 'staff'::text) OR (support_grant_id IS NOT NULL)))
);


--
-- Name: audit_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.audit_logs ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.audit_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: auth_email_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_email_tokens (
    token_hash text NOT NULL,
    user_id bigint NOT NULL,
    purpose text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT ck_auth_email_tokens_purpose CHECK ((purpose = ANY (ARRAY['reset'::text, 'verify'::text])))
);


--
-- Name: auth_login_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_login_attempts (
    email_hash bytea NOT NULL,
    ip_hash bytea NOT NULL,
    failures integer DEFAULT 0 NOT NULL,
    window_start timestamp with time zone NOT NULL,
    next_allowed_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT ck_auth_login_attempts_email_hash CHECK ((octet_length(email_hash) = 32)),
    CONSTRAINT ck_auth_login_attempts_failures CHECK ((failures >= 0)),
    CONSTRAINT ck_auth_login_attempts_ip_hash CHECK ((octet_length(ip_hash) = 32))
);


--
-- Name: automation_asset_set_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.automation_asset_set_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    set_id uuid NOT NULL,
    item_kind character varying(16) NOT NULL,
    item_key character varying(160) NOT NULL,
    file_name character varying(240) NOT NULL,
    sha256 character varying(64) NOT NULL,
    size_bytes bigint DEFAULT 0 NOT NULL,
    runtime_id uuid,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT automation_asset_set_items_kind_known CHECK (((item_kind)::text = 'local_file'::text))
);

ALTER TABLE ONLY public.automation_asset_set_items FORCE ROW LEVEL SECURITY;


--
-- Name: automation_asset_sets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.automation_asset_sets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id bigint NOT NULL,
    user_id bigint NOT NULL,
    name character varying(120) NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

ALTER TABLE ONLY public.automation_asset_sets FORCE ROW LEVEL SECURITY;


--
-- Name: automation_call_receipts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.automation_call_receipts (
    grant_id uuid NOT NULL,
    execution_id uuid NOT NULL,
    call_id text NOT NULL,
    method text NOT NULL,
    args_digest text NOT NULL,
    outcome text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT automation_call_receipts_call_id CHECK (((length(call_id) >= 1) AND (length(call_id) <= 128))),
    CONSTRAINT automation_call_receipts_digest CHECK ((args_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT automation_call_receipts_metadata CHECK (((jsonb_typeof(metadata) = 'object'::text) AND (octet_length((metadata)::text) <= 16384))),
    CONSTRAINT automation_call_receipts_method CHECK (((length(method) >= 1) AND (length(method) <= 256))),
    CONSTRAINT automation_call_receipts_outcome CHECK ((((length(outcome) >= 1) AND (length(outcome) <= 64)) AND (outcome ~ '^[a-z0-9_]+$'::text)))
);

ALTER TABLE ONLY public.automation_call_receipts FORCE ROW LEVEL SECURITY;


--
-- Name: automation_executions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.automation_executions (
    grant_id uuid NOT NULL,
    execution_id uuid NOT NULL,
    input_digest text NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    lease_token uuid,
    lease_epoch bigint DEFAULT 1 NOT NULL,
    lease_deadline timestamp with time zone,
    calls integer DEFAULT 0 NOT NULL,
    error_code text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT automation_executions_calls CHECK ((calls >= 0)),
    CONSTRAINT automation_executions_digest CHECK ((input_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT automation_executions_error_code CHECK (((error_code IS NULL) OR (((length(error_code) >= 1) AND (length(error_code) <= 100)) AND (error_code ~ '^[a-z0-9_]+$'::text)))),
    CONSTRAINT automation_executions_lease CHECK (((lease_epoch >= 1) AND ((status <> 'running'::text) OR ((lease_token IS NOT NULL) AND (lease_deadline IS NOT NULL))))),
    CONSTRAINT automation_executions_status CHECK ((status = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text, 'cancelled'::text, 'interrupted'::text])))
);

ALTER TABLE ONLY public.automation_executions FORCE ROW LEVEL SECURITY;


--
-- Name: automation_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.automation_grants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id bigint NOT NULL,
    org_id bigint,
    name character varying(120) NOT NULL,
    token_hash character varying(128) NOT NULL,
    token_prefix character varying(24) NOT NULL,
    actions text[] NOT NULL,
    expires_at timestamp with time zone,
    revoked_at timestamp with time zone,
    last_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    scope_kind text DEFAULT 'workspace'::text NOT NULL,
    source_ids text[],
    CONSTRAINT automation_grants_actions_known CHECK (((cardinality(actions) > 0) AND (((scope_kind = 'workspace'::text) AND (actions <@ ARRAY['read'::text, 'prepare'::text, 'submit'::text, 'catalog:read'::text, 'cards:write'::text])) OR ((scope_kind = 'catalog'::text) AND (actions <@ ARRAY['catalog:read'::text])) OR ((scope_kind = 'supplier_catalog'::text) AND (actions <@ ARRAY['supplier:read'::text, 'supplier:write'::text, 'supplier:delete'::text, 'supplier:publish'::text, 'supplier:price'::text]))))),
    CONSTRAINT automation_grants_scope_shape CHECK ((((scope_kind = 'workspace'::text) AND (org_id IS NOT NULL) AND (org_id > 0) AND (source_ids IS NULL)) OR ((scope_kind = 'catalog'::text) AND (org_id IS NULL) AND (source_ids IS NULL)) OR ((scope_kind = 'supplier_catalog'::text) AND (org_id IS NULL)))),
    CONSTRAINT automation_grants_source_ids_shape CHECK (((source_ids IS NULL) OR ((cardinality(source_ids) <= 200) AND (array_position(source_ids, NULL::text) IS NULL) AND ((cardinality(source_ids) = 0) OR (array_ndims(source_ids) = 1)))))
);


--
-- Name: automation_runtimes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.automation_runtimes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id bigint NOT NULL,
    user_id bigint NOT NULL,
    grant_id uuid NOT NULL,
    label character varying(120) NOT NULL,
    renderer_contract character varying(64) NOT NULL,
    heartbeat_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    deregistered_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

ALTER TABLE ONLY public.automation_runtimes FORCE ROW LEVEL SECURITY;


--
-- Name: banned_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.banned_tags (
    id bigint NOT NULL,
    term text NOT NULL,
    match_mode text NOT NULL,
    note text DEFAULT ''::text NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    CONSTRAINT banned_tags_match_mode CHECK ((match_mode = ANY (ARRAY['exact'::text, 'stem'::text]))),
    CONSTRAINT banned_tags_term_nonempty CHECK ((length(btrim(term)) > 0))
);


--
-- Name: banned_tags_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.banned_tags ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.banned_tags_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: billable_usage_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billable_usage_events (
    id bigint NOT NULL,
    org_id bigint NOT NULL,
    user_id bigint NOT NULL,
    owner_uuid character varying(64) NOT NULL,
    event_id character varying(255) NOT NULL,
    metric character varying(64) NOT NULL,
    unit character varying(16) NOT NULL,
    quantity bigint NOT NULL,
    source character varying(64) NOT NULL,
    verification character varying(16) NOT NULL,
    provider character varying(64) DEFAULT ''::character varying NOT NULL,
    model character varying(128) DEFAULT ''::character varying NOT NULL,
    resource_id character varying(255) DEFAULT ''::character varying NOT NULL,
    billing_period character varying(7) NOT NULL,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at_ms bigint NOT NULL,
    created_at_ms bigint NOT NULL,
    CONSTRAINT billable_usage_period_format CHECK (((billing_period)::text ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'::text)),
    CONSTRAINT billable_usage_quantity_nonnegative CHECK ((quantity >= 0)),
    CONSTRAINT billable_usage_unit_known CHECK (((unit)::text = ANY (ARRAY[('token'::character varying)::text, ('byte'::character varying)::text]))),
    CONSTRAINT billable_usage_verification_known CHECK (((verification)::text = ANY (ARRAY[('observed'::character varying)::text, ('reported'::character varying)::text])))
);


--
-- Name: billable_usage_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.billable_usage_events ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.billable_usage_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: billable_usage_rollups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billable_usage_rollups (
    id bigint NOT NULL,
    org_id bigint NOT NULL,
    user_id bigint NOT NULL,
    billing_period character varying(7) NOT NULL,
    metric character varying(64) NOT NULL,
    unit character varying(16) NOT NULL,
    verification character varying(16) NOT NULL,
    total bigint DEFAULT 0 NOT NULL,
    updated_at_ms bigint DEFAULT 0 NOT NULL,
    CONSTRAINT billable_usage_rollup_total_nonnegative CHECK ((total >= 0)),
    CONSTRAINT billable_usage_rollup_verification_known CHECK (((verification)::text = ANY (ARRAY[('observed'::character varying)::text, ('reported'::character varying)::text])))
);


--
-- Name: billable_usage_rollups_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.billable_usage_rollups ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.billable_usage_rollups_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: billing_operations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_operations (
    id bigint NOT NULL,
    org_id bigint NOT NULL,
    idempotency_key character varying(128) NOT NULL,
    price_snapshot_version bigint NOT NULL,
    expected_upper_bound_microfen bigint NOT NULL,
    actual_microfen bigint,
    state character varying(32) DEFAULT 'created'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT billing_operations_actual_nonneg CHECK (((actual_microfen IS NULL) OR (actual_microfen >= 0))),
    CONSTRAINT billing_operations_expected_positive CHECK ((expected_upper_bound_microfen > 0)),
    CONSTRAINT billing_operations_state_known CHECK (((state)::text = ANY ((ARRAY['created'::character varying, 'reserved'::character varying, 'upstream_started'::character varying, 'settled'::character varying, 'released'::character varying, 'outcome_unknown'::character varying, 'reconciliation_settled'::character varying])::text[])))
);

ALTER TABLE ONLY public.billing_operations FORCE ROW LEVEL SECURITY;


--
-- Name: billing_operations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.billing_operations ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.billing_operations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: browser_commands; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.browser_commands (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id bigint NOT NULL,
    user_id bigint NOT NULL,
    grant_id uuid NOT NULL,
    client_request_id character varying(120) NOT NULL,
    action character varying(32) NOT NULL,
    payload jsonb NOT NULL,
    status character varying(16) DEFAULT 'queued'::character varying NOT NULL,
    claimed_by uuid,
    claim_epoch bigint DEFAULT 0 NOT NULL,
    claim_expires_at timestamp with time zone,
    progress jsonb,
    result jsonb,
    error jsonb,
    cancel_requested_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT browser_commands_action_known CHECK (((action)::text = ANY ((ARRAY['assets_import'::character varying, 'listing_prepare'::character varying])::text[]))),
    CONSTRAINT browser_commands_status_known CHECK (((status)::text = ANY ((ARRAY['queued'::character varying, 'claimed'::character varying, 'completed'::character varying, 'failed'::character varying, 'canceled'::character varying])::text[])))
);

ALTER TABLE ONLY public.browser_commands FORCE ROW LEVEL SECURITY;


--
-- Name: catalog_dictionary_search_material; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.catalog_dictionary_search_material (
    description_category_id bigint NOT NULL,
    type_id bigint NOT NULL,
    language text NOT NULL,
    attribute_id bigint NOT NULL,
    dictionary_id bigint NOT NULL,
    option_id bigint NOT NULL,
    value text NOT NULL,
    observed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT catalog_dictionary_search_material_check CHECK (((description_category_id > 0) AND (type_id > 0) AND (attribute_id > 0) AND (dictionary_id > 0) AND (option_id > 0))),
    CONSTRAINT catalog_dictionary_search_material_language_check CHECK ((language = ANY (ARRAY['default'::text, 'ru'::text, 'en'::text, 'tr'::text, 'zh_hans'::text]))),
    CONSTRAINT catalog_dictionary_search_material_value_check CHECK ((length(value) > 0))
);


--
-- Name: category_prompts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.category_prompts (
    id bigint NOT NULL,
    prompt_id text NOT NULL,
    description_category_id bigint NOT NULL,
    type_id bigint NOT NULL,
    name text NOT NULL,
    file_name text NOT NULL,
    content text NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    created_by_account_uuid text NOT NULL,
    fixed_tags jsonb DEFAULT '[]'::jsonb NOT NULL
);


--
-- Name: category_prompts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.category_prompts ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.category_prompts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: category_videos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.category_videos (
    id bigint NOT NULL,
    video_id text NOT NULL,
    description_category_id bigint NOT NULL,
    type_id bigint NOT NULL,
    name text NOT NULL,
    video_url text NOT NULL,
    duration_ms bigint NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    created_by_account_uuid text NOT NULL,
    CONSTRAINT ck_category_videos_duration CHECK ((duration_ms > 0))
);


--
-- Name: category_videos_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.category_videos ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.category_videos_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: client_listing_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_listing_logs (
    id bigint NOT NULL,
    org_id bigint NOT NULL,
    user_id bigint NOT NULL,
    client_id text NOT NULL,
    session_id text NOT NULL,
    version text NOT NULL,
    logged_at timestamp with time zone NOT NULL,
    received_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    level text NOT NULL,
    module text NOT NULL,
    event text NOT NULL,
    duration_ms integer,
    batch_id text,
    row_id text,
    offer_id text,
    intent_id text,
    job_id text,
    psd_id text,
    error_code text,
    error_message text,
    fields jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT client_listing_logs_duration CHECK (((duration_ms IS NULL) OR (duration_ms >= 0))),
    CONSTRAINT client_listing_logs_fields_object CHECK ((jsonb_typeof(fields) = 'object'::text)),
    CONSTRAINT client_listing_logs_level CHECK ((level = ANY (ARRAY['debug'::text, 'info'::text, 'warn'::text, 'error'::text])))
);

ALTER TABLE ONLY public.client_listing_logs FORCE ROW LEVEL SECURITY;


--
-- Name: client_listing_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.client_listing_logs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.client_listing_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: console_store_metrics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.console_store_metrics (
    org_id bigint NOT NULL,
    store_id uuid NOT NULL,
    refresh_generation bigint NOT NULL,
    ordered_units_30d double precision,
    previous_ordered_units_30d double precision,
    day_series_14d double precision[],
    through_day text,
    last_sync_at_ms bigint,
    last_error text,
    retry_at_ms bigint,
    CONSTRAINT console_store_metrics_generation CHECK ((refresh_generation > 0)),
    CONSTRAINT console_store_metrics_previous_shape CHECK (((previous_ordered_units_30d IS NULL) OR ((previous_ordered_units_30d >= (0)::double precision) AND (ordered_units_30d IS NOT NULL)))),
    CONSTRAINT console_store_metrics_retry_shape CHECK (((retry_at_ms IS NULL) OR ((retry_at_ms > 0) AND (last_error IS NOT NULL)))),
    CONSTRAINT console_store_metrics_snapshot_shape CHECK ((((ordered_units_30d IS NULL) AND (day_series_14d IS NULL) AND (through_day IS NULL) AND (last_sync_at_ms IS NULL)) OR ((ordered_units_30d >= (0)::double precision) AND (array_length(day_series_14d, 1) = 14) AND (through_day <> ''::text) AND (last_sync_at_ms > 0))))
);

ALTER TABLE ONLY public.console_store_metrics FORCE ROW LEVEL SECURITY;


--
-- Name: delegate_assets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.delegate_assets (
    asset_id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id bigint NOT NULL,
    binding_id uuid NOT NULL,
    object_key text NOT NULL,
    object_url text DEFAULT ''::text NOT NULL,
    sha256 text NOT NULL,
    bytes bigint NOT NULL,
    mime text NOT NULL,
    file_name text NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    verified_at_ms bigint,
    created_at_ms bigint NOT NULL,
    CONSTRAINT ck_delegate_assets_bytes CHECK ((bytes > 0)),
    CONSTRAINT ck_delegate_assets_sha256 CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text))
);

ALTER TABLE ONLY public.delegate_assets FORCE ROW LEVEL SECURITY;


--
-- Name: delegate_bindings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.delegate_bindings (
    binding_id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id bigint NOT NULL,
    store_id uuid NOT NULL,
    offer_id text NOT NULL,
    source_id text NOT NULL,
    note text DEFAULT ''::text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    created_by bigint NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT ck_delegate_bindings_offer_id CHECK ((offer_id = NULLIF(btrim(offer_id), ''::text))),
    CONSTRAINT ck_delegate_bindings_revision CHECK ((revision >= 1))
);

ALTER TABLE ONLY public.delegate_bindings FORCE ROW LEVEL SECURITY;


--
-- Name: delegate_dispatch_assets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.delegate_dispatch_assets (
    dispatch_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    org_id bigint NOT NULL
);

ALTER TABLE ONLY public.delegate_dispatch_assets FORCE ROW LEVEL SECURITY;


--
-- Name: delegate_dispatches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.delegate_dispatches (
    dispatch_id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id bigint NOT NULL,
    order_id uuid NOT NULL,
    source_id text NOT NULL,
    dispatch_no text NOT NULL,
    payload jsonb NOT NULL,
    state text DEFAULT 'dispatched'::text NOT NULL,
    receipt jsonb,
    attempted_by text DEFAULT 'auto'::text NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    nudge_count integer DEFAULT 0 NOT NULL,
    nudged_at_ms bigint,
    fulfiller_id uuid,
    CONSTRAINT ck_delegate_dispatches_nudge_nonneg CHECK ((nudge_count >= 0)),
    CONSTRAINT ck_delegate_dispatches_state CHECK ((state = ANY (ARRAY['dispatched'::text, 'accepted'::text, 'shipped'::text, 'rejected'::text, 'cancelled'::text])))
);

ALTER TABLE ONLY public.delegate_dispatches FORCE ROW LEVEL SECURITY;


--
-- Name: delegate_order_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.delegate_order_lines (
    line_id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id bigint NOT NULL,
    order_id uuid NOT NULL,
    offer_id text NOT NULL,
    sku bigint DEFAULT 0 NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    quantity integer NOT NULL,
    binding_id uuid,
    last_rejected_source_id text,
    last_rejected_fulfiller_id uuid,
    CONSTRAINT ck_delegate_order_lines_quantity CHECK ((quantity >= 1))
);

ALTER TABLE ONLY public.delegate_order_lines FORCE ROW LEVEL SECURITY;


--
-- Name: delegate_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.delegate_orders (
    order_id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id bigint NOT NULL,
    store_id uuid NOT NULL,
    posting_number text NOT NULL,
    seller_note text DEFAULT ''::text NOT NULL,
    posting_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    logistics jsonb,
    amount_snapshot jsonb,
    cancel_requested boolean DEFAULT false NOT NULL,
    state text NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    dispatch_blocked_reason text,
    CONSTRAINT ck_delegate_orders_blocked_reason CHECK (((dispatch_blocked_reason IS NULL) OR (dispatch_blocked_reason = ANY (ARRAY['no_fulfiller'::text, 'ambiguous_fulfiller'::text])))),
    CONSTRAINT ck_delegate_orders_state CHECK ((state = ANY (ARRAY['awaiting_setup'::text, 'ready'::text, 'dispatched'::text, 'in_production'::text, 'shipped'::text, 'done'::text, 'cancelled'::text])))
);

ALTER TABLE ONLY public.delegate_orders FORCE ROW LEVEL SECURITY;


--
-- Name: delegate_settlements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.delegate_settlements (
    settlement_id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id bigint NOT NULL,
    order_id uuid NOT NULL,
    dispatch_id uuid NOT NULL,
    source_id text NOT NULL,
    amount_cents bigint NOT NULL,
    amount_microfen bigint NOT NULL,
    state text NOT NULL,
    breakdown jsonb NOT NULL,
    held_at_ms bigint NOT NULL,
    settled_at_ms bigint,
    released_at_ms bigint,
    CONSTRAINT ck_delegate_settlements_amount CHECK (((amount_cents > 0) AND (amount_microfen = (amount_cents * 1000000)))),
    CONSTRAINT ck_delegate_settlements_state CHECK ((state = ANY (ARRAY['held'::text, 'settled'::text, 'released'::text])))
);

ALTER TABLE ONLY public.delegate_settlements FORCE ROW LEVEL SECURITY;


--
-- Name: error_digest; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.error_digest (
    id bigint NOT NULL,
    org_id bigint,
    fingerprint text NOT NULL,
    route_template text NOT NULL,
    status_code integer NOT NULL,
    event_count bigint NOT NULL,
    first_at timestamp with time zone NOT NULL,
    last_at timestamp with time zone NOT NULL,
    summary text NOT NULL,
    window_start timestamp with time zone NOT NULL,
    CONSTRAINT error_digest_count CHECK ((event_count > 0)),
    CONSTRAINT error_digest_fingerprint_hex CHECK ((fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT error_digest_org CHECK (((org_id IS NULL) OR (org_id > 0))),
    CONSTRAINT error_digest_route_clean CHECK ((((char_length(route_template) >= 1) AND (char_length(route_template) <= 160)) AND (route_template !~* '(sk-|bearer|api[_-]?key|signature=|x-amz-|@)'::text))),
    CONSTRAINT error_digest_span CHECK ((first_at <= last_at)),
    CONSTRAINT error_digest_status CHECK (((status_code = 0) OR ((status_code >= 100) AND (status_code <= 599)))),
    CONSTRAINT error_digest_summary_clean CHECK ((((char_length(summary) >= 1) AND (char_length(summary) <= 80)) AND (summary !~* '(sk-|bearer|api[_-]?key|signature=|x-amz-|@)'::text) AND (summary !~ '[0-9]{13}'::text)))
);

ALTER TABLE ONLY public.error_digest FORCE ROW LEVEL SECURITY;


--
-- Name: error_digest_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.error_digest_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: error_digest_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.error_digest_id_seq OWNED BY public.error_digest.id;


--
-- Name: event_inbox_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_inbox_events (
    device_uid character varying(128) NOT NULL,
    id character varying(128) NOT NULL,
    org_id bigint NOT NULL,
    user_id bigint NOT NULL,
    kind character varying(128) NOT NULL,
    payload_json text NOT NULL,
    client_created_at character varying(64) NOT NULL,
    schema_version integer DEFAULT 1 NOT NULL,
    received_at timestamp with time zone NOT NULL
);


--
-- Name: execution_fairness; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.execution_fairness (
    class text NOT NULL,
    user_id bigint NOT NULL,
    request_until timestamp with time zone NOT NULL,
    CONSTRAINT execution_fairness_user_id_check CHECK ((user_id > 0))
);


--
-- Name: execution_fairness_cursor; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.execution_fairness_cursor (
    class text NOT NULL,
    last_user_id bigint DEFAULT 0 NOT NULL
);


--
-- Name: execution_permits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.execution_permits (
    holder_kind text NOT NULL,
    holder_id text NOT NULL,
    lease_epoch bigint NOT NULL,
    class text NOT NULL,
    org_id bigint NOT NULL,
    released_at timestamp with time zone,
    expires_at timestamp with time zone,
    user_id bigint,
    CONSTRAINT execution_permits_class_known CHECK ((class = ANY (ARRAY['ai_ocr'::text, 'cloud_upload'::text, 'all_execution'::text, 'verify'::text]))),
    CONSTRAINT execution_permits_holder_known CHECK ((holder_kind = ANY (ARRAY['job'::text, 'ocr'::text, 'upload_unit'::text, 'verify'::text]))),
    CONSTRAINT execution_permits_live_user CHECK (((released_at IS NOT NULL) OR ((user_id > 0) AND (user_id IS NOT NULL))))
);

ALTER TABLE ONLY public.execution_permits FORCE ROW LEVEL SECURITY;


--
-- Name: execution_quota; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.execution_quota (
    class text NOT NULL,
    user_id bigint NOT NULL,
    used bigint DEFAULT 0 NOT NULL,
    hard_limit bigint NOT NULL,
    CONSTRAINT execution_quota_class_known CHECK ((class = ANY (ARRAY['ai_ocr'::text, 'cloud_upload'::text, 'all_execution'::text, 'verify'::text]))),
    CONSTRAINT execution_quota_limit_pos CHECK ((hard_limit >= 0)),
    CONSTRAINT execution_quota_used_nonneg CHECK ((used >= 0))
);


--
-- Name: jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jobs (
    id uuid NOT NULL,
    org_id bigint NOT NULL,
    kind text NOT NULL,
    aggregate_type text NOT NULL,
    aggregate_id uuid NOT NULL,
    input_revision bigint NOT NULL,
    idempotency_key text NOT NULL,
    priority smallint DEFAULT 100 NOT NULL,
    state text NOT NULL,
    run_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    attempt integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 8 NOT NULL,
    lease_owner text,
    lease_until timestamp with time zone,
    payload jsonb NOT NULL,
    result_ref jsonb,
    trace_id text,
    cancel_requested_at timestamp with time zone,
    last_error_code text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    lease_epoch bigint DEFAULT 0 NOT NULL,
    cost_units integer DEFAULT 1 NOT NULL,
    lane text NOT NULL,
    input_fingerprint text,
    submitter_user_id bigint NOT NULL,
    executor text GENERATED ALWAYS AS (COALESCE((payload ->> 'executor'::text), ''::text)) STORED,
    command_id text,
    store_id uuid,
    member_id bigint,
    CONSTRAINT jobs_active_submitter CHECK (((submitter_user_id > 0) OR (state <> ALL (ARRAY['queued'::text, 'retry_wait'::text, 'running'::text, 'uncertain'::text])))),
    CONSTRAINT jobs_attempt_nonneg CHECK ((attempt >= 0)),
    CONSTRAINT jobs_cost_units_pos CHECK ((cost_units > 0)),
    CONSTRAINT jobs_lane_nonempty CHECK ((lane <> ''::text)),
    CONSTRAINT jobs_max_attempts_pos CHECK ((max_attempts > 0)),
    CONSTRAINT jobs_state_known CHECK ((state = ANY (ARRAY['queued'::text, 'running'::text, 'retry_wait'::text, 'uncertain'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text])))
)
WITH (autovacuum_vacuum_scale_factor='0.02', autovacuum_vacuum_threshold='1000', autovacuum_analyze_scale_factor='0.02', autovacuum_analyze_threshold='1000');

ALTER TABLE ONLY public.jobs FORCE ROW LEVEL SECURITY;


--
-- Name: COLUMN jobs.store_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.jobs.store_id IS 'Store the job writes through, when it has one. NULL blocks no store during a drain.';


--
-- Name: COLUMN jobs.member_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.jobs.member_id IS 'Member who submitted the work, when known. NULL blocks no member during a drain.';


--
-- Name: lease_budget; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lease_budget (
    namespace text NOT NULL,
    scope text NOT NULL,
    next_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL
);


--
-- Name: lease_slot; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lease_slot (
    namespace text NOT NULL,
    scope text NOT NULL,
    token bytea NOT NULL,
    expires_at timestamp with time zone NOT NULL
);


--
-- Name: lease_window; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lease_window (
    namespace text NOT NULL,
    scope text NOT NULL,
    window_start timestamp with time zone NOT NULL,
    count bigint NOT NULL,
    expires_at timestamp with time zone NOT NULL
);


--
-- Name: listing_card_cursors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.listing_card_cursors (
    org_id bigint NOT NULL,
    card_id uuid NOT NULL,
    seq bigint DEFAULT 0 NOT NULL,
    CONSTRAINT listing_card_cursors_seq_check CHECK ((seq >= 0))
);

ALTER TABLE ONLY public.listing_card_cursors FORCE ROW LEVEL SECURITY;


--
-- Name: listing_cards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.listing_cards (
    id uuid NOT NULL,
    org_id bigint NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    store_id uuid,
    revision bigint DEFAULT 1 NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by bigint,
    updated_by bigint,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    supplier_product_id text GENERATED ALWAYS AS (NULLIF(btrim((payload ->> 'supplierProductId'::text)), ''::text)) STORED,
    CONSTRAINT listing_cards_revision_pos CHECK ((revision >= 1))
);

ALTER TABLE ONLY public.listing_cards FORCE ROW LEVEL SECURITY;


--
-- Name: ozon_listing_field_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ozon_listing_field_templates (
    id bigint NOT NULL,
    org_id bigint NOT NULL,
    name character varying(255) NOT NULL,
    category_id character varying(128) NOT NULL,
    status character varying(32) DEFAULT 'draft'::character varying NOT NULL,
    defaults_json text DEFAULT '{}'::text NOT NULL,
    dataset_json text DEFAULT '[]'::text NOT NULL,
    scope character varying(24) DEFAULT 'org'::character varying NOT NULL,
    published_at bigint DEFAULT 0 NOT NULL,
    clone_of_id bigint DEFAULT 0 NOT NULL,
    created_at_ms bigint DEFAULT 0 NOT NULL,
    updated_at_ms bigint DEFAULT 0 NOT NULL,
    schema_snapshot_id bigint,
    CONSTRAINT ozon_official_recipe_has_schema CHECK ((((scope)::text <> 'official'::text) OR (schema_snapshot_id IS NOT NULL)))
);


--
-- Name: listing_field_templates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.ozon_listing_field_templates ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.listing_field_templates_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: listing_row_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.listing_row_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id bigint NOT NULL,
    stream_card_id uuid NOT NULL,
    stream_seq bigint,
    stream_txid bigint NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

ALTER TABLE ONLY public.listing_row_events FORCE ROW LEVEL SECURITY;


--
-- Name: listing_rows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.listing_rows (
    id uuid NOT NULL,
    org_id bigint NOT NULL,
    card_id uuid NOT NULL,
    store_id uuid,
    revision bigint DEFAULT 1 NOT NULL,
    content_state text DEFAULT 'draft'::text NOT NULL,
    media_state text DEFAULT 'pending'::text NOT NULL,
    validation_state text DEFAULT 'stale'::text NOT NULL,
    submission_state text DEFAULT 'none'::text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    schema_revision text,
    created_by bigint,
    updated_by bigint,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    category_key text GENERATED ALWAYS AS ((payload ->> 'categoryKey'::text)) STORED,
    view_revision bigint DEFAULT 1 NOT NULL,
    queue_position bigint GENERATED ALWAYS AS (COALESCE(
CASE
    WHEN ((jsonb_typeof((payload -> 'queuePosition'::text)) = 'number'::text) AND ((payload ->> 'queuePosition'::text) ~ '^-?[0-9]{1,19}$'::text) AND (((payload ->> 'queuePosition'::text) !~ '^-?[0-9]{19}$'::text) OR ((payload ->> 'queuePosition'::text) ~ '^-?[0-8][0-9]{18}$'::text))) THEN ((payload ->> 'queuePosition'::text))::bigint
    ELSE NULL::bigint
END, '9223372036854775807'::bigint)) STORED,
    build_state text DEFAULT 'stale'::text NOT NULL,
    build_digest text,
    build_card_digest text,
    build_sources jsonb DEFAULT '[]'::jsonb NOT NULL,
    create_key text,
    create_fingerprint text,
    association_id uuid,
    model_value text DEFAULT ''::text NOT NULL,
    CONSTRAINT listing_rows_build_state_known CHECK ((build_state = ANY (ARRAY['stale'::text, 'built'::text]))),
    CONSTRAINT listing_rows_content_state_known CHECK ((content_state = ANY (ARRAY['draft'::text, 'recognizing'::text, 'ready'::text, 'failed'::text]))),
    CONSTRAINT listing_rows_media_state_known CHECK ((media_state = ANY (ARRAY['pending'::text, 'processing'::text, 'rendered'::text, 'uploading'::text, 'ready'::text, 'failed'::text]))),
    CONSTRAINT listing_rows_revision_pos CHECK ((revision >= 1)),
    CONSTRAINT listing_rows_submission_state_known CHECK ((submission_state = ANY (ARRAY['none'::text, 'queued'::text, 'submitting'::text, 'unknown'::text, 'accepted'::text, 'rejected'::text, 'cancelled'::text]))),
    CONSTRAINT listing_rows_validation_state_known CHECK ((validation_state = ANY (ARRAY['stale'::text, 'blocked'::text, 'passed'::text])))
);

ALTER TABLE ONLY public.listing_rows FORCE ROW LEVEL SECURITY;


--
-- Name: listing_schema_revisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.listing_schema_revisions (
    schema_revision text NOT NULL,
    snapshot jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT listing_schema_revisions_revision_nonempty CHECK (((char_length(schema_revision) >= 1) AND (char_length(schema_revision) <= 256)))
);


--
-- Name: ozon_listing_schema_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ozon_listing_schema_snapshots (
    id bigint NOT NULL,
    org_id bigint NOT NULL,
    category_id character varying(128) NOT NULL,
    label character varying(512) DEFAULT ''::character varying NOT NULL,
    version character varying(64) DEFAULT ''::character varying NOT NULL,
    field_count bigint DEFAULT 0 NOT NULL,
    dict_count bigint DEFAULT 0 NOT NULL,
    columns_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    prev_version character varying(64) DEFAULT ''::character varying NOT NULL,
    dictionaries_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    sort_order bigint DEFAULT 0 NOT NULL,
    last_synced_at_ms bigint DEFAULT 0 NOT NULL,
    updated_at_ms bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: listing_schema_snapshots_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.ozon_listing_schema_snapshots ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.listing_schema_snapshots_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: media_bindings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_bindings (
    id uuid NOT NULL,
    org_id bigint NOT NULL,
    asset_id uuid NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    purpose text NOT NULL,
    pinned_revision bigint NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    released_at timestamp with time zone,
    CONSTRAINT media_bindings_pinned_pos CHECK ((pinned_revision >= 1))
);

ALTER TABLE ONLY public.media_bindings FORCE ROW LEVEL SECURITY;


--
-- Name: media_blobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_blobs (
    id uuid NOT NULL,
    org_id bigint NOT NULL,
    sha256 text NOT NULL,
    size_bytes bigint NOT NULL,
    mime text NOT NULL,
    storage_key text NOT NULL,
    state text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT media_blobs_sha256_shape CHECK (((length(sha256) = 64) AND (sha256 ~ '^[0-9a-f]+$'::text))),
    CONSTRAINT media_blobs_size_nonneg CHECK ((size_bytes >= 0)),
    CONSTRAINT media_blobs_state_known CHECK ((state = ANY (ARRAY['uploading'::text, 'verified'::text, 'quarantined'::text, 'gc_pending'::text, 'deleted'::text])))
);

ALTER TABLE ONLY public.media_blobs FORCE ROW LEVEL SECURITY;


--
-- Name: media_lib_assets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_lib_assets (
    id uuid NOT NULL,
    org_id bigint NOT NULL,
    blob_id uuid NOT NULL,
    kind text NOT NULL,
    display_name text DEFAULT ''::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    created_by bigint,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT media_lib_assets_kind_known CHECK ((kind = ANY (ARRAY['image'::text, 'video'::text, 'document'::text, 'other'::text]))),
    CONSTRAINT media_lib_assets_status_known CHECK ((status = ANY (ARRAY['ready'::text, 'processing'::text, 'failed'::text, 'deleted'::text]))),
    CONSTRAINT media_lib_assets_version_pos CHECK ((version >= 1))
);

ALTER TABLE ONLY public.media_lib_assets FORCE ROW LEVEL SECURITY;


--
-- Name: media_object_leases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_object_leases (
    workspace_uuid uuid NOT NULL,
    content_hash character varying(64) NOT NULL,
    org_id bigint NOT NULL,
    object_key text NOT NULL,
    media_account_id character varying(128) NOT NULL,
    first_seen_at timestamp with time zone NOT NULL,
    last_hit_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone,
    gc_claim_token uuid,
    gc_claimed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    public_ready_at timestamp with time zone,
    public_url text,
    verification_status text DEFAULT 'pending'::text NOT NULL,
    verified_at timestamp with time zone,
    verified_byte_length bigint,
    verified_width integer,
    verified_height integer,
    storage_revision bigint DEFAULT 0 NOT NULL,
    batch_id text DEFAULT ''::text NOT NULL,
    retired_at timestamp with time zone,
    CONSTRAINT ck_media_object_leases_gc_claim CHECK (((gc_claim_token IS NULL) = (gc_claimed_at IS NULL))),
    CONSTRAINT ck_media_object_leases_hash CHECK (((content_hash)::text ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT ck_media_object_leases_key CHECK ((length(btrim(object_key)) > 0)),
    CONSTRAINT media_object_leases_deleted_retired CHECK (((NOT public.is_media_gc_image_key(object_key)) OR (deleted_at IS NULL) OR (retired_at IS NOT NULL))),
    CONSTRAINT media_object_leases_storage_revision_nonnegative CHECK ((storage_revision >= 0)),
    CONSTRAINT media_object_leases_verification_status_known CHECK ((verification_status = ANY (ARRAY['pending'::text, 'metadata_confirmed'::text, 'verified'::text, 'rejected'::text])))
);


--
-- Name: media_uploads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_uploads (
    id uuid NOT NULL,
    org_id bigint NOT NULL,
    idempotency_key text NOT NULL,
    expected_sha256 text NOT NULL,
    expected_size bigint NOT NULL,
    expected_mime text NOT NULL,
    storage_key text NOT NULL,
    state text NOT NULL,
    blob_id uuid,
    asset_id uuid,
    created_by bigint,
    expires_at timestamp with time zone NOT NULL,
    finalized_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT media_uploads_sha_shape CHECK (((length(expected_sha256) = 64) AND (expected_sha256 ~ '^[0-9a-f]+$'::text))),
    CONSTRAINT media_uploads_size_nonneg CHECK ((expected_size >= 0)),
    CONSTRAINT media_uploads_state_known CHECK ((state = ANY (ARRAY['pending'::text, 'finalized'::text, 'expired'::text, 'aborted'::text])))
);

ALTER TABLE ONLY public.media_uploads FORCE ROW LEVEL SECURITY;


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id bigint NOT NULL,
    uuid uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id bigint NOT NULL,
    kind character varying(64) NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    invitation_id bigint,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    read_at timestamp with time zone,
    dismissed_at timestamp with time zone,
    CONSTRAINT ck_notifications_kind CHECK (((kind)::text = ANY (ARRAY['team_invitation'::text, 'agent_commission_credited'::text, 'agent_withdrawal_paid'::text, 'agent_withdrawal_rejected'::text, 'delegate_order_event'::text, 'store_rating_worsened'::text])))
);


--
-- Name: notifications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.notifications ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.notifications_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: org_invitations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_invitations (
    id bigint NOT NULL,
    org_id bigint NOT NULL,
    email character varying(320) NOT NULL,
    role character varying(32) DEFAULT 'member'::character varying NOT NULL,
    token_hash character varying(128),
    invited_by_user_id bigint NOT NULL,
    invited_by_email character varying(320) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    accepted_at timestamp with time zone,
    accepted_user_id bigint,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    uuid uuid DEFAULT gen_random_uuid() NOT NULL,
    invitee_user_id bigint,
    declined_at timestamp with time zone
);


--
-- Name: org_invitations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.org_invitations ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.org_invitations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: organization_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organization_members (
    id bigint NOT NULL,
    org_id bigint NOT NULL,
    user_id bigint NOT NULL,
    role character varying(32) DEFAULT 'owner'::character varying NOT NULL,
    status character varying(32) DEFAULT 'active'::character varying NOT NULL,
    display_name character varying(255) NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    join_order bigint NOT NULL,
    manual_disabled boolean DEFAULT false NOT NULL,
    quota_suspended boolean DEFAULT false NOT NULL,
    CONSTRAINT ck_organization_members_join_order CHECK ((join_order >= 1)),
    CONSTRAINT ck_organization_members_owner_protected CHECK ((((role)::text <> 'owner'::text) OR ((NOT manual_disabled) AND (NOT quota_suspended)))),
    CONSTRAINT ck_organization_members_role CHECK (((role)::text = ANY (ARRAY[('owner'::character varying)::text, ('manager'::character varying)::text, ('member'::character varying)::text]))),
    CONSTRAINT ck_organization_members_status CHECK (((status)::text = 'active'::text))
);


--
-- Name: organization_members_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.organization_members ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.organization_members_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: organization_store_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organization_store_groups (
    id bigint NOT NULL,
    org_id bigint NOT NULL,
    uuid uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(64) NOT NULL,
    name_key character varying(64) GENERATED ALWAYS AS (lower(btrim((name)::text))) STORED,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT ck_organization_store_groups_name CHECK ((length(btrim((name)::text)) > 0))
);


--
-- Name: organization_store_groups_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.organization_store_groups ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.organization_store_groups_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: organization_store_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organization_store_tags (
    id bigint NOT NULL,
    org_id bigint NOT NULL,
    uuid uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(64) NOT NULL,
    name_key character varying(64) GENERATED ALWAYS AS (lower(btrim((name)::text))) STORED,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT ck_organization_store_tags_name CHECK ((length(btrim((name)::text)) > 0))
);


--
-- Name: organization_store_tags_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.organization_store_tags ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.organization_store_tags_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: organization_stores; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organization_stores (
    id bigint NOT NULL,
    org_id bigint NOT NULL,
    uuid uuid DEFAULT gen_random_uuid() NOT NULL,
    create_order bigint NOT NULL,
    name character varying(255) NOT NULL,
    client_id character varying(128),
    manual_disabled boolean DEFAULT false NOT NULL,
    quota_suspended boolean DEFAULT false NOT NULL,
    credential_revision bigint DEFAULT 1 NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    deleted_at_ms bigint,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    assignee_membership_id bigint,
    assignee_key_read boolean DEFAULT false NOT NULL,
    assignee_key_write boolean DEFAULT false NOT NULL,
    assignee_key_edit boolean DEFAULT false NOT NULL,
    assignee_key_manage boolean DEFAULT false NOT NULL,
    product_quota jsonb,
    group_id bigint,
    finance_balance jsonb,
    company_short_name character varying(255),
    company_legal_name character varying(512),
    name_source character varying(16) DEFAULT 'auto'::character varying NOT NULL,
    company_currency character varying(8),
    company_country character varying(8),
    subscription_is_premium boolean,
    subscription_type character varying(32),
    seller_info_synced_at timestamp with time zone,
    seller_key_status character varying(16) DEFAULT 'unknown'::character varying NOT NULL,
    seller_key_reason character varying(16),
    CONSTRAINT ck_organization_stores_create_order CHECK ((create_order >= 1)),
    CONSTRAINT ck_organization_stores_credential_revision CHECK ((credential_revision >= 1)),
    CONSTRAINT ck_organization_stores_name CHECK ((length(btrim((name)::text)) > 0)),
    CONSTRAINT ck_organization_stores_name_source CHECK (((name_source)::text = ANY ((ARRAY['auto'::character varying, 'manual'::character varying])::text[]))),
    CONSTRAINT ck_organization_stores_revision CHECK ((revision >= 1)),
    CONSTRAINT ck_organization_stores_seller_key_reason CHECK (((seller_key_reason IS NULL) OR ((seller_key_reason)::text = ANY ((ARRAY['401'::character varying, '403'::character varying, '404'::character varying, 'network'::character varying, 'upstream'::character varying, 'unparsed'::character varying])::text[])))),
    CONSTRAINT ck_organization_stores_seller_key_status CHECK (((seller_key_status)::text = ANY ((ARRAY['valid'::character varying, 'invalid'::character varying, 'unknown'::character varying])::text[])))
);


--
-- Name: organization_stores_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.organization_stores ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.organization_stores_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: organizations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organizations (
    id bigint NOT NULL,
    owner_user_id bigint NOT NULL,
    name character varying(255) NOT NULL,
    plan character varying(32) DEFAULT 'free'::character varying NOT NULL,
    psd_upload_enabled boolean DEFAULT false NOT NULL,
    plan_expires_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    uuid uuid DEFAULT gen_random_uuid() NOT NULL,
    quota_revision bigint DEFAULT 1 NOT NULL,
    store_limit_override bigint,
    avatar_bytes bytea,
    avatar_updated_at_ms bigint,
    dissolved_at timestamp with time zone,
    member_seat_limit_override bigint,
    store_limit bigint DEFAULT 1 NOT NULL,
    CONSTRAINT ck_organizations_member_seat_limit_override CHECK (((member_seat_limit_override IS NULL) OR ((member_seat_limit_override >= 1) AND (member_seat_limit_override <= 10)))),
    CONSTRAINT ck_organizations_quota_revision CHECK ((quota_revision >= 1)),
    CONSTRAINT ck_organizations_store_limit_override CHECK (((store_limit_override IS NULL) OR (store_limit_override >= 1))),
    CONSTRAINT organizations_store_limit_check CHECK ((store_limit >= 0))
);


--
-- Name: organizations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.organizations ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.organizations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: ozon_catalog_schema_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ozon_catalog_schema_cache (
    description_category_id bigint NOT NULL,
    type_id bigint NOT NULL,
    language text NOT NULL,
    payload bytea NOT NULL,
    fetched_at_ms bigint NOT NULL,
    byte_size bigint NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);


--
-- Name: ozon_catalog_tree_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ozon_catalog_tree_cache (
    language text NOT NULL,
    payload bytea NOT NULL,
    fetched_at_ms bigint NOT NULL,
    byte_size bigint NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);


--
-- Name: ozon_category_current; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ozon_category_current (
    description_category_id bigint NOT NULL,
    type_id bigint NOT NULL,
    language character varying(16) NOT NULL,
    fields jsonb NOT NULL,
    content_digest character varying(71) NOT NULL,
    fetched_at_ms bigint NOT NULL,
    refresh_status character varying(16) DEFAULT 'complete'::character varying NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT ozon_category_current_coordinate_positive CHECK (((description_category_id > 0) AND (type_id > 0))),
    CONSTRAINT ozon_category_current_digest_shape CHECK (((content_digest)::text ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT ozon_category_current_fields_array CHECK ((jsonb_typeof(fields) = 'array'::text)),
    CONSTRAINT ozon_category_current_language_known CHECK (((language)::text = ANY ((ARRAY['default'::character varying, 'ru'::character varying, 'en'::character varying, 'tr'::character varying, 'zh_hans'::character varying])::text[]))),
    CONSTRAINT ozon_category_current_refresh_complete CHECK (((refresh_status)::text = 'complete'::text))
);


--
-- Name: ozon_delivery_methods; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ozon_delivery_methods (
    org_id bigint NOT NULL,
    store_id uuid NOT NULL,
    method_id bigint NOT NULL,
    warehouse_id bigint NOT NULL,
    name text NOT NULL,
    provider_id text DEFAULT ''::text NOT NULL,
    template_id text DEFAULT ''::text NOT NULL,
    cutoff text DEFAULT ''::text NOT NULL,
    sla_cut_in text DEFAULT ''::text NOT NULL,
    status text DEFAULT ''::text NOT NULL,
    created_at text DEFAULT ''::text NOT NULL,
    updated_at text DEFAULT ''::text NOT NULL,
    synced_at timestamp with time zone NOT NULL,
    CONSTRAINT ozon_delivery_methods_id_positive CHECK ((method_id > 0)),
    CONSTRAINT ozon_delivery_methods_name_len CHECK (((char_length(name) >= 1) AND (char_length(name) <= 500))),
    CONSTRAINT ozon_delivery_methods_warehouse_positive CHECK ((warehouse_id > 0))
);

ALTER TABLE ONLY public.ozon_delivery_methods FORCE ROW LEVEL SECURITY;


--
-- Name: ozon_dictionary_current; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ozon_dictionary_current (
    description_category_id bigint NOT NULL,
    type_id bigint NOT NULL,
    language character varying(16) NOT NULL,
    attribute_id bigint NOT NULL,
    option_id bigint NOT NULL,
    value text NOT NULL,
    info text DEFAULT ''::text NOT NULL,
    picture text DEFAULT ''::text NOT NULL,
    CONSTRAINT ozon_dictionary_current_identity_positive CHECK (((attribute_id > 0) AND (option_id > 0)))
);


--
-- Name: ozon_error_catalog; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ozon_error_catalog (
    source text NOT NULL,
    code text NOT NULL,
    attribute_id bigint NOT NULL,
    description_category_id bigint NOT NULL,
    type_id bigint NOT NULL,
    level text DEFAULT ''::text NOT NULL,
    state text DEFAULT ''::text NOT NULL,
    field text DEFAULT ''::text NOT NULL,
    attribute_name text DEFAULT ''::text NOT NULL,
    sample_description text DEFAULT ''::text NOT NULL,
    occurrences bigint NOT NULL,
    first_seen_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT ozon_error_catalog_clean CHECK (((code !~* '(fixture-api-key|api[-_]?key|bearer |sk-|client[-_]?id|signature=|x-amz-)'::text) AND (field !~* '(fixture-api-key|api[-_]?key|bearer |sk-|client[-_]?id|signature=|x-amz-)'::text) AND (attribute_name !~* '(fixture-api-key|api[-_]?key|bearer |sk-|client[-_]?id|signature=|x-amz-)'::text) AND (level !~* '(fixture-api-key|api[-_]?key|bearer |sk-|client[-_]?id|signature=|x-amz-)'::text) AND (state !~* '(fixture-api-key|api[-_]?key|bearer |sk-|client[-_]?id|signature=|x-amz-)'::text) AND (sample_description !~* '(fixture-api-key|api[-_]?key|bearer |sk-|client[-_]?id|signature=|x-amz-)'::text))),
    CONSTRAINT ozon_error_catalog_code_len CHECK (((char_length(code) >= 1) AND (char_length(code) <= 128))),
    CONSTRAINT ozon_error_catalog_count CHECK ((occurrences >= 0)),
    CONSTRAINT ozon_error_catalog_ids CHECK (((attribute_id >= 0) AND (description_category_id >= 0) AND (type_id >= 0))),
    CONSTRAINT ozon_error_catalog_source CHECK ((source = ANY (ARRAY['ozon_import_info'::text, 'ozon_request'::text, 'docs_seed'::text]))),
    CONSTRAINT ozon_error_catalog_span CHECK ((first_seen_at <= last_seen_at)),
    CONSTRAINT ozon_error_catalog_text_len CHECK (((char_length(level) <= 32) AND (char_length(state) <= 64) AND (char_length(field) <= 128) AND (char_length(attribute_name) <= 200) AND (char_length(sample_description) <= 500)))
);

ALTER TABLE ONLY public.ozon_error_catalog FORCE ROW LEVEL SECURITY;


--
-- Name: ozon_error_observation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ozon_error_observation (
    org_id bigint NOT NULL,
    source text NOT NULL,
    code text NOT NULL,
    attribute_id bigint NOT NULL,
    description_category_id bigint NOT NULL,
    type_id bigint NOT NULL,
    level text DEFAULT ''::text NOT NULL,
    state text DEFAULT ''::text NOT NULL,
    field text DEFAULT ''::text NOT NULL,
    attribute_name text DEFAULT ''::text NOT NULL,
    sample_description text DEFAULT ''::text NOT NULL,
    occurrences bigint NOT NULL,
    first_seen_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT ozon_error_observation_clean CHECK (((code !~* '(fixture-api-key|api[-_]?key|bearer |sk-|client[-_]?id|signature=|x-amz-)'::text) AND (field !~* '(fixture-api-key|api[-_]?key|bearer |sk-|client[-_]?id|signature=|x-amz-)'::text) AND (attribute_name !~* '(fixture-api-key|api[-_]?key|bearer |sk-|client[-_]?id|signature=|x-amz-)'::text) AND (level !~* '(fixture-api-key|api[-_]?key|bearer |sk-|client[-_]?id|signature=|x-amz-)'::text) AND (state !~* '(fixture-api-key|api[-_]?key|bearer |sk-|client[-_]?id|signature=|x-amz-)'::text) AND (sample_description !~* '(fixture-api-key|api[-_]?key|bearer |sk-|client[-_]?id|signature=|x-amz-)'::text))),
    CONSTRAINT ozon_error_observation_code_len CHECK (((char_length(code) >= 1) AND (char_length(code) <= 128))),
    CONSTRAINT ozon_error_observation_count CHECK ((occurrences > 0)),
    CONSTRAINT ozon_error_observation_ids CHECK (((org_id > 0) AND (attribute_id >= 0) AND (description_category_id >= 0) AND (type_id >= 0))),
    CONSTRAINT ozon_error_observation_source CHECK ((source = ANY (ARRAY['ozon_import_info'::text, 'ozon_request'::text]))),
    CONSTRAINT ozon_error_observation_span CHECK ((first_seen_at <= last_seen_at)),
    CONSTRAINT ozon_error_observation_text_len CHECK (((char_length(level) <= 32) AND (char_length(state) <= 64) AND (char_length(field) <= 128) AND (char_length(attribute_name) <= 200) AND (char_length(sample_description) <= 500)))
);

ALTER TABLE ONLY public.ozon_error_observation FORCE ROW LEVEL SECURITY;


--
-- Name: ozon_error_sighting; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ozon_error_sighting (
    org_id bigint NOT NULL,
    task_key text NOT NULL,
    offer_key text NOT NULL,
    source text NOT NULL,
    code text NOT NULL,
    attribute_id bigint NOT NULL,
    description_category_id bigint NOT NULL,
    type_id bigint NOT NULL,
    seen_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT ozon_error_sighting_lens CHECK (((org_id > 0) AND ((char_length(task_key) >= 1) AND (char_length(task_key) <= 80)) AND (char_length(offer_key) <= 200) AND ((char_length(code) >= 1) AND (char_length(code) <= 128)) AND (attribute_id >= 0) AND (description_category_id >= 0) AND (type_id >= 0))),
    CONSTRAINT ozon_error_sighting_source CHECK ((source = ANY (ARRAY['ozon_import_info'::text, 'ozon_request'::text])))
);

ALTER TABLE ONLY public.ozon_error_sighting FORCE ROW LEVEL SECURITY;


--
-- Name: ozon_field_packs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ozon_field_packs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    author_user_id bigint NOT NULL,
    name text NOT NULL,
    description_category_id bigint NOT NULL,
    type_id bigint NOT NULL,
    language text NOT NULL,
    defaults_json text NOT NULL,
    updated_at_ms bigint NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    shared boolean DEFAULT false NOT NULL,
    active boolean DEFAULT false NOT NULL
);


--
-- Name: ozon_product_status; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ozon_product_status (
    id smallint NOT NULL,
    is_archived boolean NOT NULL,
    status text NOT NULL,
    status_name text NOT NULL,
    moderate_status text NOT NULL,
    validation_status text NOT NULL,
    state text NOT NULL,
    CONSTRAINT ozon_product_status_state_check CHECK ((state = ANY (ARRAY['on_sale'::text, 'processing'::text, 'moderation_failed'::text, 'hidden'::text, 'archived'::text])))
);


--
-- Name: ozon_product_status_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.ozon_product_status ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.ozon_product_status_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: ozon_warehouse_fences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ozon_warehouse_fences (
    org_id bigint NOT NULL,
    store_id uuid NOT NULL,
    warehouse_id bigint NOT NULL,
    CONSTRAINT ozon_warehouse_fences_id_nonneg CHECK ((warehouse_id >= 0))
);

ALTER TABLE ONLY public.ozon_warehouse_fences FORCE ROW LEVEL SECURITY;


--
-- Name: ozon_warehouse_intents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ozon_warehouse_intents (
    id uuid NOT NULL,
    org_id bigint NOT NULL,
    store_id uuid NOT NULL,
    user_id bigint NOT NULL,
    client_operation_id text NOT NULL,
    kind text NOT NULL,
    warehouse_id bigint,
    fence_warehouse_id bigint NOT NULL,
    confirm boolean DEFAULT false NOT NULL,
    state text NOT NULL,
    ozon_operation_id text,
    http_status integer,
    error_code text,
    request_hash text DEFAULT ''::text NOT NULL,
    credential_granted_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT ozon_warehouse_intents_client_len CHECK (((client_operation_id <> ''::text) AND (char_length(client_operation_id) <= 128))),
    CONSTRAINT ozon_warehouse_intents_fence CHECK ((((kind = 'create'::text) AND (fence_warehouse_id = 0) AND (warehouse_id IS NULL)) OR ((kind <> 'create'::text) AND (warehouse_id IS NOT NULL) AND (warehouse_id > 0) AND (fence_warehouse_id = warehouse_id)))),
    CONSTRAINT ozon_warehouse_intents_hash_len CHECK ((char_length(request_hash) <= 128)),
    CONSTRAINT ozon_warehouse_intents_kind CHECK ((kind = ANY (ARRAY['create'::text, 'update'::text, 'archive'::text, 'unarchive'::text, 'first_mile_update'::text]))),
    CONSTRAINT ozon_warehouse_intents_state CHECK ((state = ANY (ARRAY['granted'::text, 'accepted'::text, 'rejected'::text, 'unknown'::text])))
);

ALTER TABLE ONLY public.ozon_warehouse_intents FORCE ROW LEVEL SECURITY;


--
-- Name: ozon_warehouse_sync; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ozon_warehouse_sync (
    org_id bigint NOT NULL,
    store_id uuid NOT NULL,
    warehouses_synced_at timestamp with time zone,
    methods_synced_at timestamp with time zone
);

ALTER TABLE ONLY public.ozon_warehouse_sync FORCE ROW LEVEL SECURITY;


--
-- Name: ozon_warehouses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ozon_warehouses (
    org_id bigint NOT NULL,
    store_id uuid NOT NULL,
    warehouse_id bigint NOT NULL,
    name text NOT NULL,
    ozon_status text DEFAULT ''::text NOT NULL,
    is_rfbs boolean DEFAULT false NOT NULL,
    archived_at timestamp with time zone,
    synced_at timestamp with time zone NOT NULL,
    CONSTRAINT ozon_warehouses_id_positive CHECK ((warehouse_id > 0)),
    CONSTRAINT ozon_warehouses_name_len CHECK (((char_length(name) >= 1) AND (char_length(name) <= 500))),
    CONSTRAINT ozon_warehouses_status_len CHECK ((char_length(ozon_status) <= 64))
);

ALTER TABLE ONLY public.ozon_warehouses FORCE ROW LEVEL SECURITY;


--
-- Name: payment_callback_ledger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_callback_ledger (
    payment_reference character varying(128) NOT NULL,
    org_id bigint NOT NULL,
    plan character varying(64) NOT NULL,
    status character varying(64) NOT NULL,
    body_digest character varying(128),
    applied_at_ms bigint NOT NULL,
    created_at timestamp with time zone NOT NULL
);


--
-- Name: payment_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_orders (
    id bigint NOT NULL,
    public_id character varying(64) NOT NULL,
    org_id bigint NOT NULL,
    plan character varying(64),
    months integer NOT NULL,
    amount_cents bigint NOT NULL,
    currency character varying(8) NOT NULL,
    provider character varying(32) NOT NULL,
    status character varying(32) NOT NULL,
    provider_ref character varying(128),
    created_by_user_id bigint NOT NULL,
    paid_at timestamp with time zone,
    canceled_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    product character varying(32) NOT NULL,
    topup_microfen bigint,
    qr_code text,
    pay_url text,
    operation_id character varying(64),
    launch_state character varying(32),
    purchase_agreement jsonb,
    subscription_snapshot jsonb,
    payment_deadline_at timestamp with time zone,
    fulfillment_failed_at timestamp with time zone,
    reconciliation_reason text,
    quote_id uuid,
    CONSTRAINT payment_orders_amount_check CHECK ((amount_cents >= 0)),
    CONSTRAINT payment_orders_launch_state_known CHECK (((launch_state IS NULL) OR ((launch_state)::text = 'entry_confirming'::text))),
    CONSTRAINT payment_orders_months_check CHECK ((months >= 1)),
    CONSTRAINT payment_orders_pay_url_size CHECK (((pay_url IS NULL) OR (octet_length(pay_url) <= 4096))),
    CONSTRAINT payment_orders_product_known CHECK (((product)::text = ANY ((ARRAY['subscription'::character varying, 'wallet_topup'::character varying, 'platform_goods'::character varying])::text[]))),
    CONSTRAINT payment_orders_product_shape CHECK (((((product)::text = 'subscription'::text) AND (subscription_snapshot IS NOT NULL) AND (topup_microfen IS NULL)) OR (((product)::text = 'wallet_topup'::text) AND (topup_microfen > 0)) OR (((product)::text = 'platform_goods'::text) AND (topup_microfen IS NULL)))),
    CONSTRAINT payment_orders_purchase_agreement_valid CHECK (((((product)::text <> 'subscription'::text) AND (purchase_agreement IS NULL)) OR (((product)::text = 'subscription'::text) AND (jsonb_typeof(purchase_agreement) = 'object'::text) AND (purchase_agreement ?& ARRAY['version'::text, 'title'::text, 'effective_at'::text, 'content'::text, 'accepted_at'::text, 'accepted_by'::text]) AND (jsonb_typeof((purchase_agreement -> 'version'::text)) = 'string'::text) AND (jsonb_typeof((purchase_agreement -> 'title'::text)) = 'string'::text) AND (jsonb_typeof((purchase_agreement -> 'effective_at'::text)) = 'string'::text) AND (jsonb_typeof((purchase_agreement -> 'content'::text)) = 'string'::text) AND (jsonb_typeof((purchase_agreement -> 'accepted_at'::text)) = 'string'::text) AND (jsonb_typeof((purchase_agreement -> 'accepted_by'::text)) = 'string'::text) AND (length((purchase_agreement ->> 'version'::text)) > 0) AND (length((purchase_agreement ->> 'content'::text)) > 0) AND (length((purchase_agreement ->> 'accepted_at'::text)) > 0) AND ((purchase_agreement ->> 'accepted_by'::text) = (created_by_user_id)::text)))),
    CONSTRAINT payment_orders_qr_code_size CHECK (((qr_code IS NULL) OR (octet_length(qr_code) <= 16384))),
    CONSTRAINT payment_orders_reconciliation_reason_check CHECK (((reconciliation_reason IS NULL) OR (reconciliation_reason = ANY (ARRAY['amount_mismatch'::text, 'fulfilled_after_cancel'::text, 'term_shortened'::text, 'superseded_change'::text])))),
    CONSTRAINT payment_orders_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'paid'::character varying, 'canceled'::character varying])::text[]))),
    CONSTRAINT payment_orders_subscription_snapshot_shape CHECK ((((product)::text = 'subscription'::text) = (subscription_snapshot IS NOT NULL))),
    CONSTRAINT payment_orders_terminal_has_no_launch CHECK ((((status)::text = 'pending'::text) OR ((qr_code IS NULL) AND (pay_url IS NULL)))),
    CONSTRAINT payment_orders_terminal_has_no_launch_state CHECK ((((status)::text = 'pending'::text) OR (launch_state IS NULL)))
);

ALTER TABLE ONLY public.payment_orders FORCE ROW LEVEL SECURITY;


--
-- Name: payment_orders_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.payment_orders_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: payment_orders_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.payment_orders_id_seq OWNED BY public.payment_orders.id;


--
-- Name: plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plans (
    key character varying(32) NOT NULL,
    name character varying(128) NOT NULL,
    tagline character varying(512) DEFAULT ''::character varying NOT NULL,
    store_monthly_cents bigint DEFAULT 0 NOT NULL,
    highlights text DEFAULT '[]'::text NOT NULL,
    admin_only boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    s3_upload_bytes_monthly bigint DEFAULT 0 NOT NULL,
    ai_tokens_monthly bigint DEFAULT 0 NOT NULL
);


--
-- Name: platform_catalog_fetch_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_catalog_fetch_config (
    singleton boolean DEFAULT true NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    schedule_mode character varying(16) DEFAULT 'fixed'::character varying NOT NULL,
    at_minute integer DEFAULT 180 NOT NULL,
    window_start_minute integer DEFAULT 120 NOT NULL,
    window_end_minute integer DEFAULT 240 NOT NULL,
    utc_offset_minutes integer DEFAULT 480 NOT NULL,
    language character varying(16) DEFAULT 'zh_hans'::character varying NOT NULL,
    next_run_at_ms bigint,
    lease_until_ms bigint,
    last_run_at_ms bigint,
    last_status character varying(16),
    last_error text DEFAULT ''::text NOT NULL,
    last_duration_ms bigint,
    last_root_nodes integer,
    last_key_client_id character varying(256),
    last_key_attempts integer DEFAULT 0 NOT NULL,
    failure_streak integer DEFAULT 0 NOT NULL,
    updated_at_ms bigint DEFAULT 0 NOT NULL,
    updated_by_account_uuid character varying(64),
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    wb_credential_revision bigint DEFAULT 0 NOT NULL,
    wb_last_verified_at_ms bigint,
    wb_token_key_id character varying(32),
    wb_token_nonce bytea,
    wb_token_ciphertext bytea,
    lease_epoch bigint DEFAULT 0 NOT NULL,
    CONSTRAINT platform_catalog_fetch_config_at_minute_range CHECK (((at_minute >= 0) AND (at_minute <= 1439))),
    CONSTRAINT platform_catalog_fetch_config_attempts_nonnegative CHECK ((last_key_attempts >= 0)),
    CONSTRAINT platform_catalog_fetch_config_lease_epoch_nonnegative CHECK ((lease_epoch >= 0)),
    CONSTRAINT platform_catalog_fetch_config_mode_known CHECK (((schedule_mode)::text = ANY ((ARRAY['fixed'::character varying, 'random'::character varying])::text[]))),
    CONSTRAINT platform_catalog_fetch_config_offset_range CHECK (((utc_offset_minutes >= '-720'::integer) AND (utc_offset_minutes <= 840))),
    CONSTRAINT platform_catalog_fetch_config_status_known CHECK (((last_status IS NULL) OR ((last_status)::text = ANY ((ARRAY['ok'::character varying, 'failed'::character varying])::text[])))),
    CONSTRAINT platform_catalog_fetch_config_streak_nonnegative CHECK ((failure_streak >= 0)),
    CONSTRAINT platform_catalog_fetch_config_window_range CHECK (((window_start_minute >= 0) AND (window_start_minute <= 1439) AND (window_end_minute >= 0) AND (window_end_minute <= 1439) AND (window_end_minute > window_start_minute))),
    CONSTRAINT platform_catalog_fetch_wb_revision_nonnegative CHECK ((wb_credential_revision >= 0)),
    CONSTRAINT platform_catalog_fetch_wb_state_consistent CHECK ((((wb_token_ciphertext IS NULL) AND (wb_credential_revision = 0) AND (wb_last_verified_at_ms IS NULL)) OR ((wb_token_ciphertext IS NOT NULL) AND (wb_credential_revision > 0) AND (wb_last_verified_at_ms IS NOT NULL)))),
    CONSTRAINT platform_catalog_fetch_wb_token_envelope_complete CHECK ((((wb_token_key_id IS NULL) AND (wb_token_nonce IS NULL) AND (wb_token_ciphertext IS NULL)) OR ((wb_token_key_id IS NOT NULL) AND (wb_token_nonce IS NOT NULL) AND (wb_token_ciphertext IS NOT NULL)))),
    CONSTRAINT platform_catalog_fetch_wb_token_envelope_shape CHECK (((wb_token_key_id IS NULL) OR ((length(btrim((wb_token_key_id)::text)) > 0) AND (octet_length(wb_token_nonce) = 12) AND ((octet_length(wb_token_ciphertext) >= 17) AND (octet_length(wb_token_ciphertext) <= 32768)))))
);


--
-- Name: platform_catalog_fetch_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_catalog_fetch_keys (
    id bigint NOT NULL,
    config_singleton boolean DEFAULT true NOT NULL,
    "position" integer NOT NULL,
    client_id character varying(256) NOT NULL,
    api_key_key_id character varying(32),
    api_key_nonce bytea,
    api_key_ciphertext bytea,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    disabled_at_ms bigint,
    CONSTRAINT platform_catalog_fetch_keys_client_id_present CHECK ((length(btrim((client_id)::text)) > 0)),
    CONSTRAINT platform_catalog_fetch_keys_position_range CHECK ((("position" >= 1) AND ("position" <= 8)))
);


--
-- Name: platform_catalog_fetch_keys_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.platform_catalog_fetch_keys ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.platform_catalog_fetch_keys_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: platform_initialization; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_initialization (
    singleton boolean DEFAULT true NOT NULL,
    owner_account_id bigint,
    initialized_at timestamp with time zone,
    CONSTRAINT platform_initialization_owner_pair CHECK (((owner_account_id IS NULL) = (initialized_at IS NULL))),
    CONSTRAINT platform_initialization_singleton CHECK (singleton)
);


--
-- Name: platform_integration_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_integration_config (
    singleton boolean DEFAULT true NOT NULL,
    revision bigint NOT NULL,
    nonce bytea NOT NULL,
    ciphertext bytea NOT NULL,
    updated_at_ms bigint NOT NULL,
    updated_by_account_uuid text NOT NULL,
    CONSTRAINT platform_integration_config_nonce_length CHECK ((octet_length(nonce) = 12)),
    CONSTRAINT platform_integration_config_revision_positive CHECK ((revision > 0)),
    CONSTRAINT platform_integration_config_singleton CHECK (singleton)
);


--
-- Name: product_variant_previews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_variant_previews (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id bigint NOT NULL,
    store_pk bigint NOT NULL,
    digest text NOT NULL,
    physical_account_key text NOT NULL,
    request jsonb NOT NULL,
    created_at_ms bigint DEFAULT ((EXTRACT(epoch FROM clock_timestamp()) * (1000)::numeric))::bigint NOT NULL,
    expires_at_ms bigint NOT NULL,
    CONSTRAINT product_variant_previews_digest_check CHECK (((length(digest) >= 1) AND (length(digest) <= 128))),
    CONSTRAINT product_variant_previews_physical_account_key_check CHECK ((physical_account_key ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT product_variant_previews_request_shape CHECK ((jsonb_typeof(request) = 'object'::text)),
    CONSTRAINT product_variant_previews_window CHECK ((expires_at_ms > created_at_ms))
);

ALTER TABLE ONLY public.product_variant_previews FORCE ROW LEVEL SECURITY;


--
-- Name: prompt_revisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prompt_revisions (
    id bigint NOT NULL,
    product_id text NOT NULL,
    revision integer NOT NULL,
    brief text NOT NULL,
    fixed_tags jsonb NOT NULL,
    ai_output jsonb NOT NULL,
    note text,
    author_id text NOT NULL,
    created_at_ms bigint NOT NULL,
    CONSTRAINT prompt_revisions_ai_output_object CHECK ((jsonb_typeof(ai_output) = 'object'::text)),
    CONSTRAINT prompt_revisions_fixed_tags_array CHECK ((jsonb_typeof(fixed_tags) = 'array'::text)),
    CONSTRAINT prompt_revisions_revision_positive CHECK ((revision > 0))
);


--
-- Name: prompt_revisions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.prompt_revisions ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.prompt_revisions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: redeem_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.redeem_codes (
    id bigint NOT NULL,
    code character varying(128) NOT NULL,
    used boolean DEFAULT false NOT NULL,
    used_by_user_id bigint,
    used_at_ms bigint DEFAULT 0 NOT NULL,
    created_at_ms bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    batch_id uuid,
    note text,
    expires_at timestamp with time zone,
    created_by_user_id bigint,
    used_by_org_id bigint,
    revoked_at timestamp with time zone,
    revoked_by_user_id bigint,
    wallet_cents bigint NOT NULL,
    CONSTRAINT redeem_codes_wallet_cents_valid CHECK ((wallet_cents >= 1))
);

ALTER TABLE ONLY public.redeem_codes FORCE ROW LEVEL SECURITY;


--
-- Name: redeem_codes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.redeem_codes ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.redeem_codes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: sc_catalog_managers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sc_catalog_managers (
    manager_id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_id text NOT NULL,
    user_id bigint NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_by bigint,
    created_at_ms bigint NOT NULL,
    revoked_by bigint,
    revoked_at_ms bigint,
    CONSTRAINT ck_sc_catalog_managers_revoked CHECK (((status = 'disabled'::text) = (revoked_at_ms IS NOT NULL))),
    CONSTRAINT ck_sc_catalog_managers_status CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text])))
);

ALTER TABLE ONLY public.sc_catalog_managers FORCE ROW LEVEL SECURITY;


--
-- Name: sc_listing_bindings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sc_listing_bindings (
    id bigint NOT NULL,
    org_id bigint NOT NULL,
    store_id uuid NOT NULL,
    listing_row_id uuid NOT NULL,
    platform_sku_id text NOT NULL,
    spec_version bigint NOT NULL,
    design_revision bigint NOT NULL,
    production_snapshot jsonb NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    created_by_account_uuid text NOT NULL,
    CONSTRAINT ck_sc_listing_bindings_design_revision CHECK ((design_revision >= 1)),
    CONSTRAINT ck_sc_listing_bindings_spec_version CHECK ((spec_version >= 1))
);


--
-- Name: sc_listing_bindings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.sc_listing_bindings ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.sc_listing_bindings_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: sc_order_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sc_order_lines (
    id bigint NOT NULL,
    org_id bigint NOT NULL,
    order_id text NOT NULL,
    line_no integer NOT NULL,
    listing_row_id uuid NOT NULL,
    platform_sku_id text NOT NULL,
    unit_platform_price_cents bigint NOT NULL,
    quantity bigint NOT NULL,
    amount_cents bigint NOT NULL,
    spec_version bigint NOT NULL,
    design_revision bigint NOT NULL,
    CONSTRAINT ck_sc_order_lines_qty CHECK ((quantity >= 1))
);

ALTER TABLE ONLY public.sc_order_lines FORCE ROW LEVEL SECURITY;


--
-- Name: sc_order_lines_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.sc_order_lines ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.sc_order_lines_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: sc_order_quotes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sc_order_quotes (
    id bigint NOT NULL,
    quote_id text NOT NULL,
    org_id bigint NOT NULL,
    store_id uuid NOT NULL,
    listing_row_id uuid NOT NULL,
    platform_sku_id text NOT NULL,
    request_hash text NOT NULL,
    price_version_id bigint NOT NULL,
    unit_price_cents bigint NOT NULL,
    quantity bigint NOT NULL,
    amount_cents bigint NOT NULL,
    currency text DEFAULT 'CNY'::text NOT NULL,
    expires_at_ms bigint NOT NULL,
    idempotency_key text NOT NULL,
    created_at_ms bigint NOT NULL,
    created_by_account_uuid text NOT NULL,
    CONSTRAINT ck_sc_order_quotes_amount CHECK (((amount_cents > 0) AND (unit_price_cents > 0))),
    CONSTRAINT ck_sc_order_quotes_qty CHECK ((quantity >= 1))
);


--
-- Name: sc_order_quotes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.sc_order_quotes ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.sc_order_quotes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: sc_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sc_orders (
    id bigint NOT NULL,
    order_id text NOT NULL,
    org_id bigint NOT NULL,
    store_id uuid NOT NULL,
    quote_id text NOT NULL,
    listing_row_id uuid NOT NULL,
    platform_sku_id text NOT NULL,
    spec_version bigint NOT NULL,
    design_revision bigint NOT NULL,
    production_snapshot jsonb NOT NULL,
    unit_platform_price_cents bigint NOT NULL,
    price_version_id bigint NOT NULL,
    quantity bigint NOT NULL,
    amount_cents bigint NOT NULL,
    currency text DEFAULT 'CNY'::text NOT NULL,
    status text NOT NULL,
    payment_order_public_id text NOT NULL,
    request_hash text NOT NULL,
    idempotency_key text NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    created_by_account_uuid text NOT NULL,
    refund_requested_at_ms bigint,
    CONSTRAINT ck_sc_orders_design CHECK ((design_revision >= 1)),
    CONSTRAINT ck_sc_orders_qty CHECK ((quantity >= 1)),
    CONSTRAINT ck_sc_orders_spec CHECK ((spec_version >= 1)),
    CONSTRAINT ck_sc_orders_status CHECK ((status = ANY (ARRAY['awaiting_payment'::text, 'awaiting_procurement'::text, 'processing'::text, 'in_production'::text, 'shipped'::text])))
);

ALTER TABLE ONLY public.sc_orders FORCE ROW LEVEL SECURITY;


--
-- Name: sc_orders_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.sc_orders ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.sc_orders_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: sc_price_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sc_price_versions (
    id bigint NOT NULL,
    sku_id text NOT NULL,
    price_cents bigint NOT NULL,
    created_at_ms bigint NOT NULL,
    created_by_account_uuid text NOT NULL,
    CONSTRAINT ck_sc_price_versions_price CHECK ((price_cents > 0))
);

ALTER TABLE ONLY public.sc_price_versions FORCE ROW LEVEL SECURITY;


--
-- Name: sc_price_versions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.sc_price_versions ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.sc_price_versions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: sc_procurements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sc_procurements (
    id bigint NOT NULL,
    procurement_id text NOT NULL,
    operation_id text NOT NULL,
    org_id bigint NOT NULL,
    platform_order_id text NOT NULL,
    line_no integer DEFAULT 1 NOT NULL,
    attempt integer NOT NULL,
    status text NOT NULL,
    source_id text,
    channel_sku text,
    supplier_cost_snapshot_cents bigint,
    channel_order_ref text,
    reject_reason text,
    claimed_by_account_uuid text,
    claimed_at_ms bigint,
    lease_until_ms bigint,
    dispatched_at_ms bigint,
    receipt_at_ms bigint,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    created_by_account_uuid text NOT NULL,
    CONSTRAINT ck_sc_procurements_attempt CHECK ((attempt >= 1)),
    CONSTRAINT ck_sc_procurements_line CHECK ((line_no >= 1)),
    CONSTRAINT ck_sc_procurements_status CHECK ((status = ANY (ARRAY['prepared'::text, 'dispatching'::text, 'accepted'::text, 'rejected'::text, 'unknown'::text])))
);


--
-- Name: sc_procurements_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.sc_procurements ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.sc_procurements_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: sc_products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sc_products (
    id bigint NOT NULL,
    product_id text NOT NULL,
    title text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    media jsonb DEFAULT '[]'::jsonb NOT NULL,
    specs jsonb DEFAULT '{}'::jsonb NOT NULL,
    published boolean DEFAULT false NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    created_by_account_uuid text NOT NULL,
    source_id text DEFAULT 'src_unassigned'::text NOT NULL,
    prompt_name text DEFAULT ''::text NOT NULL,
    prompt_file_name text DEFAULT ''::text NOT NULL,
    prompt_content text DEFAULT ''::text NOT NULL,
    fixed_tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    product_videos jsonb DEFAULT '[]'::jsonb NOT NULL,
    gallery jsonb DEFAULT '[]'::jsonb NOT NULL,
    psd jsonb DEFAULT '[]'::jsonb NOT NULL,
    description_category_id bigint,
    type_id bigint,
    internal_note text DEFAULT ''::text NOT NULL,
    props jsonb DEFAULT '{}'::jsonb NOT NULL,
    archived boolean DEFAULT false NOT NULL,
    size text DEFAULT ''::text NOT NULL,
    gross_weight_g bigint,
    material text DEFAULT ''::text NOT NULL,
    craft text DEFAULT ''::text NOT NULL,
    variant_group text DEFAULT ''::text NOT NULL,
    brand text DEFAULT ''::text NOT NULL,
    pack_width_mm bigint,
    pack_height_mm bigint,
    pack_depth_mm bigint,
    pack_weight_g bigint,
    contents text DEFAULT ''::text NOT NULL,
    CONSTRAINT ck_sc_products_gross_weight CHECK (((gross_weight_g IS NULL) OR (gross_weight_g > 0))),
    CONSTRAINT ck_sc_products_revision CHECK ((revision >= 1)),
    CONSTRAINT ck_sc_products_variant_group_size CHECK (((variant_group = ''::text) OR (btrim(size) <> ''::text)))
);

ALTER TABLE ONLY public.sc_products FORCE ROW LEVEL SECURITY;


--
-- Name: sc_products_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.sc_products ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.sc_products_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: sc_skus; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sc_skus (
    id bigint NOT NULL,
    sku_id text NOT NULL,
    product_id text NOT NULL,
    platform_code text NOT NULL,
    title text NOT NULL,
    media jsonb DEFAULT '[]'::jsonb NOT NULL,
    specs jsonb DEFAULT '{}'::jsonb NOT NULL,
    lead_time text DEFAULT ''::text NOT NULL,
    published boolean DEFAULT false NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    created_by_account_uuid text NOT NULL,
    suggested_retail_cents bigint,
    suggested_old_price_cents bigint,
    CONSTRAINT ck_sc_skus_revision CHECK ((revision >= 1))
);

ALTER TABLE ONLY public.sc_skus FORCE ROW LEVEL SECURITY;


--
-- Name: sc_skus_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.sc_skus ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.sc_skus_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: sc_source_fulfillers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sc_source_fulfillers (
    fulfiller_id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_id text NOT NULL,
    user_id bigint NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_by bigint,
    created_at_ms bigint NOT NULL,
    revoked_by bigint,
    revoked_at_ms bigint,
    CONSTRAINT ck_sc_source_fulfillers_revoked CHECK (((status = 'disabled'::text) = (revoked_at_ms IS NOT NULL))),
    CONSTRAINT ck_sc_source_fulfillers_status CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text])))
);

ALTER TABLE ONLY public.sc_source_fulfillers FORCE ROW LEVEL SECURITY;


--
-- Name: sc_source_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sc_source_members (
    member_id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_id text NOT NULL,
    user_id bigint NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_by bigint NOT NULL,
    created_at_ms bigint NOT NULL,
    CONSTRAINT ck_sc_source_members_role CHECK ((role = 'member'::text)),
    CONSTRAINT ck_sc_source_members_status CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text])))
);

ALTER TABLE ONLY public.sc_source_members FORCE ROW LEVEL SECURITY;


--
-- Name: sc_source_offers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sc_source_offers (
    id bigint NOT NULL,
    source_id text NOT NULL,
    sku_id text NOT NULL,
    cost_cents bigint,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    shipping_cost_cents bigint,
    CONSTRAINT ck_sc_source_offers_cost CHECK (((cost_cents IS NULL) OR (cost_cents > 0))),
    CONSTRAINT ck_sc_source_offers_nonempty CHECK (((cost_cents IS NOT NULL) OR (shipping_cost_cents IS NOT NULL))),
    CONSTRAINT ck_sc_source_offers_shipping CHECK (((shipping_cost_cents IS NULL) OR (shipping_cost_cents > 0)))
);

ALTER TABLE ONLY public.sc_source_offers FORCE ROW LEVEL SECURITY;


--
-- Name: sc_source_offers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.sc_source_offers ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.sc_source_offers_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: sc_source_prop_defs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sc_source_prop_defs (
    prop_id text NOT NULL,
    source_id text NOT NULL,
    name text NOT NULL,
    type text NOT NULL,
    options jsonb DEFAULT '[]'::jsonb NOT NULL,
    "position" bigint DEFAULT 0 NOT NULL,
    seller_visible boolean DEFAULT true NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    CONSTRAINT ck_sc_source_prop_defs_type CHECK ((type = ANY (ARRAY['text'::text, 'long_text'::text, 'number'::text, 'select'::text, 'multi_select'::text, 'checkbox'::text]))),
    CONSTRAINT sc_source_prop_defs_revision_positive CHECK ((revision >= 1))
);

ALTER TABLE ONLY public.sc_source_prop_defs FORCE ROW LEVEL SECURITY;


--
-- Name: sc_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sc_sources (
    source_id text NOT NULL,
    name text NOT NULL,
    country text DEFAULT ''::text NOT NULL,
    contact text DEFAULT ''::text NOT NULL,
    internal_note text DEFAULT ''::text NOT NULL,
    listed boolean DEFAULT false NOT NULL,
    icon text DEFAULT ''::text NOT NULL,
    view_prefs jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    created_by_account_uuid text DEFAULT ''::text NOT NULL,
    accepts_delegate boolean DEFAULT false NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    schema_revision bigint DEFAULT 1 NOT NULL,
    CONSTRAINT sc_sources_revision_positive CHECK ((revision >= 1)),
    CONSTRAINT sc_sources_schema_revision_positive CHECK ((schema_revision >= 1))
);

ALTER TABLE ONLY public.sc_sources FORCE ROW LEVEL SECURITY;


--
-- Name: seller_read_incidents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.seller_read_incidents (
    id bigint NOT NULL,
    org_id bigint NOT NULL,
    store_id uuid NOT NULL,
    client_id text NOT NULL,
    path text NOT NULL,
    status smallint NOT NULL,
    retry_after_ms bigint,
    origin text NOT NULL,
    at_ms bigint NOT NULL
);

ALTER TABLE ONLY public.seller_read_incidents FORCE ROW LEVEL SECURITY;


--
-- Name: seller_read_incidents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.seller_read_incidents ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.seller_read_incidents_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: seller_resource_occupancies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.seller_resource_occupancies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id bigint NOT NULL,
    store_pk bigint NOT NULL,
    physical_account_key text NOT NULL,
    resource_kind text NOT NULL,
    resource_key text NOT NULL,
    owner_kind text NOT NULL,
    owner_ref text NOT NULL,
    members jsonb DEFAULT '[]'::jsonb NOT NULL,
    spec_digest text NOT NULL,
    state text DEFAULT 'held'::text NOT NULL,
    created_at_ms bigint DEFAULT ((EXTRACT(epoch FROM clock_timestamp()) * (1000)::numeric))::bigint NOT NULL,
    released_at_ms bigint,
    release_reason text,
    CONSTRAINT seller_resource_occupancies_members_check CHECK ((jsonb_typeof(members) = 'array'::text)),
    CONSTRAINT seller_resource_occupancies_owner_kind_check CHECK ((owner_kind = ANY (ARRAY['store_write'::text, 'listing_association'::text]))),
    CONSTRAINT seller_resource_occupancies_owner_ref_check CHECK (((length(owner_ref) >= 1) AND (length(owner_ref) <= 512))),
    CONSTRAINT seller_resource_occupancies_physical_account_key_check CHECK (((length(physical_account_key) >= 1) AND (length(physical_account_key) <= 128))),
    CONSTRAINT seller_resource_occupancies_release_complete CHECK ((((state = 'held'::text) AND (released_at_ms IS NULL) AND (release_reason IS NULL)) OR ((state = 'released'::text) AND (released_at_ms IS NOT NULL) AND (release_reason IS NOT NULL) AND (release_reason = ANY (ARRAY['not_dispatched'::text, 'rejected_no_pending'::text, 'relationship_confirmed'::text, 'partial_settled'::text]))))),
    CONSTRAINT seller_resource_occupancies_resource_key_check CHECK (((length(resource_key) >= 1) AND (length(resource_key) <= 512))),
    CONSTRAINT seller_resource_occupancies_resource_kind_check CHECK ((resource_kind = ANY (ARRAY['offer'::text, 'model'::text, 'group_rule'::text]))),
    CONSTRAINT seller_resource_occupancies_spec_digest_check CHECK (((length(spec_digest) >= 1) AND (length(spec_digest) <= 128))),
    CONSTRAINT seller_resource_occupancies_state_check CHECK ((state = ANY (ARRAY['held'::text, 'released'::text])))
);

ALTER TABLE ONLY public.seller_resource_occupancies FORCE ROW LEVEL SECURITY;


--
-- Name: seller_upstream_writes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.seller_upstream_writes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id bigint NOT NULL,
    store_id bigint NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    state text DEFAULT 'dispatching'::text NOT NULL,
    response_status smallint,
    response_content_type text,
    response_retry_after text,
    response_body bytea,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    kind text DEFAULT 'proxy'::text NOT NULL,
    request_body jsonb,
    reconcile_after timestamp with time zone,
    probe_pass_count integer DEFAULT 0 NOT NULL,
    last_observation jsonb,
    error_code text,
    error_message text,
    heartbeat_at_ms bigint DEFAULT ((EXTRACT(epoch FROM clock_timestamp()) * (1000)::numeric))::bigint NOT NULL,
    physical_account_key text,
    observation_state text,
    observation_items jsonb,
    observation_next_at timestamp with time zone,
    observation_deadline_at timestamp with time zone,
    observation_passes integer DEFAULT 0 NOT NULL,
    observation_lease_token uuid,
    observation_lease_until timestamp with time zone,
    observation_lease_epoch bigint DEFAULT 0 NOT NULL,
    observation_revision bigint,
    observation_model_id bigint,
    CONSTRAINT seller_upstream_writes_key_nonempty CHECK (((char_length(idempotency_key) >= 1) AND (char_length(idempotency_key) <= 512))),
    CONSTRAINT seller_upstream_writes_observation_acronym CHECK (((physical_account_key IS NULL) OR (physical_account_key ~ '^sha256:[0-9a-f]{64}$'::text))),
    CONSTRAINT seller_upstream_writes_observation_due CHECK (((observation_state IS NULL) OR ((observation_state = 'pending'::text) AND (observation_next_at IS NOT NULL)) OR (observation_state = 'partial'::text) OR ((observation_state = ANY (ARRAY['applied'::text, 'rejected'::text, 'needs_review'::text])) AND (observation_next_at IS NULL)))),
    CONSTRAINT seller_upstream_writes_observation_passes CHECK ((observation_passes >= 0)),
    CONSTRAINT seller_upstream_writes_observation_state CHECK (((observation_state IS NULL) OR (observation_state = ANY (ARRAY['pending'::text, 'applied'::text, 'rejected'::text, 'partial'::text, 'needs_review'::text])))),
    CONSTRAINT seller_upstream_writes_response_shape CHECK ((((state = 'settled'::text) AND ((response_status >= 100) AND (response_status <= 599)) AND (response_body IS NOT NULL)) OR ((state <> 'settled'::text) AND (response_status IS NULL) AND (response_body IS NULL)))),
    CONSTRAINT seller_upstream_writes_state_known CHECK ((state = ANY (ARRAY['dispatching'::text, 'settled'::text, 'result_unknown'::text, 'reconciled'::text, 'conflict'::text])))
);

ALTER TABLE ONLY public.seller_upstream_writes FORCE ROW LEVEL SECURITY;


--
-- Name: shipping_inject_operations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shipping_inject_operations (
    id bigint NOT NULL,
    operation_id text NOT NULL,
    org_id bigint NOT NULL,
    store_uuid uuid NOT NULL,
    preset_id text NOT NULL,
    pinned_version bigint NOT NULL,
    phase text NOT NULL,
    status text NOT NULL,
    ozon_operation_id text,
    idempotency_key text NOT NULL,
    warehouse_id bigint,
    delivery_method_id bigint,
    warehouse_mutate_count integer DEFAULT 0 NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    created_by_account_uuid text NOT NULL,
    CONSTRAINT ck_shipping_inject_operations_mutate CHECK ((warehouse_mutate_count >= 0)),
    CONSTRAINT ck_shipping_inject_operations_phase CHECK ((phase = ANY (ARRAY['resolve'::text, 'create_warehouse'::text, 'update_warehouse'::text, 'update_delivery_method'::text, 'poll'::text, 'reconcile'::text, 'verify'::text]))),
    CONSTRAINT ck_shipping_inject_operations_pinned CHECK ((pinned_version >= 1)),
    CONSTRAINT ck_shipping_inject_operations_status CHECK ((status = ANY (ARRAY['queued'::text, 'submitting'::text, 'waiting'::text, 'succeeded'::text, 'failed'::text, 'unknown'::text])))
);


--
-- Name: shipping_inject_operations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.shipping_inject_operations ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.shipping_inject_operations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: shipping_preset_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shipping_preset_versions (
    id bigint NOT NULL,
    preset_id text NOT NULL,
    version bigint NOT NULL,
    payload jsonb NOT NULL,
    created_at_ms bigint NOT NULL,
    created_by_account_uuid text NOT NULL,
    CONSTRAINT ck_shipping_preset_versions_version CHECK ((version >= 1))
);


--
-- Name: shipping_preset_versions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.shipping_preset_versions ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.shipping_preset_versions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: shipping_presets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shipping_presets (
    id bigint NOT NULL,
    preset_id text NOT NULL,
    name text NOT NULL,
    current_version bigint NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    created_by_account_uuid text NOT NULL,
    CONSTRAINT ck_shipping_presets_current_version CHECK ((current_version >= 1))
);


--
-- Name: shipping_presets_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.shipping_presets ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.shipping_presets_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: shipping_shop_injections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shipping_shop_injections (
    id bigint NOT NULL,
    org_id bigint NOT NULL,
    store_uuid uuid NOT NULL,
    preset_id text NOT NULL,
    pinned_version bigint NOT NULL,
    status text NOT NULL,
    warehouse_id bigint,
    delivery_method_id bigint,
    delivery_method_status text,
    warehouse_mutate_count integer DEFAULT 0 NOT NULL,
    last_ozon_operation_id text,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    remote_absent_at_ms bigint,
    CONSTRAINT ck_shipping_shop_injections_mutate CHECK ((warehouse_mutate_count >= 0)),
    CONSTRAINT ck_shipping_shop_injections_pinned CHECK ((pinned_version >= 1)),
    CONSTRAINT ck_shipping_shop_injections_status CHECK ((status = ANY (ARRAY['queued'::text, 'submitting'::text, 'waiting'::text, 'succeeded'::text, 'failed'::text, 'unknown'::text])))
);


--
-- Name: shipping_shop_injections_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.shipping_shop_injections ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.shipping_shop_injections_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: shipping_sku_bindings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shipping_sku_bindings (
    id bigint NOT NULL,
    sku_id text NOT NULL,
    preset_id text NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    created_by_account_uuid text NOT NULL
);


--
-- Name: shipping_sku_bindings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.shipping_sku_bindings ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.shipping_sku_bindings_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: slice_r2_cleanup_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.slice_r2_cleanup_runs (
    bucket_fingerprint text NOT NULL,
    run_day date NOT NULL,
    status text NOT NULL,
    lease_token uuid,
    lease_epoch bigint NOT NULL,
    lease_until timestamp with time zone,
    started_at timestamp with time zone NOT NULL,
    window_deadline timestamp with time zone NOT NULL,
    next_attempt_at timestamp with time zone NOT NULL,
    api_calls integer DEFAULT 0 NOT NULL,
    api_results integer DEFAULT 0 NOT NULL,
    last_result_call integer DEFAULT 0 NOT NULL,
    deleted_acked bigint DEFAULT 0 NOT NULL,
    failed_objects bigint DEFAULT 0 NOT NULL,
    last_api_at timestamp with time zone,
    error_code text,
    completed_at timestamp with time zone,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT slice_cleanup_completion CHECK (((status = 'completed'::text) = (completed_at IS NOT NULL))),
    CONSTRAINT slice_cleanup_lease CHECK ((((status = 'running'::text) AND (lease_token IS NOT NULL) AND (lease_until IS NOT NULL)) OR ((status <> 'running'::text) AND (lease_token IS NULL) AND (lease_until IS NULL)))),
    CONSTRAINT slice_cleanup_lease_window CHECK ((lease_until <= window_deadline)),
    CONSTRAINT slice_cleanup_window CHECK (((window_deadline = ((run_day + '04:30:00'::time without time zone) AT TIME ZONE 'Asia/Shanghai'::text)) AND (started_at >= ((run_day + '04:00:00'::time without time zone) AT TIME ZONE 'Asia/Shanghai'::text)) AND (started_at < window_deadline))),
    CONSTRAINT slice_r2_cleanup_runs_api_calls_check CHECK (((api_calls >= 0) AND (api_calls <= 10000))),
    CONSTRAINT slice_r2_cleanup_runs_bucket_fingerprint_check CHECK ((bucket_fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT slice_r2_cleanup_runs_check CHECK (((api_results >= 0) AND (api_results <= api_calls))),
    CONSTRAINT slice_r2_cleanup_runs_check1 CHECK (((last_result_call >= 0) AND (last_result_call <= api_calls))),
    CONSTRAINT slice_r2_cleanup_runs_deleted_acked_check CHECK ((deleted_acked >= 0)),
    CONSTRAINT slice_r2_cleanup_runs_error_code_check CHECK ((error_code ~ '^[a-z][a-z0-9_]{0,63}$'::text)),
    CONSTRAINT slice_r2_cleanup_runs_failed_objects_check CHECK ((failed_objects >= 0)),
    CONSTRAINT slice_r2_cleanup_runs_lease_epoch_check CHECK ((lease_epoch > 0)),
    CONSTRAINT slice_r2_cleanup_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'partial'::text, 'completed'::text])))
);


--
-- Name: TABLE slice_r2_cleanup_runs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.slice_r2_cleanup_runs IS 'Platform bucket/day cleanup receipts: no tenant identifiers or object keys; shared physical bucket exclusion, daily prepaid API cap, and upload readiness fence.';


--
-- Name: storage_object_refs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.storage_object_refs (
    object_id uuid NOT NULL,
    owner_kind text NOT NULL,
    owner_id text NOT NULL,
    owner_org_id bigint,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT storage_object_refs_owner_id_check CHECK ((owner_id <> ''::text)),
    CONSTRAINT storage_object_refs_owner_kind_check CHECK ((owner_kind = ANY (ARRAY['psd_template'::text, 'delegate_asset'::text, 'dispatch'::text, 'source_product'::text, 'catalog_product'::text, 'catalog_sku'::text, 'ai_image_set'::text, 'ai_image_item'::text])))
);


--
-- Name: TABLE storage_object_refs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.storage_object_refs IS 'Explicit object references, maintained only by business-table triggers in the same transaction.';


--
-- Name: storage_objects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.storage_objects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    bucket text NOT NULL,
    bucket_identity text NOT NULL,
    object_key text NOT NULL,
    dedupe_scope text NOT NULL,
    owner_org_id bigint,
    sha256 bytea NOT NULL,
    byte_length bigint NOT NULL,
    content_type text NOT NULL,
    extension text NOT NULL,
    state text DEFAULT 'live'::text NOT NULL,
    retired_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT ck_storage_objects_private_owner CHECK (((bucket <> 'private'::text) OR (owner_org_id IS NOT NULL))),
    CONSTRAINT ck_storage_objects_retired CHECK (((state = 'deleted'::text) = (retired_at IS NOT NULL))),
    CONSTRAINT storage_objects_bucket_check CHECK ((bucket = ANY (ARRAY['assets'::text, 'private'::text]))),
    CONSTRAINT storage_objects_bucket_identity_check CHECK ((bucket_identity ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT storage_objects_byte_length_check CHECK ((byte_length > 0)),
    CONSTRAINT storage_objects_content_type_check CHECK ((content_type ~ '^[a-z0-9][a-z0-9.+-]*/[a-z0-9][a-z0-9.+-]*$'::text)),
    CONSTRAINT storage_objects_dedupe_scope_check CHECK (((dedupe_scope = 'catalog'::text) OR (dedupe_scope ~ '^source:[^[:space:]/:]+$'::text) OR (dedupe_scope ~ '^binding:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$'::text) OR (dedupe_scope ~ '^org:[0-9]+:(template|file|image)$'::text))),
    CONSTRAINT storage_objects_extension_check CHECK ((extension = ANY (ARRAY['jpg'::text, 'png'::text, 'webp'::text, 'psd'::text, 'mp4'::text, 'mov'::text]))),
    CONSTRAINT storage_objects_object_key_check CHECK (((object_key <> ''::text) AND (object_key !~ '(^|/)\.\.?(/|$)'::text))),
    CONSTRAINT storage_objects_sha256_check CHECK ((octet_length(sha256) = 32)),
    CONSTRAINT storage_objects_state_check CHECK ((state = ANY (ARRAY['live'::text, 'deleting'::text, 'deleted'::text])))
);


--
-- Name: TABLE storage_objects; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.storage_objects IS 'Content-addressed registry for long-lived buckets. Tombstones keep the key from being resurrected.';


--
-- Name: storage_uploads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.storage_uploads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    actor_id bigint NOT NULL,
    org_id bigint,
    purpose_kind text NOT NULL,
    purpose_id text NOT NULL,
    bucket text NOT NULL,
    bucket_identity text NOT NULL,
    object_key text NOT NULL,
    dedupe_scope text NOT NULL,
    sha256 bytea NOT NULL,
    byte_length bigint NOT NULL,
    content_type text NOT NULL,
    extension text NOT NULL,
    multipart_id text,
    state text DEFAULT 'pending'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    confirmed_at timestamp with time zone,
    object_id uuid,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT ck_storage_uploads_confirmed CHECK (((state <> 'confirmed'::text) OR ((object_id IS NOT NULL) AND (confirmed_at IS NOT NULL)))),
    CONSTRAINT storage_uploads_bucket_check CHECK ((bucket = ANY (ARRAY['assets'::text, 'private'::text]))),
    CONSTRAINT storage_uploads_bucket_identity_check CHECK ((bucket_identity ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT storage_uploads_byte_length_check CHECK ((byte_length > 0)),
    CONSTRAINT storage_uploads_extension_check CHECK ((extension = ANY (ARRAY['jpg'::text, 'png'::text, 'webp'::text, 'psd'::text, 'mp4'::text, 'mov'::text]))),
    CONSTRAINT storage_uploads_object_key_check CHECK ((object_key <> ''::text)),
    CONSTRAINT storage_uploads_purpose_kind_check CHECK ((purpose_kind = ANY (ARRAY['org_file'::text, 'org_template'::text, 'delegate_binding'::text, 'source'::text, 'catalog'::text, 'listing_image'::text]))),
    CONSTRAINT storage_uploads_sha256_check CHECK ((octet_length(sha256) = 32)),
    CONSTRAINT storage_uploads_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'confirmed'::text, 'expired'::text, 'aborted'::text, 'superseded'::text])))
);


--
-- Name: store_credential_verifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.store_credential_verifications (
    org_id bigint NOT NULL,
    store_id bigint NOT NULL,
    user_id bigint NOT NULL,
    credential_revision bigint NOT NULL,
    verified boolean NOT NULL,
    verified_at_ms bigint NOT NULL,
    failure_code character varying(128),
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT ck_store_credential_verifications_credential_revision CHECK ((credential_revision >= 1)),
    CONSTRAINT ck_store_credential_verifications_failure_code CHECK (((failure_code IS NULL) OR (((length(btrim((failure_code)::text)) >= 1) AND (length(btrim((failure_code)::text)) <= 128)) AND ((failure_code)::text !~ '[[:space:]]'::text)))),
    CONSTRAINT ck_store_credential_verifications_verified_at_ms CHECK ((verified_at_ms >= 0))
);


--
-- Name: store_product_metrics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.store_product_metrics (
    org_id bigint NOT NULL,
    store_pk bigint NOT NULL,
    sku bigint NOT NULL,
    hits_view double precision NOT NULL,
    session_view double precision NOT NULL,
    hits_tocart double precision NOT NULL,
    conv_tocart double precision NOT NULL,
    ordered_units double precision NOT NULL,
    revenue double precision NOT NULL,
    period_days smallint NOT NULL,
    through_day date NOT NULL,
    fetched_at_ms bigint NOT NULL,
    fetched_generation bigint NOT NULL,
    fx_quote text,
    fx_rate double precision,
    fx_as_of date,
    fx_source text,
    CONSTRAINT store_product_metrics_fx CHECK ((((fx_quote IS NULL) AND (fx_rate IS NULL) AND (fx_as_of IS NULL) AND (fx_source IS NULL)) OR ((fx_quote ~ '^[A-Z]{3}$'::text) AND (fx_quote <> 'RUB'::text) AND (fx_rate > (0)::double precision) AND (fx_rate <> 'NaN'::double precision) AND (fx_rate < 'Infinity'::double precision) AND (fx_as_of IS NOT NULL) AND (fx_source = 'cbr'::text)))),
    CONSTRAINT store_product_metrics_nonneg CHECK (((hits_view >= (0)::double precision) AND (hits_view <> 'NaN'::double precision) AND (hits_view < 'Infinity'::double precision) AND (session_view >= (0)::double precision) AND (session_view <> 'NaN'::double precision) AND (session_view < 'Infinity'::double precision) AND (hits_tocart >= (0)::double precision) AND (hits_tocart <> 'NaN'::double precision) AND (hits_tocart < 'Infinity'::double precision) AND (conv_tocart >= (0)::double precision) AND (conv_tocart <> 'NaN'::double precision) AND (conv_tocart < 'Infinity'::double precision) AND (ordered_units >= (0)::double precision) AND (ordered_units <> 'NaN'::double precision) AND (ordered_units < 'Infinity'::double precision) AND (revenue >= (0)::double precision) AND (revenue <> 'NaN'::double precision) AND (revenue < 'Infinity'::double precision)))
);

ALTER TABLE ONLY public.store_product_metrics FORCE ROW LEVEL SECURITY;


--
-- Name: store_product_pass_pages; Type: TABLE; Schema: public; Owner: -
--

CREATE UNLOGGED TABLE public.store_product_pass_pages (
    store_pk bigint NOT NULL,
    generation bigint NOT NULL,
    page_no integer NOT NULL,
    archived boolean NOT NULL,
    product_ids bigint[] NOT NULL,
    detailed_at_ms bigint,
    CONSTRAINT store_product_pass_pages_generation CHECK ((generation > 0))
);


--
-- Name: store_product_sync; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.store_product_sync (
    org_id bigint NOT NULL,
    store_id uuid NOT NULL,
    refresh_generation bigint NOT NULL,
    cursor_last_id text,
    last_full_sync_at_ms bigint,
    next_due_at_ms bigint,
    manual_requested_at_ms bigint,
    consecutive_failures integer DEFAULT 0 NOT NULL,
    count_total bigint,
    count_on_sale bigint,
    count_hidden bigint,
    count_moderation_failed bigint,
    count_zero_stock bigint,
    count_archived bigint,
    last_verify_at_ms bigint,
    last_verify_digest text,
    inflight_token uuid,
    inflight_until_ms bigint,
    pass text DEFAULT 'none'::text NOT NULL,
    hold text DEFAULT 'none'::text NOT NULL,
    hold_until_ms bigint,
    hold_reason text,
    calls_day date,
    calls_reconcile integer DEFAULT 0 NOT NULL,
    calls_manual integer DEFAULT 0 NOT NULL,
    generation_started_at_ms bigint,
    currency text,
    pass_pages_live integer DEFAULT 0 NOT NULL,
    pass_pages_archived integer DEFAULT 0 NOT NULL,
    metrics_offset bigint DEFAULT 0 NOT NULL,
    metrics_at_ms bigint,
    metrics_error text,
    count_processing bigint,
    count_delisted bigint,
    CONSTRAINT store_product_sync_calls_nonneg CHECK (((calls_reconcile >= 0) AND (calls_manual >= 0))),
    CONSTRAINT store_product_sync_calls_purpose_shape CHECK (((calls_day IS NULL) = ((calls_reconcile = 0) AND (calls_manual = 0)))),
    CONSTRAINT store_product_sync_counts_shape CHECK ((((count_total IS NULL) AND (count_on_sale IS NULL) AND (count_processing IS NULL) AND (count_hidden IS NULL) AND (count_moderation_failed IS NULL) AND (count_zero_stock IS NULL) AND (count_archived IS NULL) AND (count_delisted IS NULL)) OR ((count_total IS NOT NULL) AND (count_on_sale IS NOT NULL) AND (count_processing IS NOT NULL) AND (count_hidden IS NOT NULL) AND (count_moderation_failed IS NOT NULL) AND (count_zero_stock IS NOT NULL) AND (count_archived IS NOT NULL) AND (count_delisted IS NOT NULL) AND (count_total >= 0) AND (count_on_sale >= 0) AND (count_processing >= 0) AND (count_hidden >= 0) AND (count_moderation_failed >= 0) AND (count_zero_stock >= 0) AND (count_archived >= 0) AND (count_delisted >= 0)))),
    CONSTRAINT store_product_sync_failures CHECK ((consecutive_failures >= 0)),
    CONSTRAINT store_product_sync_generation CHECK ((refresh_generation > 0)),
    CONSTRAINT store_product_sync_generation_start CHECK (((generation_started_at_ms IS NULL) OR (generation_started_at_ms > 0))),
    CONSTRAINT store_product_sync_hold CHECK ((hold = ANY (ARRAY['none'::text, 'yield'::text, 'backoff'::text, 'budget'::text, 'cooldown'::text, 'credential'::text, 'disabled'::text]))),
    CONSTRAINT store_product_sync_hold_reason CHECK (((hold_reason IS NULL) OR (hold_reason = ANY (ARRAY['rate_limited'::text, 'generation_expired'::text, 'credential_revoked'::text, 'credential_expired'::text, 'ip_restricted'::text, 'workspace_breaker'::text, 'deployment_breaker'::text, 'egress_blocked'::text, 'store_busy'::text, 'seller_error'::text, 'budget_exhausted'::text, 'store_disabled'::text, 'staging_lost'::text])))),
    CONSTRAINT store_product_sync_hold_shape CHECK (((hold = 'none'::text) = (hold_until_ms IS NULL))),
    CONSTRAINT store_product_sync_inflight_shape CHECK (((inflight_token IS NULL) = (inflight_until_ms IS NULL))),
    CONSTRAINT store_product_sync_metrics_error CHECK (((metrics_error IS NULL) OR (metrics_error = ANY (ARRAY['rate_limited'::text, 'restricted'::text, 'refused'::text, 'invalid'::text, 'unavailable'::text])))),
    CONSTRAINT store_product_sync_pass CHECK ((pass = ANY (ARRAY['none'::text, 'list_live'::text, 'list_archived'::text, 'detail'::text, 'commit'::text]))),
    CONSTRAINT store_product_sync_verify_shape CHECK (((last_verify_at_ms IS NULL) = (last_verify_digest IS NULL)))
);

ALTER TABLE ONLY public.store_product_sync FORCE ROW LEVEL SECURITY;


--
-- Name: store_products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.store_products (
    org_id bigint NOT NULL,
    product_id bigint NOT NULL,
    offer_id text NOT NULL,
    sku bigint,
    name text,
    price numeric,
    old_price numeric,
    stock_present integer,
    stock_reserved integer,
    gone_at_ms bigint,
    status_id smallint,
    content_hash bigint DEFAULT 0 NOT NULL,
    refreshed_at_ms bigint,
    evidence_at_ms bigint,
    store_pk bigint NOT NULL,
    primary_image text,
    model_id bigint,
    model_count bigint,
    description_category_id bigint,
    type_id bigint,
    variant_attributes jsonb,
    variant_observed_at_ms bigint,
    variant_observed_revision bigint,
    variant_source text,
    CONSTRAINT store_products_group_facts_positive CHECK ((((model_id IS NULL) OR (model_id > 0)) AND ((model_count IS NULL) OR (model_count > 0)) AND ((description_category_id IS NULL) OR (description_category_id > 0)) AND ((type_id IS NULL) OR (type_id > 0)))),
    CONSTRAINT store_products_variant_attributes_array CHECK (((variant_attributes IS NULL) OR (jsonb_typeof(variant_attributes) = 'array'::text))),
    CONSTRAINT store_products_variant_observation_complete CHECK ((((variant_observed_at_ms IS NULL) = (variant_source IS NULL)) AND ((variant_source IS NULL) OR (variant_source = 'attributes'::text))))
)
WITH (fillfactor='90');

ALTER TABLE ONLY public.store_products FORCE ROW LEVEL SECURITY;


--
-- Name: store_rating_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.store_rating_history (
    id bigint NOT NULL,
    org_id bigint NOT NULL,
    store_id uuid NOT NULL,
    rating_key text NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    value_type text DEFAULT ''::text NOT NULL,
    status text DEFAULT ''::text NOT NULL,
    current_value numeric,
    past_value numeric,
    recorded_at timestamp with time zone NOT NULL,
    CONSTRAINT store_rating_history_clean CHECK (((rating_key !~* '(fixture-api-key|api[-_]?key|bearer |sk-|client[-_]?id|signature=|x-amz-)'::text) AND (name !~* '(fixture-api-key|api[-_]?key|bearer |sk-|client[-_]?id|signature=|x-amz-)'::text) AND (value_type !~* '(fixture-api-key|api[-_]?key|bearer |sk-|client[-_]?id|signature=|x-amz-)'::text) AND (status !~* '(fixture-api-key|api[-_]?key|bearer |sk-|client[-_]?id|signature=|x-amz-)'::text))),
    CONSTRAINT store_rating_history_key_len CHECK (((char_length(rating_key) >= 1) AND (char_length(rating_key) <= 128))),
    CONSTRAINT store_rating_history_org CHECK ((org_id > 0)),
    CONSTRAINT store_rating_history_text_len CHECK (((char_length(name) <= 400) AND (char_length(value_type) <= 64) AND (char_length(status) <= 64)))
);

ALTER TABLE ONLY public.store_rating_history FORCE ROW LEVEL SECURITY;


--
-- Name: store_rating_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.store_rating_history ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.store_rating_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: store_rating_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.store_rating_snapshots (
    org_id bigint NOT NULL,
    store_id uuid NOT NULL,
    rating_key text NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    value_type text DEFAULT ''::text NOT NULL,
    status text DEFAULT ''::text NOT NULL,
    current_value numeric,
    past_value numeric,
    synced_at timestamp with time zone NOT NULL,
    CONSTRAINT store_rating_snapshots_clean CHECK (((rating_key !~* '(fixture-api-key|api[-_]?key|bearer |sk-|client[-_]?id|signature=|x-amz-)'::text) AND (name !~* '(fixture-api-key|api[-_]?key|bearer |sk-|client[-_]?id|signature=|x-amz-)'::text) AND (value_type !~* '(fixture-api-key|api[-_]?key|bearer |sk-|client[-_]?id|signature=|x-amz-)'::text) AND (status !~* '(fixture-api-key|api[-_]?key|bearer |sk-|client[-_]?id|signature=|x-amz-)'::text))),
    CONSTRAINT store_rating_snapshots_key_len CHECK (((char_length(rating_key) >= 1) AND (char_length(rating_key) <= 128))),
    CONSTRAINT store_rating_snapshots_org CHECK ((org_id > 0)),
    CONSTRAINT store_rating_snapshots_text_len CHECK (((char_length(name) <= 400) AND (char_length(value_type) <= 64) AND (char_length(status) <= 64)))
);

ALTER TABLE ONLY public.store_rating_snapshots FORCE ROW LEVEL SECURITY;


--
-- Name: store_rating_sync; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.store_rating_sync (
    org_id bigint NOT NULL,
    store_id uuid NOT NULL,
    synced_at timestamp with time zone,
    lease_until timestamp with time zone,
    CONSTRAINT store_rating_sync_org CHECK ((org_id > 0))
);

ALTER TABLE ONLY public.store_rating_sync FORCE ROW LEVEL SECURITY;


--
-- Name: store_seller_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.store_seller_credentials (
    store_id bigint NOT NULL,
    org_id bigint NOT NULL,
    credential_revision bigint NOT NULL,
    client_id character varying(128),
    key_id character varying(64) NOT NULL,
    nonce bytea NOT NULL,
    ciphertext bytea NOT NULL,
    key_fingerprint bytea NOT NULL,
    registered_by_user_id bigint NOT NULL,
    registered_at_ms bigint NOT NULL,
    rotated_at_ms bigint,
    last_leased_at_ms bigint,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    key_expires_at_ms bigint,
    wrapped_dek bytea,
    dek_nonce bytea,
    envelope_version smallint DEFAULT 1 NOT NULL,
    CONSTRAINT ck_store_seller_credentials_ciphertext CHECK (((octet_length(ciphertext) >= 17) AND (octet_length(ciphertext) <= 4096))),
    CONSTRAINT ck_store_seller_credentials_envelope CHECK ((((envelope_version = 1) AND (client_id IS NOT NULL) AND (length(btrim((client_id)::text)) > 0) AND (wrapped_dek IS NULL) AND (dek_nonce IS NULL)) OR ((envelope_version = 2) AND (client_id IS NULL) AND (octet_length(wrapped_dek) = 48) AND (octet_length(dek_nonce) = 12)))),
    CONSTRAINT ck_store_seller_credentials_fingerprint CHECK ((octet_length(key_fingerprint) = 32)),
    CONSTRAINT ck_store_seller_credentials_nonce CHECK ((octet_length(nonce) = 12)),
    CONSTRAINT ck_store_seller_credentials_revision CHECK ((credential_revision >= 1))
);


--
-- Name: store_tag_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.store_tag_links (
    org_id bigint NOT NULL,
    store_id bigint NOT NULL,
    tag_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);


--
-- Name: store_tombstone_consumptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.store_tombstone_consumptions (
    org_id bigint NOT NULL,
    store_id bigint NOT NULL,
    user_id bigint NOT NULL,
    consumed_at_ms bigint NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT ck_store_tombstone_consumptions_consumed_at_ms CHECK ((consumed_at_ms >= 0))
);


--
-- Name: submission_intents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.submission_intents (
    id uuid NOT NULL,
    org_id bigint NOT NULL,
    store_id uuid NOT NULL,
    listing_row_id uuid NOT NULL,
    row_revision bigint NOT NULL,
    client_operation_id text NOT NULL,
    request_hash text NOT NULL,
    state text NOT NULL,
    external_task_id text,
    last_error_code text,
    reconcile_after timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    cancel_requested_at timestamp with time zone,
    reconciliation_outcome jsonb,
    submission_issues jsonb DEFAULT '[]'::jsonb NOT NULL,
    offer_id text,
    reconcile_claim_until timestamp with time zone,
    reconcile_epoch bigint DEFAULT 0 NOT NULL,
    submission_receipt jsonb,
    card_id uuid,
    credential_granted_at timestamp with time zone,
    revoked_at timestamp with time zone,
    CONSTRAINT submission_intents_state_known CHECK ((state = ANY (ARRAY['queued'::text, 'submitting'::text, 'unknown'::text, 'accepted'::text, 'rejected'::text, 'cancelled'::text, 'reconciled'::text, 'conflict'::text, 'operator_attested'::text, 'superseded'::text]))),
    CONSTRAINT submission_intents_submission_issues_check CHECK (((jsonb_typeof(submission_issues) = 'array'::text) AND (jsonb_array_length(submission_issues) <= 8)))
);

ALTER TABLE ONLY public.submission_intents FORCE ROW LEVEL SECURITY;


--
-- Name: subscription_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscription_events (
    id bigint NOT NULL,
    org_id bigint NOT NULL,
    order_id bigint,
    kind text NOT NULL,
    effective_at timestamp with time zone NOT NULL,
    plan_from text,
    plan_to text,
    stores_delta integer DEFAULT 0 NOT NULL,
    term_start timestamp with time zone,
    term_end timestamp with time zone,
    amount_cents bigint DEFAULT 0 NOT NULL,
    breakdown jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT subscription_events_kind_check CHECK ((kind = ANY (ARRAY['subscribe'::text, 'renew'::text, 'change'::text, 'keep'::text, 'expire'::text, 'drain'::text, 'drain_done'::text, 'redeem'::text])))
);

ALTER TABLE ONLY public.subscription_events FORCE ROW LEVEL SECURITY;


--
-- Name: subscription_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.subscription_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: subscription_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.subscription_events_id_seq OWNED BY public.subscription_events.id;


--
-- Name: subscription_periods; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscription_periods (
    id bigint NOT NULL,
    org_id bigint NOT NULL,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone NOT NULL,
    plan_key text NOT NULL,
    stores integer NOT NULL,
    store_monthly_cents bigint NOT NULL,
    keep_store_ids uuid[],
    order_id bigint,
    CONSTRAINT subscription_periods_check CHECK ((ends_at > starts_at)),
    CONSTRAINT subscription_periods_store_monthly_cents_check CHECK ((store_monthly_cents >= 0)),
    CONSTRAINT subscription_periods_stores_check CHECK ((stores >= 1))
);

ALTER TABLE ONLY public.subscription_periods FORCE ROW LEVEL SECURITY;


--
-- Name: subscription_periods_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.subscription_periods_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: subscription_periods_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.subscription_periods_id_seq OWNED BY public.subscription_periods.id;


--
-- Name: subscription_quotes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscription_quotes (
    id uuid NOT NULL,
    org_id bigint NOT NULL,
    revision bigint NOT NULL,
    action text NOT NULL,
    months integer NOT NULL,
    term_start timestamp with time zone,
    term_end timestamp with time zone,
    plan_key text NOT NULL,
    stores integer NOT NULL,
    keep_store_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    amount_cents bigint NOT NULL,
    breakdown jsonb NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT subscription_quotes_action_check CHECK ((action = ANY (ARRAY['subscribe'::text, 'renew'::text, 'change'::text, 'keep'::text]))),
    CONSTRAINT subscription_quotes_amount_cents_check CHECK ((amount_cents >= 0)),
    CONSTRAINT subscription_quotes_stores_check CHECK ((stores >= 1)),
    CONSTRAINT subscription_quotes_months_check CHECK ((months = ANY (ARRAY[1, 3, 6, 12])))
);

ALTER TABLE ONLY public.subscription_quotes FORCE ROW LEVEL SECURITY;


--
-- Name: subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscriptions (
    org_id bigint NOT NULL,
    status text NOT NULL,
    plan_key text NOT NULL,
    term_start timestamp with time zone,
    term_end timestamp with time zone,
    stores integer DEFAULT 1 NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    billing_anchor timestamp with time zone,
    billing_timezone text DEFAULT 'Asia/Shanghai'::text NOT NULL,
    CONSTRAINT subscriptions_billing_timezone_check CHECK ((billing_timezone = 'Asia/Shanghai'::text)),
    CONSTRAINT subscriptions_stores_check CHECK ((stores >= 1)),
    CONSTRAINT subscriptions_plan_not_free CHECK (((status = 'free'::text) OR (plan_key <> 'free'::text))),
    CONSTRAINT subscriptions_revision_check CHECK ((revision > 0)),
    CONSTRAINT subscriptions_status_check CHECK ((status = ANY (ARRAY['free'::text, 'active'::text, 'expired'::text]))),
    CONSTRAINT subscriptions_term_order CHECK (((term_end IS NULL) OR (term_end > term_start))),
    CONSTRAINT subscriptions_term_shape CHECK ((((status = 'free'::text) AND (term_start IS NULL) AND (term_end IS NULL)) OR ((status = ANY (ARRAY['active'::text, 'expired'::text])) AND (term_start IS NOT NULL) AND (term_end IS NOT NULL))))
);

ALTER TABLE ONLY public.subscriptions FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE subscriptions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.subscriptions IS 'One row per workspace. term_end is the only expiry fact; capacity changes never move it.';


--
-- Name: supplier_media_objects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supplier_media_objects (
    product_id text NOT NULL,
    source_id text NOT NULL,
    object_key text NOT NULL,
    public_url text NOT NULL,
    media_kind character varying(16) NOT NULL,
    extension character varying(8) NOT NULL,
    content_sha256 character varying(64) NOT NULL,
    byte_length bigint NOT NULL,
    integration_revision bigint NOT NULL,
    verified_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT supplier_media_objects_byte_length_positive CHECK ((byte_length > 0)),
    CONSTRAINT supplier_media_objects_digest_shape CHECK (((content_sha256)::text ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT supplier_media_objects_extension_known CHECK (((extension)::text = ANY ((ARRAY['jpg'::character varying, 'png'::character varying, 'webp'::character varying, 'psd'::character varying, 'mp4'::character varying, 'mov'::character varying])::text[]))),
    CONSTRAINT supplier_media_objects_integration_revision_positive CHECK ((integration_revision > 0)),
    CONSTRAINT supplier_media_objects_kind_known CHECK (((media_kind)::text = ANY ((ARRAY['gallery'::character varying, 'psd'::character varying, 'video'::character varying])::text[])))
);


--
-- Name: supplier_ozon_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supplier_ozon_configs (
    product_id text NOT NULL,
    description_category_id bigint NOT NULL,
    type_id bigint NOT NULL,
    language character varying(16) DEFAULT 'default'::character varying NOT NULL,
    "values" jsonb DEFAULT '{}'::jsonb NOT NULL,
    fixed_tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    prompt_text text DEFAULT ''::text NOT NULL,
    ai_output jsonb DEFAULT '{"tags": true, "title": true, "description": true}'::jsonb NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    state character varying(32) DEFAULT 'needs_reconfiguration'::character varying NOT NULL,
    validated_catalog_digest character varying(71),
    issues jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    created_by_account_uuid text NOT NULL,
    updated_by_account_uuid text NOT NULL,
    published_revision integer,
    CONSTRAINT supplier_ozon_configs_ai_output_object CHECK ((jsonb_typeof(ai_output) = 'object'::text)),
    CONSTRAINT supplier_ozon_configs_coordinate_positive CHECK (((description_category_id > 0) AND (type_id > 0))),
    CONSTRAINT supplier_ozon_configs_digest_shape CHECK (((validated_catalog_digest IS NULL) OR ((validated_catalog_digest)::text ~ '^sha256:[0-9a-f]{64}$'::text))),
    CONSTRAINT supplier_ozon_configs_fixed_tags_array CHECK ((jsonb_typeof(fixed_tags) = 'array'::text)),
    CONSTRAINT supplier_ozon_configs_issues_array CHECK ((jsonb_typeof(issues) = 'array'::text)),
    CONSTRAINT supplier_ozon_configs_language_known CHECK (((language)::text = ANY ((ARRAY['default'::character varying, 'ru'::character varying, 'en'::character varying, 'tr'::character varying, 'zh_hans'::character varying])::text[]))),
    CONSTRAINT supplier_ozon_configs_published_revision_positive CHECK (((published_revision IS NULL) OR (published_revision > 0))),
    CONSTRAINT supplier_ozon_configs_revision_positive CHECK ((revision > 0)),
    CONSTRAINT supplier_ozon_configs_state_known CHECK (((state)::text = ANY ((ARRAY['valid'::character varying, 'needs_reconfiguration'::character varying])::text[]))),
    CONSTRAINT supplier_ozon_configs_valid_has_current_stamp CHECK ((((state)::text <> 'valid'::text) OR ((validated_catalog_digest IS NOT NULL) AND (issues = '[]'::jsonb)))),
    CONSTRAINT supplier_ozon_configs_values_object CHECK ((jsonb_typeof("values") = 'object'::text))
);


--
-- Name: supplier_wallet_ledger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supplier_wallet_ledger (
    ledger_id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_id text NOT NULL,
    entry_type text NOT NULL,
    idempotency_key text NOT NULL,
    amount_microfen bigint NOT NULL,
    held_delta_microfen bigint NOT NULL,
    balance_after_microfen bigint NOT NULL,
    held_after_microfen bigint NOT NULL,
    created_at_ms bigint NOT NULL,
    CONSTRAINT ck_supplier_wallet_ledger_type CHECK ((entry_type = ANY (ARRAY['credit'::text, 'withdrawal_hold'::text, 'withdrawal_paid'::text, 'withdrawal_release'::text])))
);

ALTER TABLE ONLY public.supplier_wallet_ledger FORCE ROW LEVEL SECURITY;


--
-- Name: supplier_wallets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supplier_wallets (
    source_id text NOT NULL,
    balance_microfen bigint DEFAULT 0 NOT NULL,
    held_microfen bigint DEFAULT 0 NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT ck_supplier_wallets_balance CHECK ((balance_microfen >= 0)),
    CONSTRAINT ck_supplier_wallets_held CHECK ((held_microfen >= 0)),
    CONSTRAINT ck_supplier_wallets_held_within CHECK ((held_microfen <= balance_microfen))
);

ALTER TABLE ONLY public.supplier_wallets FORCE ROW LEVEL SECURITY;


--
-- Name: supplier_withdrawals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supplier_withdrawals (
    withdrawal_id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_id text NOT NULL,
    amount_cents bigint NOT NULL,
    amount_microfen bigint NOT NULL,
    channel text NOT NULL,
    account text NOT NULL,
    real_name text NOT NULL,
    status text NOT NULL,
    reference text,
    reject_reason text,
    requested_at_ms bigint NOT NULL,
    decided_at_ms bigint,
    CONSTRAINT ck_supplier_withdrawals_amount CHECK (((amount_cents > 0) AND (amount_microfen = (amount_cents * 1000000)))),
    CONSTRAINT ck_supplier_withdrawals_channel CHECK ((channel = ANY (ARRAY['alipay'::text, 'wechat'::text, 'bank'::text]))),
    CONSTRAINT ck_supplier_withdrawals_status CHECK ((status = ANY (ARRAY['requested'::text, 'paid'::text, 'rejected'::text])))
);

ALTER TABLE ONLY public.supplier_withdrawals FORCE ROW LEVEL SECURITY;


--
-- Name: support_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_grants (
    id bigint NOT NULL,
    org_id bigint NOT NULL,
    staff_user_id bigint NOT NULL,
    reason text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_by_user_id bigint NOT NULL,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT support_grants_reason_not_blank CHECK ((btrim(reason) <> ''::text))
);


--
-- Name: support_grants_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.support_grants ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.support_grants_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: transit_clear_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transit_clear_runs (
    bucket_identity text NOT NULL,
    run_day date NOT NULL,
    status text NOT NULL,
    lease_token uuid,
    lease_epoch bigint NOT NULL,
    lease_until timestamp with time zone,
    started_at timestamp with time zone NOT NULL,
    next_attempt_at timestamp with time zone NOT NULL,
    api_calls integer DEFAULT 0 NOT NULL,
    api_results integer DEFAULT 0 NOT NULL,
    last_result_call integer DEFAULT 0 NOT NULL,
    deleted_acked bigint DEFAULT 0 NOT NULL,
    failed_objects bigint DEFAULT 0 NOT NULL,
    last_api_at timestamp with time zone,
    error_code text,
    completed_at timestamp with time zone,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT transit_clear_completion CHECK (((status = 'completed'::text) = (completed_at IS NOT NULL))),
    CONSTRAINT transit_clear_lease CHECK ((((status = 'running'::text) AND (lease_token IS NOT NULL) AND (lease_until IS NOT NULL)) OR ((status <> 'running'::text) AND (lease_token IS NULL) AND (lease_until IS NULL)))),
    CONSTRAINT transit_clear_runs_api_calls_check CHECK (((api_calls >= 0) AND (api_calls <= 1000000))),
    CONSTRAINT transit_clear_runs_bucket_identity_check CHECK ((bucket_identity ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT transit_clear_runs_check CHECK (((api_results >= 0) AND (api_results <= api_calls))),
    CONSTRAINT transit_clear_runs_check1 CHECK (((last_result_call >= 0) AND (last_result_call <= api_calls))),
    CONSTRAINT transit_clear_runs_deleted_acked_check CHECK ((deleted_acked >= 0)),
    CONSTRAINT transit_clear_runs_error_code_check CHECK ((error_code ~ '^[a-z][a-z0-9_]{0,63}$'::text)),
    CONSTRAINT transit_clear_runs_failed_objects_check CHECK ((failed_objects >= 0)),
    CONSTRAINT transit_clear_runs_lease_epoch_check CHECK ((lease_epoch > 0)),
    CONSTRAINT transit_clear_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'partial'::text, 'completed'::text]))),
    CONSTRAINT transit_clear_started_after_boundary CHECK ((started_at >= ((run_day + '04:00:00'::time without time zone) AT TIME ZONE 'Asia/Shanghai'::text)))
);


--
-- Name: TABLE transit_clear_runs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.transit_clear_runs IS 'Transit bucket daily clear receipts: no tenant identifiers and no object keys.';


--
-- Name: user_wallets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_wallets (
    user_id bigint NOT NULL,
    balance_microfen bigint DEFAULT 0 NOT NULL,
    held_microfen bigint DEFAULT 0 NOT NULL,
    version bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT user_wallets_balance_microfen_check CHECK ((balance_microfen >= 0)),
    CONSTRAINT user_wallets_check CHECK (((held_microfen >= 0) AND (held_microfen <= balance_microfen)))
);

ALTER TABLE ONLY public.user_wallets FORCE ROW LEVEL SECURITY;


--
-- Name: wallet_ledger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wallet_ledger (
    id bigint NOT NULL,
    org_id bigint NOT NULL,
    entry_type character varying(32) NOT NULL,
    idempotency_key character varying(512) NOT NULL,
    amount_microfen bigint NOT NULL,
    held_delta_microfen bigint NOT NULL,
    balance_before_microfen bigint NOT NULL,
    balance_after_microfen bigint NOT NULL,
    held_before_microfen bigint NOT NULL,
    held_after_microfen bigint NOT NULL,
    ai_request_id bigint,
    payment_order_id bigint,
    note text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    user_id bigint NOT NULL,
    CONSTRAINT wallet_ledger_balance_applies CHECK ((balance_after_microfen = (balance_before_microfen + amount_microfen))),
    CONSTRAINT wallet_ledger_held_applies CHECK ((held_after_microfen = (held_before_microfen + held_delta_microfen))),
    CONSTRAINT wallet_ledger_nonneg_after CHECK (((balance_after_microfen >= 0) AND (held_after_microfen >= 0))),
    CONSTRAINT wallet_ledger_type_known CHECK (((entry_type)::text = ANY ((ARRAY['topup'::character varying, 'hold'::character varying, 'settle'::character varying, 'release'::character varying, 'refund'::character varying, 'adjustment'::character varying])::text[])))
);

ALTER TABLE ONLY public.wallet_ledger FORCE ROW LEVEL SECURITY;


--
-- Name: wallet_ledger_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.wallet_ledger_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: wallet_ledger_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.wallet_ledger_id_seq OWNED BY public.wallet_ledger.id;


--
-- Name: wb_category_current; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_category_current (
    subject_id bigint NOT NULL,
    language text NOT NULL,
    parent_id bigint NOT NULL,
    subject_name text NOT NULL,
    parent_name text NOT NULL,
    fields jsonb NOT NULL,
    content_digest text NOT NULL,
    fetched_at_ms bigint NOT NULL,
    CONSTRAINT wb_category_current_content_digest_check CHECK ((content_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT wb_category_current_fetched_at_ms_check CHECK ((fetched_at_ms > 0)),
    CONSTRAINT wb_category_current_fields_check CHECK ((jsonb_typeof(fields) = 'array'::text)),
    CONSTRAINT wb_category_current_language_check CHECK ((language = ANY (ARRAY['ru'::text, 'en'::text, 'zh'::text]))),
    CONSTRAINT wb_category_current_parent_id_check CHECK ((parent_id > 0)),
    CONSTRAINT wb_category_current_subject_id_check CHECK ((subject_id > 0))
);


--
-- Name: wb_category_field_defaults; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_category_field_defaults (
    subject_id bigint NOT NULL,
    language text NOT NULL,
    characteristics jsonb DEFAULT '{}'::jsonb NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    validated_catalog_digest text NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT wb_category_field_defaults_characteristics_check CHECK ((jsonb_typeof(characteristics) = 'object'::text)),
    CONSTRAINT wb_category_field_defaults_revision_check CHECK ((revision > 0)),
    CONSTRAINT wb_category_field_defaults_updated_at_ms_check CHECK ((updated_at_ms > 0)),
    CONSTRAINT wb_category_field_defaults_validated_catalog_digest_check CHECK ((validated_catalog_digest ~ '^sha256:[0-9a-f]{64}$'::text))
);


--
-- Name: workspace_psd_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_psd_templates (
    id uuid NOT NULL,
    org_id bigint NOT NULL,
    created_by bigint NOT NULL,
    description_category_id bigint NOT NULL,
    type_id bigint NOT NULL,
    sha256 text NOT NULL,
    file_name text NOT NULL,
    byte_length bigint NOT NULL,
    storage_identity text NOT NULL,
    object_key text NOT NULL,
    verified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    object_id uuid,
    original_name text,
    CONSTRAINT workspace_psd_templates_byte_length_check CHECK (((byte_length >= 26) AND (byte_length <= 524288000))),
    CONSTRAINT workspace_psd_templates_description_category_id_check CHECK ((description_category_id > 0)),
    CONSTRAINT workspace_psd_templates_file_name_check CHECK (((length(file_name) >= 1) AND (length(file_name) <= 255))),
    CONSTRAINT workspace_psd_templates_sha256_check CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT workspace_psd_templates_type_id_check CHECK ((type_id > 0))
);

ALTER TABLE ONLY public.workspace_psd_templates FORCE ROW LEVEL SECURITY;


--
-- Name: writer_lease_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.writer_lease_events (
    id bigint NOT NULL,
    lease_id bigint,
    domain character varying(64) NOT NULL,
    action character varying(32) NOT NULL,
    holder character varying(32) NOT NULL,
    holder_instance character varying(128) NOT NULL,
    fence_token bigint NOT NULL,
    expected_fence bigint,
    reason text NOT NULL,
    created_at_ms bigint NOT NULL,
    CONSTRAINT writer_lease_events_action_known CHECK (((action)::text = ANY ((ARRAY['grant'::character varying, 'revoke'::character varying, 'grant_release'::character varying])::text[])))
);


--
-- Name: writer_lease_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.writer_lease_events ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.writer_lease_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: writer_lease_fence_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.writer_lease_fence_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: writer_leases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.writer_leases (
    id bigint NOT NULL,
    domain character varying(64) NOT NULL,
    holder character varying(32) NOT NULL,
    holder_instance character varying(128) NOT NULL,
    fence_token bigint NOT NULL,
    granted_at_ms bigint NOT NULL,
    expires_at_ms bigint NOT NULL,
    heartbeat_at_ms bigint NOT NULL,
    revoked_at_ms bigint,
    grant_reason text NOT NULL,
    CONSTRAINT writer_leases_domain_known CHECK (((domain)::text = ANY ((ARRAY['auth'::character varying, 'entitlement'::character varying, 'catalog'::character varying, 'recipe'::character varying, 'telemetry'::character varying, 'admin'::character varying, 'release'::character varying, 'billing'::character varying])::text[]))),
    CONSTRAINT writer_leases_expiry_after_grant CHECK ((expires_at_ms >= granted_at_ms)),
    CONSTRAINT writer_leases_fence_positive CHECK ((fence_token > 0)),
    CONSTRAINT writer_leases_holder_known CHECK (((holder)::text = ANY ((ARRAY['axum'::character varying, 'hono'::character varying])::text[])))
);


--
-- Name: writer_leases_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.writer_leases ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.writer_leases_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: ai_billing_ratio_documents id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_billing_ratio_documents ALTER COLUMN id SET DEFAULT nextval('public.ai_billing_ratio_documents_id_seq'::regclass);


--
-- Name: ai_consume_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_consume_logs ALTER COLUMN id SET DEFAULT nextval('public.ai_consume_logs_id_seq'::regclass);


--
-- Name: ai_price_schedules id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_price_schedules ALTER COLUMN id SET DEFAULT nextval('public.ai_price_schedules_id_seq'::regclass);


--
-- Name: ai_requests id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_requests ALTER COLUMN id SET DEFAULT nextval('public.ai_requests_id_seq'::regclass);


--
-- Name: error_digest id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.error_digest ALTER COLUMN id SET DEFAULT nextval('public.error_digest_id_seq'::regclass);


--
-- Name: payment_orders id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_orders ALTER COLUMN id SET DEFAULT nextval('public.payment_orders_id_seq'::regclass);


--
-- Name: subscription_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_events ALTER COLUMN id SET DEFAULT nextval('public.subscription_events_id_seq'::regclass);


--
-- Name: subscription_periods id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_periods ALTER COLUMN id SET DEFAULT nextval('public.subscription_periods_id_seq'::regclass);


--
-- Name: wallet_ledger id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_ledger ALTER COLUMN id SET DEFAULT nextval('public.wallet_ledger_id_seq'::regclass);


--
-- Name: account_admin_totp account_admin_totp_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_admin_totp
    ADD CONSTRAINT account_admin_totp_pkey PRIMARY KEY (user_id);


--
-- Name: account_credentials account_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_credentials
    ADD CONSTRAINT account_credentials_pkey PRIMARY KEY (user_id);


--
-- Name: account_profiles account_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_profiles
    ADD CONSTRAINT account_profiles_pkey PRIMARY KEY (user_id);


--
-- Name: account_queue_cursor account_queue_cursor_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_queue_cursor
    ADD CONSTRAINT account_queue_cursor_pkey PRIMARY KEY (lane);


--
-- Name: account_queue_head account_queue_head_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_queue_head
    ADD CONSTRAINT account_queue_head_pkey PRIMARY KEY (user_id, lane);


--
-- Name: account_sessions account_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_sessions
    ADD CONSTRAINT account_sessions_pkey PRIMARY KEY (token_hash);


--
-- Name: account_users account_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_users
    ADD CONSTRAINT account_users_pkey PRIMARY KEY (id);


--
-- Name: agent_commission_ledger agent_commission_ledger_key_uidx; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_commission_ledger
    ADD CONSTRAINT agent_commission_ledger_key_uidx UNIQUE (user_id, entry_type, idempotency_key);


--
-- Name: agent_commission_ledger agent_commission_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_commission_ledger
    ADD CONSTRAINT agent_commission_ledger_pkey PRIMARY KEY (id);


--
-- Name: agent_commission_wallets agent_commission_wallets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_commission_wallets
    ADD CONSTRAINT agent_commission_wallets_pkey PRIMARY KEY (user_id);


--
-- Name: agent_commissions agent_commissions_invitee_uidx; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_commissions
    ADD CONSTRAINT agent_commissions_invitee_uidx UNIQUE (invitee_user_id);


--
-- Name: agent_commissions agent_commissions_order_uidx; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_commissions
    ADD CONSTRAINT agent_commissions_order_uidx UNIQUE (payment_order_id);


--
-- Name: agent_commissions agent_commissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_commissions
    ADD CONSTRAINT agent_commissions_pkey PRIMARY KEY (id);


--
-- Name: agent_rebate_policy agent_rebate_policy_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_rebate_policy
    ADD CONSTRAINT agent_rebate_policy_pkey PRIMARY KEY (singleton);


--
-- Name: agent_withdrawals agent_withdrawals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_withdrawals
    ADD CONSTRAINT agent_withdrawals_pkey PRIMARY KEY (id);


--
-- Name: agent_withdrawals agent_withdrawals_public_id_uidx; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_withdrawals
    ADD CONSTRAINT agent_withdrawals_public_id_uidx UNIQUE (public_id);


--
-- Name: agents agents_invite_code_uidx; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_invite_code_uidx UNIQUE (invite_code);


--
-- Name: agents agents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_pkey PRIMARY KEY (user_id);


--
-- Name: ai_billing_ratio_documents ai_billing_ratio_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_billing_ratio_documents
    ADD CONSTRAINT ai_billing_ratio_documents_pkey PRIMARY KEY (id);


--
-- Name: ai_consume_logs ai_consume_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_consume_logs
    ADD CONSTRAINT ai_consume_logs_pkey PRIMARY KEY (id);


--
-- Name: ai_image_set_items ai_image_set_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_image_set_items
    ADD CONSTRAINT ai_image_set_items_pkey PRIMARY KEY (id);


--
-- Name: ai_image_set_items ai_image_set_items_request_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_image_set_items
    ADD CONSTRAINT ai_image_set_items_request_id_key UNIQUE (request_id);


--
-- Name: ai_image_set_items ai_image_set_items_set_id_ordinal_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_image_set_items
    ADD CONSTRAINT ai_image_set_items_set_id_ordinal_key UNIQUE (set_id, ordinal);


--
-- Name: ai_image_sets ai_image_sets_id_org_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_image_sets
    ADD CONSTRAINT ai_image_sets_id_org_id_key UNIQUE (id, org_id);


--
-- Name: ai_image_sets ai_image_sets_org_id_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_image_sets
    ADD CONSTRAINT ai_image_sets_org_id_idempotency_key_key UNIQUE (org_id, idempotency_key);


--
-- Name: ai_image_sets ai_image_sets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_image_sets
    ADD CONSTRAINT ai_image_sets_pkey PRIMARY KEY (id);


--
-- Name: ai_price_schedules ai_price_schedules_model_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_price_schedules
    ADD CONSTRAINT ai_price_schedules_model_key UNIQUE (model);


--
-- Name: ai_price_schedules ai_price_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_price_schedules
    ADD CONSTRAINT ai_price_schedules_pkey PRIMARY KEY (id);


--
-- Name: ai_requests ai_requests_id_org_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_requests
    ADD CONSTRAINT ai_requests_id_org_unique UNIQUE (id, org_id);


--
-- Name: ai_requests ai_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_requests
    ADD CONSTRAINT ai_requests_pkey PRIMARY KEY (id);


--
-- Name: ai_requests ai_requests_public_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_requests
    ADD CONSTRAINT ai_requests_public_id_key UNIQUE (public_id);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: auth_email_tokens auth_email_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_email_tokens
    ADD CONSTRAINT auth_email_tokens_pkey PRIMARY KEY (token_hash);


--
-- Name: auth_login_attempts auth_login_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_login_attempts
    ADD CONSTRAINT auth_login_attempts_pkey PRIMARY KEY (email_hash, ip_hash);


--
-- Name: automation_asset_set_items automation_asset_set_items_item_uidx; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_asset_set_items
    ADD CONSTRAINT automation_asset_set_items_item_uidx UNIQUE (set_id, item_key);


--
-- Name: automation_asset_set_items automation_asset_set_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_asset_set_items
    ADD CONSTRAINT automation_asset_set_items_pkey PRIMARY KEY (id);


--
-- Name: automation_asset_sets automation_asset_sets_name_uidx; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_asset_sets
    ADD CONSTRAINT automation_asset_sets_name_uidx UNIQUE (org_id, user_id, name);


--
-- Name: automation_asset_sets automation_asset_sets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_asset_sets
    ADD CONSTRAINT automation_asset_sets_pkey PRIMARY KEY (id);


--
-- Name: automation_call_receipts automation_call_receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_call_receipts
    ADD CONSTRAINT automation_call_receipts_pkey PRIMARY KEY (grant_id, execution_id, call_id);


--
-- Name: automation_executions automation_executions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_executions
    ADD CONSTRAINT automation_executions_pkey PRIMARY KEY (grant_id, execution_id);


--
-- Name: automation_grants automation_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_grants
    ADD CONSTRAINT automation_grants_pkey PRIMARY KEY (id);


--
-- Name: automation_runtimes automation_runtimes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_runtimes
    ADD CONSTRAINT automation_runtimes_pkey PRIMARY KEY (id);


--
-- Name: banned_tags banned_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.banned_tags
    ADD CONSTRAINT banned_tags_pkey PRIMARY KEY (id);


--
-- Name: banned_tags banned_tags_term_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.banned_tags
    ADD CONSTRAINT banned_tags_term_key UNIQUE (term);


--
-- Name: billable_usage_events billable_usage_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billable_usage_events
    ADD CONSTRAINT billable_usage_events_pkey PRIMARY KEY (id);


--
-- Name: billable_usage_rollups billable_usage_rollups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billable_usage_rollups
    ADD CONSTRAINT billable_usage_rollups_pkey PRIMARY KEY (id);


--
-- Name: billing_operations billing_operations_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_operations
    ADD CONSTRAINT billing_operations_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: billing_operations billing_operations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_operations
    ADD CONSTRAINT billing_operations_pkey PRIMARY KEY (id);


--
-- Name: browser_commands browser_commands_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_commands
    ADD CONSTRAINT browser_commands_pkey PRIMARY KEY (id);


--
-- Name: catalog_dictionary_search_material catalog_dictionary_search_material_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog_dictionary_search_material
    ADD CONSTRAINT catalog_dictionary_search_material_pkey PRIMARY KEY (description_category_id, type_id, language, attribute_id, dictionary_id, option_id);


--
-- Name: ozon_catalog_schema_cache catalog_schema_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ozon_catalog_schema_cache
    ADD CONSTRAINT catalog_schema_cache_pkey PRIMARY KEY (description_category_id, type_id, language);


--
-- Name: ozon_catalog_tree_cache catalog_tree_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ozon_catalog_tree_cache
    ADD CONSTRAINT catalog_tree_cache_pkey PRIMARY KEY (language);


--
-- Name: category_prompts category_prompts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.category_prompts
    ADD CONSTRAINT category_prompts_pkey PRIMARY KEY (id);


--
-- Name: category_videos category_videos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.category_videos
    ADD CONSTRAINT category_videos_pkey PRIMARY KEY (id);


--
-- Name: sc_products ck_sc_products_pack_depth; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.sc_products
    ADD CONSTRAINT ck_sc_products_pack_depth CHECK (((pack_depth_mm IS NULL) OR (pack_depth_mm > 0))) NOT VALID;


--
-- Name: sc_products ck_sc_products_pack_height; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.sc_products
    ADD CONSTRAINT ck_sc_products_pack_height CHECK (((pack_height_mm IS NULL) OR (pack_height_mm > 0))) NOT VALID;


--
-- Name: sc_products ck_sc_products_pack_weight; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.sc_products
    ADD CONSTRAINT ck_sc_products_pack_weight CHECK (((pack_weight_g IS NULL) OR (pack_weight_g > 0))) NOT VALID;


--
-- Name: sc_products ck_sc_products_pack_width; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.sc_products
    ADD CONSTRAINT ck_sc_products_pack_width CHECK (((pack_width_mm IS NULL) OR (pack_width_mm > 0))) NOT VALID;


--
-- Name: client_listing_logs client_listing_logs_client_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_listing_logs
    ADD CONSTRAINT client_listing_logs_client_unique UNIQUE (user_id, client_id);


--
-- Name: client_listing_logs client_listing_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_listing_logs
    ADD CONSTRAINT client_listing_logs_pkey PRIMARY KEY (id);


--
-- Name: console_store_metrics console_store_metrics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.console_store_metrics
    ADD CONSTRAINT console_store_metrics_pkey PRIMARY KEY (store_id);


--
-- Name: delegate_assets delegate_assets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegate_assets
    ADD CONSTRAINT delegate_assets_pkey PRIMARY KEY (asset_id);


--
-- Name: delegate_bindings delegate_bindings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegate_bindings
    ADD CONSTRAINT delegate_bindings_pkey PRIMARY KEY (binding_id);


--
-- Name: delegate_dispatch_assets delegate_dispatch_assets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegate_dispatch_assets
    ADD CONSTRAINT delegate_dispatch_assets_pkey PRIMARY KEY (dispatch_id, asset_id);


--
-- Name: delegate_dispatches delegate_dispatches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegate_dispatches
    ADD CONSTRAINT delegate_dispatches_pkey PRIMARY KEY (dispatch_id);


--
-- Name: delegate_order_lines delegate_order_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegate_order_lines
    ADD CONSTRAINT delegate_order_lines_pkey PRIMARY KEY (line_id);


--
-- Name: delegate_orders delegate_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegate_orders
    ADD CONSTRAINT delegate_orders_pkey PRIMARY KEY (order_id);


--
-- Name: delegate_settlements delegate_settlements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegate_settlements
    ADD CONSTRAINT delegate_settlements_pkey PRIMARY KEY (settlement_id);


--
-- Name: error_digest error_digest_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.error_digest
    ADD CONSTRAINT error_digest_pkey PRIMARY KEY (id);


--
-- Name: error_digest error_digest_window_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.error_digest
    ADD CONSTRAINT error_digest_window_key UNIQUE NULLS NOT DISTINCT (org_id, fingerprint, route_template, status_code, window_start);


--
-- Name: event_inbox_events event_inbox_events_device_uid_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_inbox_events
    ADD CONSTRAINT event_inbox_events_device_uid_id_pk PRIMARY KEY (device_uid, id);


--
-- Name: execution_fairness_cursor execution_fairness_cursor_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution_fairness_cursor
    ADD CONSTRAINT execution_fairness_cursor_pkey PRIMARY KEY (class);


--
-- Name: execution_fairness execution_fairness_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution_fairness
    ADD CONSTRAINT execution_fairness_pkey PRIMARY KEY (class, user_id);


--
-- Name: execution_permits execution_permits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution_permits
    ADD CONSTRAINT execution_permits_pkey PRIMARY KEY (holder_kind, holder_id, lease_epoch, class);


--
-- Name: execution_quota execution_quota_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution_quota
    ADD CONSTRAINT execution_quota_pkey PRIMARY KEY (class, user_id);


--
-- Name: ozon_field_packs field_packs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ozon_field_packs
    ADD CONSTRAINT field_packs_pkey PRIMARY KEY (id);


--
-- Name: jobs jobs_org_kind_idempotency; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_org_kind_idempotency UNIQUE (org_id, kind, idempotency_key);


--
-- Name: jobs jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_pkey PRIMARY KEY (id);


--
-- Name: lease_budget lease_budget_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lease_budget
    ADD CONSTRAINT lease_budget_pkey PRIMARY KEY (namespace, scope);


--
-- Name: lease_slot lease_slot_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lease_slot
    ADD CONSTRAINT lease_slot_pkey PRIMARY KEY (namespace, scope, token);


--
-- Name: lease_window lease_window_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lease_window
    ADD CONSTRAINT lease_window_pkey PRIMARY KEY (namespace, scope, window_start);


--
-- Name: listing_card_cursors listing_card_cursors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_card_cursors
    ADD CONSTRAINT listing_card_cursors_pkey PRIMARY KEY (org_id, card_id);


--
-- Name: listing_cards listing_cards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_cards
    ADD CONSTRAINT listing_cards_pkey PRIMARY KEY (id);


--
-- Name: ozon_listing_field_templates listing_field_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ozon_listing_field_templates
    ADD CONSTRAINT listing_field_templates_pkey PRIMARY KEY (id);


--
-- Name: listing_row_events listing_row_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_row_events
    ADD CONSTRAINT listing_row_events_pkey PRIMARY KEY (id);


--
-- Name: listing_rows listing_rows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_rows
    ADD CONSTRAINT listing_rows_pkey PRIMARY KEY (id);


--
-- Name: listing_schema_revisions listing_schema_revisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_schema_revisions
    ADD CONSTRAINT listing_schema_revisions_pkey PRIMARY KEY (schema_revision);


--
-- Name: ozon_listing_schema_snapshots listing_schema_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ozon_listing_schema_snapshots
    ADD CONSTRAINT listing_schema_snapshots_pkey PRIMARY KEY (id);


--
-- Name: media_bindings media_bindings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_bindings
    ADD CONSTRAINT media_bindings_pkey PRIMARY KEY (id);


--
-- Name: media_blobs media_blobs_org_sha; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_blobs
    ADD CONSTRAINT media_blobs_org_sha UNIQUE (org_id, sha256);


--
-- Name: media_blobs media_blobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_blobs
    ADD CONSTRAINT media_blobs_pkey PRIMARY KEY (id);


--
-- Name: media_lib_assets media_lib_assets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_lib_assets
    ADD CONSTRAINT media_lib_assets_pkey PRIMARY KEY (id);


--
-- Name: media_object_leases media_object_leases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_object_leases
    ADD CONSTRAINT media_object_leases_pkey PRIMARY KEY (workspace_uuid, batch_id, content_hash);


--
-- Name: media_uploads media_uploads_org_idempotency; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_uploads
    ADD CONSTRAINT media_uploads_org_idempotency UNIQUE (org_id, idempotency_key);


--
-- Name: media_uploads media_uploads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_uploads
    ADD CONSTRAINT media_uploads_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_uuid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_uuid_key UNIQUE (uuid);


--
-- Name: org_invitations org_invitations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_invitations
    ADD CONSTRAINT org_invitations_pkey PRIMARY KEY (id);


--
-- Name: org_invitations org_invitations_uuid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_invitations
    ADD CONSTRAINT org_invitations_uuid_key UNIQUE (uuid);


--
-- Name: organization_members organization_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_members
    ADD CONSTRAINT organization_members_pkey PRIMARY KEY (id);


--
-- Name: organization_store_groups organization_store_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_store_groups
    ADD CONSTRAINT organization_store_groups_pkey PRIMARY KEY (id);


--
-- Name: organization_store_groups organization_store_groups_uuid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_store_groups
    ADD CONSTRAINT organization_store_groups_uuid_key UNIQUE (uuid);


--
-- Name: organization_store_tags organization_store_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_store_tags
    ADD CONSTRAINT organization_store_tags_pkey PRIMARY KEY (id);


--
-- Name: organization_store_tags organization_store_tags_uuid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_store_tags
    ADD CONSTRAINT organization_store_tags_uuid_key UNIQUE (uuid);


--
-- Name: organization_stores organization_stores_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_stores
    ADD CONSTRAINT organization_stores_pkey PRIMARY KEY (id);


--
-- Name: organization_stores organization_stores_uuid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_stores
    ADD CONSTRAINT organization_stores_uuid_key UNIQUE (uuid);


--
-- Name: organizations organizations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_pkey PRIMARY KEY (id);


--
-- Name: organizations organizations_uuid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_uuid_key UNIQUE (uuid);


--
-- Name: ozon_category_current ozon_category_current_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ozon_category_current
    ADD CONSTRAINT ozon_category_current_pkey PRIMARY KEY (description_category_id, type_id, language);


--
-- Name: ozon_delivery_methods ozon_delivery_methods_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ozon_delivery_methods
    ADD CONSTRAINT ozon_delivery_methods_pkey PRIMARY KEY (org_id, store_id, method_id);


--
-- Name: ozon_dictionary_current ozon_dictionary_current_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ozon_dictionary_current
    ADD CONSTRAINT ozon_dictionary_current_pkey PRIMARY KEY (description_category_id, type_id, language, attribute_id, option_id);


--
-- Name: ozon_error_catalog ozon_error_catalog_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ozon_error_catalog
    ADD CONSTRAINT ozon_error_catalog_pkey PRIMARY KEY (source, code, attribute_id, description_category_id, type_id);


--
-- Name: ozon_error_observation ozon_error_observation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ozon_error_observation
    ADD CONSTRAINT ozon_error_observation_pkey PRIMARY KEY (org_id, source, code, attribute_id, description_category_id, type_id);


--
-- Name: ozon_error_sighting ozon_error_sighting_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ozon_error_sighting
    ADD CONSTRAINT ozon_error_sighting_pkey PRIMARY KEY (org_id, task_key, offer_key, source, code, attribute_id, description_category_id, type_id);


--
-- Name: ozon_product_status ozon_product_status_combo; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ozon_product_status
    ADD CONSTRAINT ozon_product_status_combo UNIQUE (is_archived, status, status_name, moderate_status, validation_status);


--
-- Name: ozon_product_status ozon_product_status_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ozon_product_status
    ADD CONSTRAINT ozon_product_status_pkey PRIMARY KEY (id);


--
-- Name: ozon_listing_schema_snapshots ozon_schema_snapshot_identity; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ozon_listing_schema_snapshots
    ADD CONSTRAINT ozon_schema_snapshot_identity UNIQUE (id, category_id);


--
-- Name: ozon_warehouse_fences ozon_warehouse_fences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ozon_warehouse_fences
    ADD CONSTRAINT ozon_warehouse_fences_pkey PRIMARY KEY (org_id, store_id, warehouse_id);


--
-- Name: ozon_warehouse_intents ozon_warehouse_intents_client_op; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ozon_warehouse_intents
    ADD CONSTRAINT ozon_warehouse_intents_client_op UNIQUE (org_id, store_id, client_operation_id);


--
-- Name: ozon_warehouse_intents ozon_warehouse_intents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ozon_warehouse_intents
    ADD CONSTRAINT ozon_warehouse_intents_pkey PRIMARY KEY (id);


--
-- Name: ozon_warehouse_sync ozon_warehouse_sync_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ozon_warehouse_sync
    ADD CONSTRAINT ozon_warehouse_sync_pkey PRIMARY KEY (org_id, store_id);


--
-- Name: ozon_warehouses ozon_warehouses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ozon_warehouses
    ADD CONSTRAINT ozon_warehouses_pkey PRIMARY KEY (org_id, store_id, warehouse_id);


--
-- Name: payment_callback_ledger payment_callback_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_callback_ledger
    ADD CONSTRAINT payment_callback_ledger_pkey PRIMARY KEY (payment_reference);


--
-- Name: payment_orders payment_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_orders
    ADD CONSTRAINT payment_orders_pkey PRIMARY KEY (id);


--
-- Name: payment_orders payment_orders_public_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_orders
    ADD CONSTRAINT payment_orders_public_id_key UNIQUE (public_id);


--
-- Name: plans plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plans
    ADD CONSTRAINT plans_pkey PRIMARY KEY (key);


--
-- Name: platform_catalog_fetch_config platform_catalog_fetch_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_catalog_fetch_config
    ADD CONSTRAINT platform_catalog_fetch_config_pkey PRIMARY KEY (singleton);


--
-- Name: platform_catalog_fetch_keys platform_catalog_fetch_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_catalog_fetch_keys
    ADD CONSTRAINT platform_catalog_fetch_keys_pkey PRIMARY KEY (id);


--
-- Name: platform_catalog_fetch_keys platform_catalog_fetch_keys_position_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_catalog_fetch_keys
    ADD CONSTRAINT platform_catalog_fetch_keys_position_key UNIQUE ("position");


--
-- Name: platform_initialization platform_initialization_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_initialization
    ADD CONSTRAINT platform_initialization_pkey PRIMARY KEY (singleton);


--
-- Name: platform_integration_config platform_integration_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_integration_config
    ADD CONSTRAINT platform_integration_config_pkey PRIMARY KEY (singleton);


--
-- Name: product_variant_previews product_variant_previews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_variant_previews
    ADD CONSTRAINT product_variant_previews_pkey PRIMARY KEY (id);


--
-- Name: prompt_revisions prompt_revisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_revisions
    ADD CONSTRAINT prompt_revisions_pkey PRIMARY KEY (id);


--
-- Name: prompt_revisions prompt_revisions_product_revision_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_revisions
    ADD CONSTRAINT prompt_revisions_product_revision_unique UNIQUE (product_id, revision);


--
-- Name: redeem_codes redeem_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.redeem_codes
    ADD CONSTRAINT redeem_codes_pkey PRIMARY KEY (id);


--
-- Name: sc_catalog_managers sc_catalog_managers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_catalog_managers
    ADD CONSTRAINT sc_catalog_managers_pkey PRIMARY KEY (manager_id);


--
-- Name: sc_listing_bindings sc_listing_bindings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_listing_bindings
    ADD CONSTRAINT sc_listing_bindings_pkey PRIMARY KEY (id);


--
-- Name: sc_order_lines sc_order_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_order_lines
    ADD CONSTRAINT sc_order_lines_pkey PRIMARY KEY (id);


--
-- Name: sc_order_quotes sc_order_quotes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_order_quotes
    ADD CONSTRAINT sc_order_quotes_pkey PRIMARY KEY (id);


--
-- Name: sc_orders sc_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_orders
    ADD CONSTRAINT sc_orders_pkey PRIMARY KEY (id);


--
-- Name: sc_price_versions sc_price_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_price_versions
    ADD CONSTRAINT sc_price_versions_pkey PRIMARY KEY (id);


--
-- Name: sc_procurements sc_procurements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_procurements
    ADD CONSTRAINT sc_procurements_pkey PRIMARY KEY (id);


--
-- Name: sc_products sc_products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_products
    ADD CONSTRAINT sc_products_pkey PRIMARY KEY (id);


--
-- Name: sc_skus sc_skus_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_skus
    ADD CONSTRAINT sc_skus_pkey PRIMARY KEY (id);


--
-- Name: sc_skus sc_skus_product_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_skus
    ADD CONSTRAINT sc_skus_product_unique UNIQUE (product_id);


--
-- Name: sc_source_fulfillers sc_source_fulfillers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_source_fulfillers
    ADD CONSTRAINT sc_source_fulfillers_pkey PRIMARY KEY (fulfiller_id);


--
-- Name: sc_source_members sc_source_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_source_members
    ADD CONSTRAINT sc_source_members_pkey PRIMARY KEY (member_id);


--
-- Name: sc_source_offers sc_source_offers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_source_offers
    ADD CONSTRAINT sc_source_offers_pkey PRIMARY KEY (id);


--
-- Name: sc_source_prop_defs sc_source_prop_defs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_source_prop_defs
    ADD CONSTRAINT sc_source_prop_defs_pkey PRIMARY KEY (prop_id);


--
-- Name: sc_sources sc_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_sources
    ADD CONSTRAINT sc_sources_pkey PRIMARY KEY (source_id);


--
-- Name: seller_read_incidents seller_read_incidents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seller_read_incidents
    ADD CONSTRAINT seller_read_incidents_pkey PRIMARY KEY (id);


--
-- Name: seller_resource_occupancies seller_resource_occupancies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seller_resource_occupancies
    ADD CONSTRAINT seller_resource_occupancies_pkey PRIMARY KEY (id);


--
-- Name: seller_upstream_writes seller_upstream_writes_idempotency; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seller_upstream_writes
    ADD CONSTRAINT seller_upstream_writes_idempotency UNIQUE (org_id, store_id, idempotency_key);


--
-- Name: seller_upstream_writes seller_upstream_writes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seller_upstream_writes
    ADD CONSTRAINT seller_upstream_writes_pkey PRIMARY KEY (id);


--
-- Name: shipping_inject_operations shipping_inject_operations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipping_inject_operations
    ADD CONSTRAINT shipping_inject_operations_pkey PRIMARY KEY (id);


--
-- Name: shipping_preset_versions shipping_preset_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipping_preset_versions
    ADD CONSTRAINT shipping_preset_versions_pkey PRIMARY KEY (id);


--
-- Name: shipping_presets shipping_presets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipping_presets
    ADD CONSTRAINT shipping_presets_pkey PRIMARY KEY (id);


--
-- Name: shipping_shop_injections shipping_shop_injections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipping_shop_injections
    ADD CONSTRAINT shipping_shop_injections_pkey PRIMARY KEY (id);


--
-- Name: shipping_sku_bindings shipping_sku_bindings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipping_sku_bindings
    ADD CONSTRAINT shipping_sku_bindings_pkey PRIMARY KEY (id);


--
-- Name: slice_r2_cleanup_runs slice_r2_cleanup_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slice_r2_cleanup_runs
    ADD CONSTRAINT slice_r2_cleanup_runs_pkey PRIMARY KEY (bucket_fingerprint, run_day);


--
-- Name: storage_object_refs storage_object_refs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_object_refs
    ADD CONSTRAINT storage_object_refs_pkey PRIMARY KEY (object_id, owner_kind, owner_id);


--
-- Name: storage_objects storage_objects_bucket_identity_dedupe_scope_sha256_extensi_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_objects
    ADD CONSTRAINT storage_objects_bucket_identity_dedupe_scope_sha256_extensi_key UNIQUE (bucket_identity, dedupe_scope, sha256, extension);


--
-- Name: storage_objects storage_objects_bucket_identity_object_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_objects
    ADD CONSTRAINT storage_objects_bucket_identity_object_key_key UNIQUE (bucket_identity, object_key);


--
-- Name: storage_objects storage_objects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_objects
    ADD CONSTRAINT storage_objects_pkey PRIMARY KEY (id);


--
-- Name: storage_uploads storage_uploads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_uploads
    ADD CONSTRAINT storage_uploads_pkey PRIMARY KEY (id);


--
-- Name: store_credential_verifications store_credential_verifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_credential_verifications
    ADD CONSTRAINT store_credential_verifications_pkey PRIMARY KEY (org_id, store_id, user_id, credential_revision);


--
-- Name: store_product_metrics store_product_metrics_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_product_metrics
    ADD CONSTRAINT store_product_metrics_pk PRIMARY KEY (store_pk, sku);


--
-- Name: store_product_pass_pages store_product_pass_pages_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_product_pass_pages
    ADD CONSTRAINT store_product_pass_pages_pk PRIMARY KEY (store_pk, generation, page_no);


--
-- Name: store_product_sync store_product_sync_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_product_sync
    ADD CONSTRAINT store_product_sync_pkey PRIMARY KEY (store_id);


--
-- Name: store_products store_products_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_products
    ADD CONSTRAINT store_products_pk PRIMARY KEY (store_pk, product_id);


--
-- Name: store_rating_history store_rating_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_rating_history
    ADD CONSTRAINT store_rating_history_pkey PRIMARY KEY (id);


--
-- Name: store_rating_snapshots store_rating_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_rating_snapshots
    ADD CONSTRAINT store_rating_snapshots_pkey PRIMARY KEY (org_id, store_id, rating_key);


--
-- Name: store_rating_sync store_rating_sync_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_rating_sync
    ADD CONSTRAINT store_rating_sync_pkey PRIMARY KEY (org_id, store_id);


--
-- Name: store_seller_credentials store_seller_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_seller_credentials
    ADD CONSTRAINT store_seller_credentials_pkey PRIMARY KEY (store_id);


--
-- Name: store_tag_links store_tag_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_tag_links
    ADD CONSTRAINT store_tag_links_pkey PRIMARY KEY (store_id, tag_id);


--
-- Name: store_tombstone_consumptions store_tombstone_consumptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_tombstone_consumptions
    ADD CONSTRAINT store_tombstone_consumptions_pkey PRIMARY KEY (org_id, store_id, user_id);


--
-- Name: submission_intents submission_intents_client_op; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.submission_intents
    ADD CONSTRAINT submission_intents_client_op UNIQUE (org_id, store_id, client_operation_id);


--
-- Name: submission_intents submission_intents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.submission_intents
    ADD CONSTRAINT submission_intents_pkey PRIMARY KEY (id);


--
-- Name: subscription_events subscription_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_events
    ADD CONSTRAINT subscription_events_pkey PRIMARY KEY (id);


--
-- Name: subscription_periods subscription_periods_org_id_tstzrange_excl; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_periods
    ADD CONSTRAINT subscription_periods_org_id_tstzrange_excl EXCLUDE USING gist (org_id WITH =, tstzrange(starts_at, ends_at, '[)'::text) WITH &&);


--
-- Name: subscription_periods subscription_periods_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_periods
    ADD CONSTRAINT subscription_periods_pkey PRIMARY KEY (id);


--
-- Name: subscription_quotes subscription_quotes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_quotes
    ADD CONSTRAINT subscription_quotes_pkey PRIMARY KEY (id);


--
-- Name: subscriptions subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (org_id);


--
-- Name: supplier_media_objects supplier_media_objects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_media_objects
    ADD CONSTRAINT supplier_media_objects_pkey PRIMARY KEY (product_id, object_key);


--
-- Name: supplier_media_objects supplier_media_objects_url_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_media_objects
    ADD CONSTRAINT supplier_media_objects_url_unique UNIQUE (product_id, public_url);


--
-- Name: supplier_ozon_configs supplier_ozon_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_ozon_configs
    ADD CONSTRAINT supplier_ozon_configs_pkey PRIMARY KEY (product_id);


--
-- Name: supplier_wallet_ledger supplier_wallet_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_wallet_ledger
    ADD CONSTRAINT supplier_wallet_ledger_pkey PRIMARY KEY (ledger_id);


--
-- Name: supplier_wallets supplier_wallets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_wallets
    ADD CONSTRAINT supplier_wallets_pkey PRIMARY KEY (source_id);


--
-- Name: supplier_withdrawals supplier_withdrawals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_withdrawals
    ADD CONSTRAINT supplier_withdrawals_pkey PRIMARY KEY (withdrawal_id);


--
-- Name: support_grants support_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_grants
    ADD CONSTRAINT support_grants_pkey PRIMARY KEY (id);


--
-- Name: transit_clear_runs transit_clear_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transit_clear_runs
    ADD CONSTRAINT transit_clear_runs_pkey PRIMARY KEY (bucket_identity, run_day);


--
-- Name: organization_store_groups uq_organization_store_groups_name; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_store_groups
    ADD CONSTRAINT uq_organization_store_groups_name UNIQUE (org_id, name_key);


--
-- Name: organization_store_tags uq_organization_store_tags_name; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_store_tags
    ADD CONSTRAINT uq_organization_store_tags_name UNIQUE (org_id, name_key);


--
-- Name: user_wallets user_wallets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_wallets
    ADD CONSTRAINT user_wallets_pkey PRIMARY KEY (user_id);


--
-- Name: delegate_assets ux_delegate_assets_object_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegate_assets
    ADD CONSTRAINT ux_delegate_assets_object_key UNIQUE (org_id, object_key);


--
-- Name: delegate_bindings ux_delegate_bindings_store_offer; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegate_bindings
    ADD CONSTRAINT ux_delegate_bindings_store_offer UNIQUE (org_id, store_id, offer_id);


--
-- Name: delegate_dispatches ux_delegate_dispatches_no; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegate_dispatches
    ADD CONSTRAINT ux_delegate_dispatches_no UNIQUE (dispatch_no);


--
-- Name: delegate_order_lines ux_delegate_order_lines_offer; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegate_order_lines
    ADD CONSTRAINT ux_delegate_order_lines_offer UNIQUE (order_id, offer_id);


--
-- Name: delegate_orders ux_delegate_orders_posting; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegate_orders
    ADD CONSTRAINT ux_delegate_orders_posting UNIQUE (org_id, store_id, posting_number);


--
-- Name: delegate_settlements ux_delegate_settlements_dispatch; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegate_settlements
    ADD CONSTRAINT ux_delegate_settlements_dispatch UNIQUE (dispatch_id);


--
-- Name: sc_catalog_managers ux_sc_catalog_managers_user; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_catalog_managers
    ADD CONSTRAINT ux_sc_catalog_managers_user UNIQUE (source_id, user_id);


--
-- Name: sc_listing_bindings ux_sc_listing_bindings_listing_row; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_listing_bindings
    ADD CONSTRAINT ux_sc_listing_bindings_listing_row UNIQUE (org_id, listing_row_id);


--
-- Name: sc_order_lines ux_sc_order_lines_order_line; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_order_lines
    ADD CONSTRAINT ux_sc_order_lines_order_line UNIQUE (order_id, line_no);


--
-- Name: sc_order_quotes ux_sc_order_quotes_org_idempotency; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_order_quotes
    ADD CONSTRAINT ux_sc_order_quotes_org_idempotency UNIQUE (org_id, idempotency_key);


--
-- Name: sc_order_quotes ux_sc_order_quotes_quote_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_order_quotes
    ADD CONSTRAINT ux_sc_order_quotes_quote_id UNIQUE (quote_id);


--
-- Name: sc_orders ux_sc_orders_order_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_orders
    ADD CONSTRAINT ux_sc_orders_order_id UNIQUE (order_id);


--
-- Name: sc_orders ux_sc_orders_org_idempotency; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_orders
    ADD CONSTRAINT ux_sc_orders_org_idempotency UNIQUE (org_id, idempotency_key);


--
-- Name: sc_procurements ux_sc_procurements_operation_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_procurements
    ADD CONSTRAINT ux_sc_procurements_operation_id UNIQUE (operation_id);


--
-- Name: sc_procurements ux_sc_procurements_order_line_attempt; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_procurements
    ADD CONSTRAINT ux_sc_procurements_order_line_attempt UNIQUE (platform_order_id, line_no, attempt);


--
-- Name: sc_procurements ux_sc_procurements_procurement_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_procurements
    ADD CONSTRAINT ux_sc_procurements_procurement_id UNIQUE (procurement_id);


--
-- Name: sc_products ux_sc_products_product_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_products
    ADD CONSTRAINT ux_sc_products_product_id UNIQUE (product_id);


--
-- Name: sc_skus ux_sc_skus_platform_code; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_skus
    ADD CONSTRAINT ux_sc_skus_platform_code UNIQUE (platform_code);


--
-- Name: sc_skus ux_sc_skus_sku_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_skus
    ADD CONSTRAINT ux_sc_skus_sku_id UNIQUE (sku_id);


--
-- Name: sc_source_fulfillers ux_sc_source_fulfillers_source; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_source_fulfillers
    ADD CONSTRAINT ux_sc_source_fulfillers_source UNIQUE (source_id, fulfiller_id);


--
-- Name: sc_source_fulfillers ux_sc_source_fulfillers_user; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_source_fulfillers
    ADD CONSTRAINT ux_sc_source_fulfillers_user UNIQUE (source_id, user_id);


--
-- Name: sc_source_members ux_sc_source_members_source_user; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_source_members
    ADD CONSTRAINT ux_sc_source_members_source_user UNIQUE (source_id, user_id);


--
-- Name: sc_source_offers ux_sc_source_offers_source_sku; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_source_offers
    ADD CONSTRAINT ux_sc_source_offers_source_sku UNIQUE (source_id, sku_id);


--
-- Name: sc_source_prop_defs ux_sc_source_prop_defs_source_name; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_source_prop_defs
    ADD CONSTRAINT ux_sc_source_prop_defs_source_name UNIQUE (source_id, name);


--
-- Name: sc_sources ux_sc_sources_name; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_sources
    ADD CONSTRAINT ux_sc_sources_name UNIQUE (name);


--
-- Name: shipping_inject_operations ux_shipping_inject_operations_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipping_inject_operations
    ADD CONSTRAINT ux_shipping_inject_operations_id UNIQUE (operation_id);


--
-- Name: shipping_inject_operations ux_shipping_inject_operations_idempotency; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipping_inject_operations
    ADD CONSTRAINT ux_shipping_inject_operations_idempotency UNIQUE (idempotency_key);


--
-- Name: shipping_preset_versions ux_shipping_preset_versions_preset_version; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipping_preset_versions
    ADD CONSTRAINT ux_shipping_preset_versions_preset_version UNIQUE (preset_id, version);


--
-- Name: shipping_presets ux_shipping_presets_preset_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipping_presets
    ADD CONSTRAINT ux_shipping_presets_preset_id UNIQUE (preset_id);


--
-- Name: shipping_shop_injections ux_shipping_shop_injections; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipping_shop_injections
    ADD CONSTRAINT ux_shipping_shop_injections UNIQUE (store_uuid, preset_id);


--
-- Name: shipping_sku_bindings ux_shipping_sku_bindings_sku; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipping_sku_bindings
    ADD CONSTRAINT ux_shipping_sku_bindings_sku UNIQUE (sku_id);


--
-- Name: supplier_wallet_ledger ux_supplier_wallet_ledger_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_wallet_ledger
    ADD CONSTRAINT ux_supplier_wallet_ledger_key UNIQUE (source_id, entry_type, idempotency_key);


--
-- Name: wallet_ledger wallet_ledger_key_uidx; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_ledger
    ADD CONSTRAINT wallet_ledger_key_uidx UNIQUE (org_id, entry_type, idempotency_key);


--
-- Name: wallet_ledger wallet_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_ledger
    ADD CONSTRAINT wallet_ledger_pkey PRIMARY KEY (id);


--
-- Name: wb_category_current wb_category_current_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_category_current
    ADD CONSTRAINT wb_category_current_pkey PRIMARY KEY (subject_id, language);


--
-- Name: wb_category_field_defaults wb_category_field_defaults_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_category_field_defaults
    ADD CONSTRAINT wb_category_field_defaults_pkey PRIMARY KEY (subject_id, language);


--
-- Name: workspace_psd_templates workspace_psd_templates_org_id_description_category_id_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_psd_templates
    ADD CONSTRAINT workspace_psd_templates_org_id_description_category_id_type_key UNIQUE (org_id, description_category_id, type_id, sha256);


--
-- Name: workspace_psd_templates workspace_psd_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_psd_templates
    ADD CONSTRAINT workspace_psd_templates_pkey PRIMARY KEY (id);


--
-- Name: writer_lease_events writer_lease_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.writer_lease_events
    ADD CONSTRAINT writer_lease_events_pkey PRIMARY KEY (id);


--
-- Name: writer_leases writer_leases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.writer_leases
    ADD CONSTRAINT writer_leases_pkey PRIMARY KEY (id);


--
-- Name: account_queue_head_claim_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX account_queue_head_claim_idx ON public.account_queue_head USING btree (lane, user_id) WHERE (queued_cost > 0);


--
-- Name: account_users_invited_by_agent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX account_users_invited_by_agent_idx ON public.account_users USING btree (invited_by_agent_user_id) WHERE (invited_by_agent_user_id IS NOT NULL);


--
-- Name: account_users_single_super_admin; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX account_users_single_super_admin ON public.account_users USING btree (role) WHERE ((role)::text = 'super_admin'::text);


--
-- Name: agent_commission_ledger_user_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_commission_ledger_user_created_idx ON public.agent_commission_ledger USING btree (user_id, created_at DESC);


--
-- Name: agent_commissions_agent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_commissions_agent_idx ON public.agent_commissions USING btree (agent_user_id, created_at DESC);


--
-- Name: agent_withdrawals_one_pending_per_user; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX agent_withdrawals_one_pending_per_user ON public.agent_withdrawals USING btree (user_id) WHERE ((status)::text = 'pending'::text);


--
-- Name: agent_withdrawals_status_requested_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_withdrawals_status_requested_idx ON public.agent_withdrawals USING btree (status, requested_at DESC);


--
-- Name: agent_withdrawals_user_requested_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_withdrawals_user_requested_idx ON public.agent_withdrawals USING btree (user_id, requested_at DESC);


--
-- Name: ai_billing_ratio_documents_org_kind_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ai_billing_ratio_documents_org_kind_idx ON public.ai_billing_ratio_documents USING btree (org_id, kind) WHERE (org_id IS NOT NULL);


--
-- Name: ai_billing_ratio_documents_platform_kind_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ai_billing_ratio_documents_platform_kind_idx ON public.ai_billing_ratio_documents USING btree (kind) WHERE (org_id IS NULL);


--
-- Name: ai_consume_logs_org_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_consume_logs_org_created_idx ON public.ai_consume_logs USING btree (org_id, created_at DESC);


--
-- Name: ai_consume_logs_org_model_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_consume_logs_org_model_created_idx ON public.ai_consume_logs USING btree (org_id, model_name, created_at);


--
-- Name: ai_consume_logs_org_request_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_consume_logs_org_request_idx ON public.ai_consume_logs USING btree (org_id, request_id);


--
-- Name: ai_requests_org_binding_hash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_requests_org_binding_hash_idx ON public.ai_requests USING btree (org_id, binding_hash) WHERE (binding_hash IS NOT NULL);


--
-- Name: ai_requests_org_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_requests_org_created_idx ON public.ai_requests USING btree (org_id, created_at DESC);


--
-- Name: ai_requests_org_idempotency_live_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ai_requests_org_idempotency_live_uidx ON public.ai_requests USING btree (org_id, idempotency_key) WHERE ((status)::text <> 'failed'::text);


--
-- Name: ai_requests_org_job_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_requests_org_job_idx ON public.ai_requests USING btree (org_id, job_id) WHERE (job_id IS NOT NULL);


--
-- Name: ai_requests_org_ocr_canonical_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_requests_org_ocr_canonical_idx ON public.ai_requests USING btree (org_id, ((ocr_prompt ->> 'canonicalHash'::text))) WHERE (((operation)::text = 'ocr'::text) AND (job_id IS NULL) AND ((ocr_prompt ->> 'canonicalHash'::text) IS NOT NULL));


--
-- Name: ai_requests_org_unbilled_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_requests_org_unbilled_idx ON public.ai_requests USING btree (org_id, updated_at) WHERE ((status)::text = 'unbilled_unknown'::text);


--
-- Name: automation_executions_grant_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX automation_executions_grant_created_idx ON public.automation_executions USING btree (grant_id, created_at, execution_id);


--
-- Name: automation_executions_grant_expired_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX automation_executions_grant_expired_idx ON public.automation_executions USING btree (grant_id, lease_deadline, execution_id) WHERE (status = 'running'::text);


--
-- Name: automation_grants_owner_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX automation_grants_owner_scope_idx ON public.automation_grants USING btree (user_id, scope_kind, org_id, created_at DESC, id);


--
-- Name: automation_grants_token_hash_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX automation_grants_token_hash_uidx ON public.automation_grants USING btree (token_hash);


--
-- Name: automation_grants_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX automation_grants_user_idx ON public.automation_grants USING btree (user_id, org_id) WHERE (revoked_at IS NULL);


--
-- Name: automation_runtimes_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX automation_runtimes_scope_idx ON public.automation_runtimes USING btree (org_id, grant_id) WHERE (deregistered_at IS NULL);


--
-- Name: browser_commands_claimed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX browser_commands_claimed_idx ON public.browser_commands USING btree (claimed_by) WHERE ((status)::text = 'claimed'::text);


--
-- Name: browser_commands_queue_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX browser_commands_queue_idx ON public.browser_commands USING btree (org_id, grant_id, created_at) WHERE ((status)::text = 'queued'::text);


--
-- Name: browser_commands_request_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX browser_commands_request_uidx ON public.browser_commands USING btree (org_id, grant_id, client_request_id);


--
-- Name: client_listing_logs_batch_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX client_listing_logs_batch_idx ON public.client_listing_logs USING btree (batch_id) WHERE (batch_id IS NOT NULL);


--
-- Name: client_listing_logs_intent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX client_listing_logs_intent_idx ON public.client_listing_logs USING btree (intent_id) WHERE (intent_id IS NOT NULL);


--
-- Name: client_listing_logs_offer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX client_listing_logs_offer_idx ON public.client_listing_logs USING btree (offer_id) WHERE (offer_id IS NOT NULL);


--
-- Name: client_listing_logs_received_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX client_listing_logs_received_idx ON public.client_listing_logs USING btree (received_at, id);


--
-- Name: client_listing_logs_row_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX client_listing_logs_row_idx ON public.client_listing_logs USING btree (row_id) WHERE (row_id IS NOT NULL);


--
-- Name: client_listing_logs_user_received_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX client_listing_logs_user_received_idx ON public.client_listing_logs USING btree (user_id, received_at DESC);


--
-- Name: console_store_metrics_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX console_store_metrics_org_idx ON public.console_store_metrics USING btree (org_id);


--
-- Name: error_digest_org_window_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX error_digest_org_window_idx ON public.error_digest USING btree (org_id, window_start) WHERE (org_id IS NOT NULL);


--
-- Name: error_digest_platform_last_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX error_digest_platform_last_idx ON public.error_digest USING btree (last_at DESC, fingerprint) WHERE (org_id IS NULL);


--
-- Name: event_inbox_events_kind_received_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX event_inbox_events_kind_received_idx ON public.event_inbox_events USING btree (kind, received_at, device_uid, id);


--
-- Name: execution_permits_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX execution_permits_expiry_idx ON public.execution_permits USING btree (expires_at) WHERE ((released_at IS NULL) AND (expires_at IS NOT NULL));


--
-- Name: execution_permits_live_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX execution_permits_live_idx ON public.execution_permits USING btree (class, user_id) WHERE (released_at IS NULL);


--
-- Name: field_packs_author_coordinate; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX field_packs_author_coordinate ON public.ozon_field_packs USING btree (author_user_id, description_category_id, type_id, language, updated_at_ms DESC);


--
-- Name: field_packs_coordinate_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX field_packs_coordinate_updated ON public.ozon_field_packs USING btree (description_category_id, type_id, language, updated_at_ms DESC);


--
-- Name: field_packs_one_active_per_coordinate; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX field_packs_one_active_per_coordinate ON public.ozon_field_packs USING btree (author_user_id, description_category_id, type_id, language) WHERE active;


--
-- Name: idx_billable_usage_events_org_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_billable_usage_events_org_period ON public.billable_usage_events USING btree (org_id, billing_period, metric);


--
-- Name: idx_billable_usage_rollups_org_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_billable_usage_rollups_org_period ON public.billable_usage_rollups USING btree (org_id, billing_period, metric);


--
-- Name: ix_account_sessions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_account_sessions_user ON public.account_sessions USING btree (user_id);


--
-- Name: ix_account_users_account_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_account_users_account_kind ON public.account_users USING btree (account_kind);


--
-- Name: ix_ai_requests_ocr_month; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_ai_requests_ocr_month ON public.ai_requests USING btree (org_id, created_at) WHERE (((operation)::text = 'ocr'::text) AND ((status)::text = ANY ((ARRAY['held'::character varying, 'dispatching'::character varying, 'settled'::character varying, 'unbilled_unknown'::character varying])::text[])));


--
-- Name: ix_ai_requests_response_body_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_ai_requests_response_body_due ON public.ai_requests USING btree (id) WHERE (response_body IS NOT NULL);


--
-- Name: ix_ai_requests_stranded; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_ai_requests_stranded ON public.ai_requests USING btree (updated_at, id) WHERE ((status)::text = ANY ((ARRAY['held'::character varying, 'dispatching'::character varying])::text[]));


--
-- Name: ix_audit_logs_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_audit_logs_org ON public.audit_logs USING btree (org_id, created_at_ms DESC);


--
-- Name: ix_audit_logs_support_grant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_audit_logs_support_grant_id ON public.audit_logs USING btree (support_grant_id);


--
-- Name: ix_audit_logs_support_grant_listing; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_audit_logs_support_grant_listing ON public.audit_logs USING btree (support_grant_id, created_at_ms) WHERE ((action)::text = 'support_write'::text);


--
-- Name: ix_auth_email_tokens_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_auth_email_tokens_open ON public.auth_email_tokens USING btree (user_id, purpose) WHERE (consumed_at IS NULL);


--
-- Name: ix_auth_login_attempts_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_auth_login_attempts_updated ON public.auth_login_attempts USING btree (updated_at);


--
-- Name: ix_billing_operations_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_billing_operations_org ON public.billing_operations USING btree (org_id);


--
-- Name: ix_billing_operations_reap; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_billing_operations_reap ON public.billing_operations USING btree (updated_at) WHERE ((state)::text = ANY ((ARRAY['reserved'::character varying, 'outcome_unknown'::character varying])::text[]));


--
-- Name: ix_category_prompts_leaf; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_category_prompts_leaf ON public.category_prompts USING btree (description_category_id, type_id);


--
-- Name: ix_category_videos_leaf; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_category_videos_leaf ON public.category_videos USING btree (description_category_id, type_id);


--
-- Name: ix_delegate_assets_binding; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_delegate_assets_binding ON public.delegate_assets USING btree (binding_id);


--
-- Name: ix_delegate_bindings_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_delegate_bindings_source ON public.delegate_bindings USING btree (source_id);


--
-- Name: ix_delegate_bindings_store; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_delegate_bindings_store ON public.delegate_bindings USING btree (org_id, store_id);


--
-- Name: ix_delegate_dispatch_assets_asset; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_delegate_dispatch_assets_asset ON public.delegate_dispatch_assets USING btree (asset_id);


--
-- Name: ix_delegate_dispatches_fulfiller; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_delegate_dispatches_fulfiller ON public.delegate_dispatches USING btree (fulfiller_id, state) WHERE (fulfiller_id IS NOT NULL);


--
-- Name: ix_delegate_dispatches_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_delegate_dispatches_order ON public.delegate_dispatches USING btree (order_id);


--
-- Name: ix_delegate_dispatches_source_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_delegate_dispatches_source_state ON public.delegate_dispatches USING btree (source_id, state);


--
-- Name: ix_delegate_order_lines_binding; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_delegate_order_lines_binding ON public.delegate_order_lines USING btree (binding_id);


--
-- Name: ix_delegate_order_lines_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_delegate_order_lines_order ON public.delegate_order_lines USING btree (order_id);


--
-- Name: ix_delegate_orders_store_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_delegate_orders_store_state ON public.delegate_orders USING btree (org_id, store_id, state);


--
-- Name: ix_delegate_settlements_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_delegate_settlements_order ON public.delegate_settlements USING btree (order_id, state);


--
-- Name: ix_event_inbox_events_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_event_inbox_events_org ON public.event_inbox_events USING btree (org_id, received_at DESC);


--
-- Name: ix_jobs_org_aggregate; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_jobs_org_aggregate ON public.jobs USING btree (org_id, aggregate_type, aggregate_id, kind);


--
-- Name: ix_jobs_org_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_jobs_org_updated ON public.jobs USING btree (org_id, updated_at, id);


--
-- Name: ix_listing_cards_org_updated_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_listing_cards_org_updated_id ON public.listing_cards USING btree (org_id, updated_at, id);


--
-- Name: ix_listing_field_templates_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_listing_field_templates_org ON public.ozon_listing_field_templates USING btree (org_id, category_id);


--
-- Name: ix_listing_rows_org_category_updated_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_listing_rows_org_category_updated_id ON public.listing_rows USING btree (org_id, category_key, updated_at, id);


--
-- Name: ix_listing_rows_org_updated_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_listing_rows_org_updated_id ON public.listing_rows USING btree (org_id, updated_at, id);


--
-- Name: ix_listing_rows_sendable; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_listing_rows_sendable ON public.listing_rows USING btree (org_id, updated_at) WHERE ((submission_state = ANY (ARRAY['queued'::text, 'submitting'::text, 'unknown'::text])) OR (media_state = 'ready'::text));


--
-- Name: ix_listing_schema_snapshots_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_listing_schema_snapshots_org ON public.ozon_listing_schema_snapshots USING btree (org_id, category_id);


--
-- Name: ix_media_object_leases_due_keyset; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_media_object_leases_due_keyset ON public.media_object_leases USING btree (expires_at, workspace_uuid, batch_id, content_hash) WHERE (deleted_at IS NULL);


--
-- Name: ix_media_object_leases_image_identity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_media_object_leases_image_identity ON public.media_object_leases USING btree (public.media_gc_image_identity(object_key));


--
-- Name: ix_media_object_leases_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_media_object_leases_lookup ON public.media_object_leases USING btree (org_id, media_account_id, md5(object_key));


--
-- Name: ix_media_object_leases_org_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_media_object_leases_org_hash ON public.media_object_leases USING btree (org_id, content_hash);


--
-- Name: ix_media_object_leases_stale_unretired_claim; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_media_object_leases_stale_unretired_claim ON public.media_object_leases USING btree (gc_claimed_at, workspace_uuid, batch_id, content_hash) WHERE ((retired_at IS NULL) AND (gc_claim_token IS NOT NULL));


--
-- Name: ix_media_object_leases_workspace_digest; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_media_object_leases_workspace_digest ON public.media_object_leases USING btree (workspace_uuid, content_hash);


--
-- Name: ix_notifications_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_notifications_user_created ON public.notifications USING btree (user_id, created_at);


--
-- Name: ix_notifications_user_unread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_notifications_user_unread ON public.notifications USING btree (user_id) WHERE ((read_at IS NULL) AND (dismissed_at IS NULL));


--
-- Name: ix_org_invitations_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_org_invitations_org ON public.org_invitations USING btree (org_id);


--
-- Name: ix_org_invitations_org_email_lower; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_org_invitations_org_email_lower ON public.org_invitations USING btree (org_id, lower((email)::text)) WHERE ((accepted_at IS NULL) AND (revoked_at IS NULL) AND (declined_at IS NULL));


--
-- Name: ix_org_members_owner_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_org_members_owner_user ON public.organization_members USING btree (user_id) WHERE ((role)::text = 'owner'::text);


--
-- Name: ix_organization_stores_assignee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_organization_stores_assignee ON public.organization_stores USING btree (org_id, assignee_membership_id) WHERE (deleted_at_ms IS NULL);


--
-- Name: ix_organization_stores_company_legal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_organization_stores_company_legal ON public.organization_stores USING btree (org_id, company_legal_name);


--
-- Name: ix_organization_stores_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_organization_stores_group ON public.organization_stores USING btree (group_id);


--
-- Name: ix_organizations_live_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_organizations_live_owner ON public.organizations USING btree (owner_user_id) WHERE (dissolved_at IS NULL);


--
-- Name: ix_payment_orders_org_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_payment_orders_org_created ON public.payment_orders USING btree (org_id, created_at);


--
-- Name: ix_sc_catalog_managers_source_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_sc_catalog_managers_source_active ON public.sc_catalog_managers USING btree (source_id) WHERE (status = 'active'::text);


--
-- Name: ix_sc_catalog_managers_user_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_sc_catalog_managers_user_active ON public.sc_catalog_managers USING btree (user_id) WHERE (status = 'active'::text);


--
-- Name: ix_sc_listing_bindings_org_store; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_sc_listing_bindings_org_store ON public.sc_listing_bindings USING btree (org_id, store_id);


--
-- Name: ix_sc_listing_bindings_sku; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_sc_listing_bindings_sku ON public.sc_listing_bindings USING btree (platform_sku_id);


--
-- Name: ix_sc_order_quotes_org_store; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_sc_order_quotes_org_store ON public.sc_order_quotes USING btree (org_id, store_id);


--
-- Name: ix_sc_orders_org_store; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_sc_orders_org_store ON public.sc_orders USING btree (org_id, store_id);


--
-- Name: ix_sc_orders_payment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_sc_orders_payment ON public.sc_orders USING btree (payment_order_public_id);


--
-- Name: ix_sc_price_versions_sku; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_sc_price_versions_sku ON public.sc_price_versions USING btree (sku_id, id DESC);


--
-- Name: ix_sc_procurements_org_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_sc_procurements_org_order ON public.sc_procurements USING btree (org_id, platform_order_id);


--
-- Name: ix_sc_products_published; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_sc_products_published ON public.sc_products USING btree (published);


--
-- Name: ix_sc_products_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_sc_products_source ON public.sc_products USING btree (source_id);


--
-- Name: ix_sc_skus_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_sc_skus_product ON public.sc_skus USING btree (product_id);


--
-- Name: ix_sc_skus_published; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_sc_skus_published ON public.sc_skus USING btree (published);


--
-- Name: ix_sc_source_members_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_sc_source_members_source ON public.sc_source_members USING btree (source_id);


--
-- Name: ix_sc_source_members_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_sc_source_members_user ON public.sc_source_members USING btree (user_id);


--
-- Name: ix_sc_source_prop_defs_source_position; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_sc_source_prop_defs_source_position ON public.sc_source_prop_defs USING btree (source_id, "position");


--
-- Name: ix_shipping_inject_operations_store; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_shipping_inject_operations_store ON public.shipping_inject_operations USING btree (store_uuid, preset_id, created_at_ms DESC);


--
-- Name: ix_shipping_shop_injections_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_shipping_shop_injections_org ON public.shipping_shop_injections USING btree (org_id, store_uuid);


--
-- Name: ix_shipping_sku_bindings_preset; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_shipping_sku_bindings_preset ON public.shipping_sku_bindings USING btree (preset_id);


--
-- Name: ix_storage_object_refs_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_storage_object_refs_owner ON public.storage_object_refs USING btree (owner_kind, owner_id);


--
-- Name: ix_storage_objects_live_age; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_storage_objects_live_age ON public.storage_objects USING btree (created_at) WHERE (state = 'live'::text);


--
-- Name: ix_storage_uploads_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_storage_uploads_expiry ON public.storage_uploads USING btree (expires_at) WHERE (state = 'pending'::text);


--
-- Name: ix_storage_uploads_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_storage_uploads_key ON public.storage_uploads USING btree (bucket_identity, object_key, state, expires_at);


--
-- Name: ix_store_seller_credentials_key_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_store_seller_credentials_key_id ON public.store_seller_credentials USING btree (key_id);


--
-- Name: ix_store_seller_credentials_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_store_seller_credentials_org ON public.store_seller_credentials USING btree (org_id, store_id);


--
-- Name: ix_store_tag_links_tag; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_store_tag_links_tag ON public.store_tag_links USING btree (tag_id);


--
-- Name: ix_submission_intents_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_submission_intents_due ON public.submission_intents USING btree (reconcile_after, updated_at, id) WHERE (state = ANY (ARRAY['unknown'::text, 'accepted'::text]));


--
-- Name: ix_submission_intents_org_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_submission_intents_org_updated ON public.submission_intents USING btree (org_id, updated_at, id);


--
-- Name: ix_supplier_ozon_configs_coordinate; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_supplier_ozon_configs_coordinate ON public.supplier_ozon_configs USING btree (description_category_id, type_id, language);


--
-- Name: ix_supplier_withdrawals_source_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_supplier_withdrawals_source_status ON public.supplier_withdrawals USING btree (source_id, status, requested_at_ms DESC);


--
-- Name: ix_support_grants_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_support_grants_org ON public.support_grants USING btree (org_id, created_at DESC);


--
-- Name: ix_support_grants_staff; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_support_grants_staff ON public.support_grants USING btree (staff_user_id, expires_at DESC);


--
-- Name: jobs_claim_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jobs_claim_idx ON public.jobs USING btree (kind, priority, run_at, created_at) WHERE (state = ANY (ARRAY['queued'::text, 'retry_wait'::text]));


--
-- Name: jobs_drain_member_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jobs_drain_member_idx ON public.jobs USING btree (org_id, member_id) WHERE (state = ANY (ARRAY['queued'::text, 'retry_wait'::text, 'running'::text]));


--
-- Name: jobs_drain_store_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jobs_drain_store_idx ON public.jobs USING btree (org_id, store_id) WHERE (state = ANY (ARRAY['queued'::text, 'retry_wait'::text, 'running'::text]));


--
-- Name: jobs_head_oldest_worker_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jobs_head_oldest_worker_idx ON public.jobs USING btree (submitter_user_id, lane, run_at) WHERE ((state = ANY (ARRAY['queued'::text, 'retry_wait'::text])) AND (NOT ((kind = ANY (ARRAY['media.render'::text, 'media.upload'::text])) AND (executor = 'browser'::text))));


--
-- Name: jobs_lease_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jobs_lease_expiry_idx ON public.jobs USING btree (lease_until) WHERE (state = 'running'::text);


--
-- Name: jobs_lease_expiry_kind_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jobs_lease_expiry_kind_idx ON public.jobs USING btree (kind, lease_until) WHERE (state = 'running'::text);


--
-- Name: jobs_org_command_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jobs_org_command_id_idx ON public.jobs USING btree (org_id, command_id) WHERE (command_id IS NOT NULL);


--
-- Name: jobs_org_input_fingerprint_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jobs_org_input_fingerprint_idx ON public.jobs USING btree (org_id, input_fingerprint) WHERE (input_fingerprint IS NOT NULL);


--
-- Name: jobs_terminal_payload_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jobs_terminal_payload_idx ON public.jobs USING btree (updated_at, id) WHERE (((state = ANY (ARRAY['succeeded'::text, 'cancelled'::text])) OR ((state = 'failed'::text) AND (attempt < max_attempts))) AND ((octet_length((payload)::text) > 512) OR ((result_ref IS NOT NULL) AND (kind <> ALL (ARRAY['media.render'::text, 'media.upload'::text])))));


--
-- Name: jobs_uncertain_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jobs_uncertain_idx ON public.jobs USING btree (kind, updated_at) WHERE (state = 'uncertain'::text);


--
-- Name: jobs_worker_claim_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jobs_worker_claim_idx ON public.jobs USING btree (submitter_user_id, lane, created_at, id, run_at, org_id) WHERE ((state = ANY (ARRAY['queued'::text, 'retry_wait'::text])) AND (cancel_requested_at IS NULL) AND (executor <> ALL (ARRAY['browser'::text, 'http'::text])) AND (attempt < max_attempts));


--
-- Name: lease_budget_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lease_budget_expiry_idx ON public.lease_budget USING btree (expires_at);


--
-- Name: lease_slot_scope_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lease_slot_scope_expiry_idx ON public.lease_slot USING btree (namespace, scope, expires_at);


--
-- Name: lease_window_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lease_window_expiry_idx ON public.lease_window USING btree (expires_at);


--
-- Name: listing_cards_one_supplier_product_per_org; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX listing_cards_one_supplier_product_per_org ON public.listing_cards USING btree (org_id, supplier_product_id) WHERE (supplier_product_id IS NOT NULL);


--
-- Name: listing_cards_org_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX listing_cards_org_updated_idx ON public.listing_cards USING btree (org_id, updated_at DESC);


--
-- Name: listing_current_media_job_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX listing_current_media_job_idx ON public.jobs USING btree (org_id, aggregate_id, ((payload ->> 'sourceSha256'::text)), ((payload ->> 'psdTemplateSha256'::text)), input_revision DESC, created_at DESC, id DESC) WHERE ((aggregate_type = 'listing_row'::text) AND (kind = ANY (ARRAY['media.render'::text, 'media.upload'::text])) AND ((payload ->> 'executor'::text) = 'browser'::text));


--
-- Name: listing_field_templates_official_category_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX listing_field_templates_official_category_uidx ON public.ozon_listing_field_templates USING btree (category_id) WHERE ((scope)::text = 'official'::text);


--
-- Name: listing_rows_model_value_hash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX listing_rows_model_value_hash_idx ON public.listing_rows USING hash (model_value) WHERE (model_value <> ''::text);


--
-- Name: listing_rows_one_create_key_per_card; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX listing_rows_one_create_key_per_card ON public.listing_rows USING btree (org_id, card_id, create_key) WHERE (create_key IS NOT NULL);


--
-- Name: listing_rows_org_association_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX listing_rows_org_association_idx ON public.listing_rows USING btree (org_id, association_id) WHERE (association_id IS NOT NULL);


--
-- Name: listing_rows_org_card_queue_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX listing_rows_org_card_queue_idx ON public.listing_rows USING btree (org_id, card_id, queue_position, created_at, id);


--
-- Name: listing_rows_org_category_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX listing_rows_org_category_updated_idx ON public.listing_rows USING btree (org_id, category_key, updated_at DESC);


--
-- Name: listing_rows_org_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX listing_rows_org_updated_idx ON public.listing_rows USING btree (org_id, updated_at DESC);


--
-- Name: listing_stream_retention_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX listing_stream_retention_idx ON public.listing_row_events USING btree (created_at);


--
-- Name: listing_stream_seq_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX listing_stream_seq_idx ON public.listing_row_events USING btree (org_id, stream_card_id, stream_seq);


--
-- Name: listing_stream_transaction_card_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX listing_stream_transaction_card_idx ON public.listing_row_events USING btree (stream_txid, org_id, stream_card_id) WHERE ((stream_seq IS NULL) AND ((payload ->> 'rowId'::text) IS NULL));


--
-- Name: listing_stream_transaction_row_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX listing_stream_transaction_row_idx ON public.listing_row_events USING btree (stream_txid, org_id, stream_card_id, ((payload ->> 'rowId'::text))) WHERE (stream_seq IS NULL);


--
-- Name: media_bindings_asset_live_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_bindings_asset_live_idx ON public.media_bindings USING btree (org_id, asset_id) WHERE (released_at IS NULL);


--
-- Name: media_bindings_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_bindings_entity_idx ON public.media_bindings USING btree (org_id, entity_type, entity_id) WHERE (released_at IS NULL);


--
-- Name: media_bindings_live_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX media_bindings_live_unique ON public.media_bindings USING btree (org_id, asset_id, entity_type, entity_id, purpose) WHERE (released_at IS NULL);


--
-- Name: media_blobs_org_state_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_blobs_org_state_idx ON public.media_blobs USING btree (org_id, state);


--
-- Name: media_lib_assets_blob_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_lib_assets_blob_idx ON public.media_lib_assets USING btree (blob_id) WHERE (deleted_at IS NULL);


--
-- Name: media_lib_assets_org_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_lib_assets_org_updated_idx ON public.media_lib_assets USING btree (org_id, updated_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: media_uploads_org_state_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_uploads_org_state_idx ON public.media_uploads USING btree (org_id, state, expires_at);


--
-- Name: org_invitations_pending_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX org_invitations_pending_email_idx ON public.org_invitations USING btree (email) WHERE ((accepted_at IS NULL) AND (revoked_at IS NULL) AND (declined_at IS NULL));


--
-- Name: org_invitations_pending_invitee_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX org_invitations_pending_invitee_idx ON public.org_invitations USING btree (invitee_user_id) WHERE ((accepted_at IS NULL) AND (revoked_at IS NULL) AND (declined_at IS NULL));


--
-- Name: org_invitations_pending_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX org_invitations_pending_uidx ON public.org_invitations USING btree (org_id, email) WHERE ((accepted_at IS NULL) AND (revoked_at IS NULL) AND (declined_at IS NULL));


--
-- Name: org_invitations_token_hash_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX org_invitations_token_hash_uidx ON public.org_invitations USING btree (token_hash);


--
-- Name: organizations_owner_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX organizations_owner_user_idx ON public.organizations USING btree (owner_user_id);


--
-- Name: ozon_delivery_methods_warehouse_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ozon_delivery_methods_warehouse_idx ON public.ozon_delivery_methods USING btree (org_id, store_id, warehouse_id);


--
-- Name: ozon_error_catalog_occurrences_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ozon_error_catalog_occurrences_idx ON public.ozon_error_catalog USING btree (occurrences DESC, source, code, attribute_id, description_category_id, type_id);


--
-- Name: ozon_error_catalog_seen_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ozon_error_catalog_seen_idx ON public.ozon_error_catalog USING btree (last_seen_at DESC, source, code, attribute_id, description_category_id, type_id);


--
-- Name: ozon_error_observation_org_occurrences_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ozon_error_observation_org_occurrences_idx ON public.ozon_error_observation USING btree (org_id, occurrences DESC, source, code);


--
-- Name: ozon_warehouse_intents_inflight; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ozon_warehouse_intents_inflight ON public.ozon_warehouse_intents USING btree (org_id, store_id, fence_warehouse_id) WHERE (state = ANY (ARRAY['granted'::text, 'unknown'::text]));


--
-- Name: ozon_warehouse_intents_operation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ozon_warehouse_intents_operation_idx ON public.ozon_warehouse_intents USING btree (org_id, store_id, ozon_operation_id) WHERE (ozon_operation_id IS NOT NULL);


--
-- Name: payment_orders_created_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payment_orders_created_by_idx ON public.payment_orders USING btree (created_by_user_id, created_at DESC);


--
-- Name: payment_orders_deadline_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payment_orders_deadline_idx ON public.payment_orders USING btree (payment_deadline_at) WHERE (((status)::text = 'pending'::text) AND (payment_deadline_at IS NOT NULL));


--
-- Name: payment_orders_one_pending_per_org_product; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX payment_orders_one_pending_per_org_product ON public.payment_orders USING btree (org_id, product) WHERE (((status)::text = 'pending'::text) AND ((product)::text <> 'platform_goods'::text));


--
-- Name: payment_orders_operation_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX payment_orders_operation_uidx ON public.payment_orders USING btree (org_id, operation_id) WHERE (operation_id IS NOT NULL);


--
-- Name: payment_orders_quote_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX payment_orders_quote_uidx ON public.payment_orders USING btree (quote_id) WHERE (quote_id IS NOT NULL);


--
-- Name: payment_orders_status_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payment_orders_status_created_idx ON public.payment_orders USING btree (status, created_at DESC);


--
-- Name: product_variant_previews_digest_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX product_variant_previews_digest_idx ON public.product_variant_previews USING btree (org_id, store_pk, digest);


--
-- Name: product_variant_previews_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX product_variant_previews_expiry_idx ON public.product_variant_previews USING btree (expires_at_ms);


--
-- Name: redeem_codes_batch_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX redeem_codes_batch_idx ON public.redeem_codes USING btree (batch_id);


--
-- Name: redeem_codes_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX redeem_codes_status_idx ON public.redeem_codes USING btree (used, expires_at, revoked_at, created_at DESC);


--
-- Name: seller_read_incidents_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX seller_read_incidents_at_idx ON public.seller_read_incidents USING btree (at_ms);


--
-- Name: seller_read_incidents_org_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX seller_read_incidents_org_at_idx ON public.seller_read_incidents USING btree (org_id, at_ms);


--
-- Name: seller_resource_occupancies_held_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX seller_resource_occupancies_held_key_idx ON public.seller_resource_occupancies USING btree (physical_account_key, resource_kind, resource_key) WHERE (state = 'held'::text);


--
-- Name: seller_resource_occupancies_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX seller_resource_occupancies_owner_idx ON public.seller_resource_occupancies USING btree (org_id, owner_kind, owner_ref) WHERE (state = 'held'::text);


--
-- Name: seller_upstream_writes_dispatch_stale_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX seller_upstream_writes_dispatch_stale_idx ON public.seller_upstream_writes USING btree (heartbeat_at_ms) WHERE (state = 'dispatching'::text);


--
-- Name: seller_upstream_writes_due_unknown_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX seller_upstream_writes_due_unknown_idx ON public.seller_upstream_writes USING btree (reconcile_after) WHERE (state = 'result_unknown'::text);


--
-- Name: seller_upstream_writes_observation_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX seller_upstream_writes_observation_due_idx ON public.seller_upstream_writes USING btree (observation_next_at, updated_at) WHERE (observation_state = ANY (ARRAY['pending'::text, 'partial'::text]));


--
-- Name: store_credential_verifications_summary_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX store_credential_verifications_summary_idx ON public.store_credential_verifications USING btree (org_id, store_id, credential_revision, verified_at_ms DESC);


--
-- Name: store_product_sync_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX store_product_sync_due_idx ON public.store_product_sync USING btree (next_due_at_ms) WHERE (next_due_at_ms IS NOT NULL);


--
-- Name: store_product_sync_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX store_product_sync_org_idx ON public.store_product_sync USING btree (org_id);


--
-- Name: store_products_model_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX store_products_model_idx ON public.store_products USING btree (store_pk, model_id) WHERE (model_id IS NOT NULL);


--
-- Name: store_products_offer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX store_products_offer_idx ON public.store_products USING btree (store_pk, offer_id);


--
-- Name: store_products_search_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX store_products_search_trgm_idx ON public.store_products USING gin (lower(((offer_id || ' '::text) || COALESCE(name, ''::text))) public.gin_trgm_ops) WHERE (gone_at_ms IS NULL);


--
-- Name: store_products_state_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX store_products_state_idx ON public.store_products USING btree (store_pk, status_id) WHERE (gone_at_ms IS NULL);


--
-- Name: store_rating_history_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX store_rating_history_key_idx ON public.store_rating_history USING btree (org_id, store_id, rating_key, id DESC);


--
-- Name: store_rating_history_recorded_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX store_rating_history_recorded_idx ON public.store_rating_history USING btree (recorded_at);


--
-- Name: store_rating_snapshots_store_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX store_rating_snapshots_store_idx ON public.store_rating_snapshots USING btree (org_id, store_id, rating_key);


--
-- Name: submission_intents_active_offer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX submission_intents_active_offer_idx ON public.submission_intents USING btree (org_id, store_id, offer_id) WHERE (state = ANY (ARRAY['queued'::text, 'submitting'::text, 'unknown'::text, 'accepted'::text]));


--
-- Name: submission_intents_latest_row_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX submission_intents_latest_row_idx ON public.submission_intents USING btree (org_id, listing_row_id, row_revision DESC, created_at DESC, id DESC);


--
-- Name: submission_intents_open_store_issues; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX submission_intents_open_store_issues ON public.submission_intents USING btree (org_id, store_id) WHERE (submission_issues @> '[{"scope": "store", "resolvedAtMs": null}]'::jsonb);


--
-- Name: submission_intents_org_card_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX submission_intents_org_card_created_idx ON public.submission_intents USING btree (org_id, card_id, created_at, id) WHERE (card_id IS NOT NULL);


--
-- Name: submission_intents_reconcile_group_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX submission_intents_reconcile_group_idx ON public.submission_intents USING btree (org_id, store_id, external_task_id) WHERE (state = ANY (ARRAY['unknown'::text, 'accepted'::text]));


--
-- Name: submission_intents_reconcile_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX submission_intents_reconcile_idx ON public.submission_intents USING btree (reconcile_after) WHERE (state = 'unknown'::text);


--
-- Name: subscription_events_order_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX subscription_events_order_uidx ON public.subscription_events USING btree (order_id) WHERE (order_id IS NOT NULL);


--
-- Name: subscription_events_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX subscription_events_org_idx ON public.subscription_events USING btree (org_id, effective_at DESC);


--
-- Name: subscription_quotes_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX subscription_quotes_expiry_idx ON public.subscription_quotes USING btree (expires_at) WHERE (consumed_at IS NULL);


--
-- Name: subscription_quotes_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX subscription_quotes_org_idx ON public.subscription_quotes USING btree (org_id, created_at DESC);


--
-- Name: subscriptions_active_end_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX subscriptions_active_end_idx ON public.subscriptions USING btree (term_end) WHERE (status = 'active'::text);


--
-- Name: subscriptions_expired_end_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX subscriptions_expired_end_idx ON public.subscriptions USING btree (term_end) WHERE (status = 'expired'::text);


--
-- Name: supplier_media_objects_digest_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX supplier_media_objects_digest_idx ON public.supplier_media_objects USING btree (product_id, content_sha256);


--
-- Name: support_grants_live_staff_org_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX support_grants_live_staff_org_uidx ON public.support_grants USING btree (staff_user_id, org_id) WHERE (revoked_at IS NULL);


--
-- Name: uq_account_users_email; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_account_users_email ON public.account_users USING btree (email);


--
-- Name: uq_account_users_email_lower; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_account_users_email_lower ON public.account_users USING btree (lower((email)::text));


--
-- Name: uq_billable_usage_event; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_billable_usage_event ON public.billable_usage_events USING btree (org_id, user_id, event_id, metric);


--
-- Name: uq_billable_usage_rollup; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_billable_usage_rollup ON public.billable_usage_rollups USING btree (org_id, user_id, billing_period, metric, unit, verification);


--
-- Name: uq_notifications_invitation; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_notifications_invitation ON public.notifications USING btree (user_id, invitation_id) WHERE (invitation_id IS NOT NULL);


--
-- Name: uq_org_members_join_order; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_org_members_join_order ON public.organization_members USING btree (org_id, join_order);


--
-- Name: uq_org_members_one_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_org_members_one_owner ON public.organization_members USING btree (org_id) WHERE ((role)::text = 'owner'::text);


--
-- Name: uq_org_members_org_user; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_org_members_org_user ON public.organization_members USING btree (org_id, user_id);


--
-- Name: uq_organization_stores_create_order; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_organization_stores_create_order ON public.organization_stores USING btree (org_id, create_order);


--
-- Name: uq_organization_stores_live_client_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_organization_stores_live_client_id ON public.organization_stores USING btree (org_id, client_id) WHERE ((client_id IS NOT NULL) AND (deleted_at_ms IS NULL));


--
-- Name: uq_redeem_codes_code; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_redeem_codes_code ON public.redeem_codes USING btree (code);


--
-- Name: ux_category_prompts_prompt_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_category_prompts_prompt_id ON public.category_prompts USING btree (prompt_id);


--
-- Name: ux_category_videos_video_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_category_videos_video_id ON public.category_videos USING btree (video_id);


--
-- Name: ux_delegate_dispatches_live; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_delegate_dispatches_live ON public.delegate_dispatches USING btree (order_id, source_id) WHERE (state = 'dispatched'::text);


--
-- Name: ux_sc_procurements_live_unit; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_sc_procurements_live_unit ON public.sc_procurements USING btree (platform_order_id, line_no) WHERE (status = ANY (ARRAY['prepared'::text, 'dispatching'::text, 'unknown'::text]));


--
-- Name: ux_sc_products_variant_group_size; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_sc_products_variant_group_size ON public.sc_products USING btree (source_id, variant_group, size) WHERE ((variant_group <> ''::text) AND (archived = false));


--
-- Name: ux_sc_source_fulfillers_one_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_sc_source_fulfillers_one_active ON public.sc_source_fulfillers USING btree (source_id) WHERE (status = 'active'::text);


--
-- Name: ux_shipping_inject_operations_inflight; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_shipping_inject_operations_inflight ON public.shipping_inject_operations USING btree (store_uuid, preset_id) WHERE (status = ANY (ARRAY['queued'::text, 'submitting'::text, 'waiting'::text]));


--
-- Name: ux_storage_uploads_live; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_storage_uploads_live ON public.storage_uploads USING btree (bucket_identity, object_key, actor_id, purpose_kind, purpose_id) WHERE (state = ANY (ARRAY['pending'::text, 'confirmed'::text]));


--
-- Name: ux_supplier_withdrawals_one_open; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_supplier_withdrawals_one_open ON public.supplier_withdrawals USING btree (source_id) WHERE (status = 'requested'::text);


--
-- Name: wallet_ledger_org_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wallet_ledger_org_created_idx ON public.wallet_ledger USING btree (org_id, created_at DESC);


--
-- Name: wallet_ledger_user_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wallet_ledger_user_type_idx ON public.wallet_ledger USING btree (user_id, entry_type);


--
-- Name: writer_leases_active_domain_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX writer_leases_active_domain_uidx ON public.writer_leases USING btree (domain) WHERE (revoked_at_ms IS NULL);


--
-- Name: account_users account_users_attribution_no_rewrite; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER account_users_attribution_no_rewrite BEFORE UPDATE OF invited_by_agent_user_id ON public.account_users FOR EACH ROW EXECUTE FUNCTION public.account_users_attribution_is_write_once();


--
-- Name: account_users account_users_sync_side_tables; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER account_users_sync_side_tables AFTER INSERT OR UPDATE OF password_hash, name, target, supplier_id, active_org_id, updated_at ON public.account_users FOR EACH ROW EXECUTE FUNCTION public.sync_account_side_tables();


--
-- Name: agent_commission_ledger agent_commission_ledger_no_rewrite; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER agent_commission_ledger_no_rewrite BEFORE DELETE OR UPDATE ON public.agent_commission_ledger FOR EACH ROW EXECUTE FUNCTION public.agent_commission_ledger_is_immutable();


--
-- Name: automation_grants automation_grant_authority_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER automation_grant_authority_immutable BEFORE UPDATE ON public.automation_grants FOR EACH ROW EXECUTE FUNCTION public.automation_grant_authority_immutable();


--
-- Name: ai_image_set_items image_owner; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER image_owner BEFORE INSERT OR UPDATE ON public.ai_image_set_items FOR EACH ROW EXECUTE FUNCTION public.check_ai_image_owner();


--
-- Name: ai_image_sets image_owner; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER image_owner BEFORE INSERT OR UPDATE ON public.ai_image_sets FOR EACH ROW EXECUTE FUNCTION public.check_ai_image_owner();


--
-- Name: jobs jobs_account_queue_head; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER jobs_account_queue_head AFTER INSERT OR DELETE OR UPDATE OF state, cost_units, lane, submitter_user_id ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.refresh_account_queue_head();


--
-- Name: jobs jobs_wake_after_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER jobs_wake_after_insert AFTER INSERT ON public.jobs FOR EACH ROW WHEN (((new.state = 'queued'::text) AND (COALESCE((new.payload ->> 'executor'::text), ''::text) <> ALL (ARRAY['browser'::text, 'http'::text])))) EXECUTE FUNCTION public.notify_ozon_jobs_wake();


--
-- Name: listing_cards listing_card_stream_stage; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER listing_card_stream_stage AFTER UPDATE OF payload ON public.listing_cards FOR EACH ROW WHEN (((old.payload ->> 'psdTemplateSha256'::text) IS DISTINCT FROM (new.payload ->> 'psdTemplateSha256'::text))) EXECUTE FUNCTION public.stage_listing_card_event();


--
-- Name: organization_stores listing_credential_issues_resolved; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER listing_credential_issues_resolved AFTER UPDATE OF credential_revision ON public.organization_stores FOR EACH ROW WHEN ((old.credential_revision IS DISTINCT FROM new.credential_revision)) EXECUTE FUNCTION public.resolve_listing_credential_issues();


--
-- Name: submission_intents listing_intent_view_revision; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER listing_intent_view_revision AFTER INSERT OR DELETE OR UPDATE ON public.submission_intents FOR EACH ROW EXECUTE FUNCTION public.touch_listing_intent_row();


--
-- Name: listing_rows listing_row_stream_stage; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER listing_row_stream_stage AFTER INSERT OR DELETE OR UPDATE ON public.listing_rows FOR EACH ROW EXECUTE FUNCTION public.stage_listing_row_event();


--
-- Name: listing_row_events listing_stream_commit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER listing_stream_commit AFTER INSERT ON public.listing_row_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.seal_listing_row_events();


--
-- Name: listing_rows listing_view_revision; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER listing_view_revision BEFORE UPDATE ON public.listing_rows FOR EACH ROW EXECUTE FUNCTION public.bump_listing_view_revision();


--
-- Name: media_object_leases media_lease_reference_fence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER media_lease_reference_fence BEFORE INSERT OR DELETE OR UPDATE ON public.media_object_leases FOR EACH ROW EXECUTE FUNCTION public.guard_media_lease_reference_identity();


--
-- Name: media_object_leases media_lease_retirement_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER media_lease_retirement_guard BEFORE INSERT OR DELETE OR UPDATE ON public.media_object_leases FOR EACH ROW EXECUTE FUNCTION public.guard_media_lease_retirement();


--
-- Name: media_object_leases media_lease_retirement_truncate_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER media_lease_retirement_truncate_guard BEFORE TRUNCATE ON public.media_object_leases FOR EACH STATEMENT EXECUTE FUNCTION public.guard_media_lease_retirement();


--
-- Name: jobs media_reference_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER media_reference_guard BEFORE INSERT OR UPDATE ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.guard_media_reference_write();


--
-- Name: listing_rows media_reference_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER media_reference_guard BEFORE INSERT OR UPDATE ON public.listing_rows FOR EACH ROW EXECUTE FUNCTION public.guard_media_reference_write();


--
-- Name: media_blobs media_reference_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER media_reference_guard BEFORE INSERT OR UPDATE ON public.media_blobs FOR EACH ROW EXECUTE FUNCTION public.guard_media_reference_write();


--
-- Name: media_uploads media_reference_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER media_reference_guard BEFORE INSERT OR UPDATE ON public.media_uploads FOR EACH ROW EXECUTE FUNCTION public.guard_media_reference_write();


--
-- Name: store_products media_reference_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER media_reference_guard BEFORE INSERT OR UPDATE ON public.store_products FOR EACH ROW EXECUTE FUNCTION public.guard_media_reference_write();


--
-- Name: supplier_media_objects media_reference_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER media_reference_guard BEFORE INSERT OR UPDATE ON public.supplier_media_objects FOR EACH ROW EXECUTE FUNCTION public.guard_media_reference_write();


--
-- Name: payment_orders payment_order_agreement_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER payment_order_agreement_immutable BEFORE UPDATE OF purchase_agreement ON public.payment_orders FOR EACH ROW EXECUTE FUNCTION public.payment_order_agreement_immutable();


--
-- Name: payment_orders payment_order_subscription_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER payment_order_subscription_immutable BEFORE UPDATE OF subscription_snapshot ON public.payment_orders FOR EACH ROW EXECUTE FUNCTION public.payment_order_subscription_immutable();


--
-- Name: prompt_revisions prompt_revisions_no_rewrite; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER prompt_revisions_no_rewrite BEFORE DELETE OR UPDATE ON public.prompt_revisions FOR EACH ROW EXECUTE FUNCTION public.prompt_revisions_append_only();


--
-- Name: ai_image_set_items storage_ref_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER storage_ref_sync AFTER INSERT OR DELETE OR UPDATE OF object_id ON public.ai_image_set_items FOR EACH ROW EXECUTE FUNCTION public.sync_storage_object_refs('ai_image_item', 'object_id', 'id', 'org_id');


--
-- Name: ai_image_sets storage_ref_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER storage_ref_sync AFTER INSERT OR DELETE OR UPDATE OF source_object_id ON public.ai_image_sets FOR EACH ROW EXECUTE FUNCTION public.sync_storage_object_refs('ai_image_set', 'source_object_id', 'id', 'org_id');


--
-- Name: workspace_psd_templates storage_ref_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER storage_ref_sync AFTER INSERT OR DELETE OR UPDATE OF object_id ON public.workspace_psd_templates FOR EACH ROW EXECUTE FUNCTION public.sync_storage_object_refs('psd_template', 'object_id', 'id', 'org_id');


--
-- Name: submission_intents submission_intents_offer_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER submission_intents_offer_guard BEFORE INSERT OR UPDATE OF state, offer_id ON public.submission_intents FOR EACH ROW EXECUTE FUNCTION public.guard_submission_offer();


--
-- Name: sc_sources trg_sc_sources_manager_pin_flags; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sc_sources_manager_pin_flags BEFORE UPDATE ON public.sc_sources FOR EACH ROW EXECUTE FUNCTION public.sc_sources_manager_pin_flags();


--
-- Name: wallet_ledger wallet_ledger_no_rewrite; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER wallet_ledger_no_rewrite BEFORE DELETE OR UPDATE ON public.wallet_ledger FOR EACH ROW EXECUTE FUNCTION public.wallet_ledger_is_immutable();


--
-- Name: account_admin_totp account_admin_totp_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_admin_totp
    ADD CONSTRAINT account_admin_totp_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.account_users(id) ON DELETE CASCADE;


--
-- Name: account_credentials account_credentials_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_credentials
    ADD CONSTRAINT account_credentials_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.account_users(id) ON DELETE CASCADE;


--
-- Name: account_profiles account_profiles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_profiles
    ADD CONSTRAINT account_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.account_users(id) ON DELETE CASCADE;


--
-- Name: account_users account_users_invited_by_agent_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_users
    ADD CONSTRAINT account_users_invited_by_agent_user_id_fkey FOREIGN KEY (invited_by_agent_user_id) REFERENCES public.account_users(id);


--
-- Name: agent_commission_ledger agent_commission_ledger_commission_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_commission_ledger
    ADD CONSTRAINT agent_commission_ledger_commission_id_fkey FOREIGN KEY (commission_id) REFERENCES public.agent_commissions(id);


--
-- Name: agent_commission_ledger agent_commission_ledger_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_commission_ledger
    ADD CONSTRAINT agent_commission_ledger_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.account_users(id);


--
-- Name: agent_commission_ledger agent_commission_ledger_withdrawal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_commission_ledger
    ADD CONSTRAINT agent_commission_ledger_withdrawal_id_fkey FOREIGN KEY (withdrawal_id) REFERENCES public.agent_withdrawals(id);


--
-- Name: agent_commission_wallets agent_commission_wallets_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_commission_wallets
    ADD CONSTRAINT agent_commission_wallets_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.account_users(id);


--
-- Name: agent_commissions agent_commissions_agent_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_commissions
    ADD CONSTRAINT agent_commissions_agent_user_id_fkey FOREIGN KEY (agent_user_id) REFERENCES public.account_users(id);


--
-- Name: agent_commissions agent_commissions_invitee_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_commissions
    ADD CONSTRAINT agent_commissions_invitee_user_id_fkey FOREIGN KEY (invitee_user_id) REFERENCES public.account_users(id);


--
-- Name: agent_commissions agent_commissions_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_commissions
    ADD CONSTRAINT agent_commissions_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: agent_commissions agent_commissions_payment_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_commissions
    ADD CONSTRAINT agent_commissions_payment_order_id_fkey FOREIGN KEY (payment_order_id) REFERENCES public.payment_orders(id);


--
-- Name: agent_rebate_policy agent_rebate_policy_updated_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_rebate_policy
    ADD CONSTRAINT agent_rebate_policy_updated_by_user_id_fkey FOREIGN KEY (updated_by_user_id) REFERENCES public.account_users(id);


--
-- Name: agent_withdrawals agent_withdrawals_decided_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_withdrawals
    ADD CONSTRAINT agent_withdrawals_decided_by_user_id_fkey FOREIGN KEY (decided_by_user_id) REFERENCES public.account_users(id);


--
-- Name: agent_withdrawals agent_withdrawals_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_withdrawals
    ADD CONSTRAINT agent_withdrawals_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.account_users(id);


--
-- Name: agents agents_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.account_users(id);


--
-- Name: agents agents_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.account_users(id);


--
-- Name: ai_billing_ratio_documents ai_billing_ratio_documents_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_billing_ratio_documents
    ADD CONSTRAINT ai_billing_ratio_documents_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: ai_consume_logs ai_consume_logs_ai_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_consume_logs
    ADD CONSTRAINT ai_consume_logs_ai_request_id_fkey FOREIGN KEY (ai_request_id) REFERENCES public.ai_requests(id);


--
-- Name: ai_consume_logs ai_consume_logs_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_consume_logs
    ADD CONSTRAINT ai_consume_logs_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: ai_consume_logs ai_consume_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_consume_logs
    ADD CONSTRAINT ai_consume_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.account_users(id);


--
-- Name: ai_image_set_items ai_image_set_items_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_image_set_items
    ADD CONSTRAINT ai_image_set_items_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.storage_objects(id);


--
-- Name: ai_image_set_items ai_image_set_items_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_image_set_items
    ADD CONSTRAINT ai_image_set_items_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: ai_image_set_items ai_image_set_items_set_id_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_image_set_items
    ADD CONSTRAINT ai_image_set_items_set_id_org_id_fkey FOREIGN KEY (set_id, org_id) REFERENCES public.ai_image_sets(id, org_id);


--
-- Name: ai_image_sets ai_image_sets_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_image_sets
    ADD CONSTRAINT ai_image_sets_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: ai_image_sets ai_image_sets_source_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_image_sets
    ADD CONSTRAINT ai_image_sets_source_object_id_fkey FOREIGN KEY (source_object_id) REFERENCES public.storage_objects(id);


--
-- Name: ai_image_sets ai_image_sets_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_image_sets
    ADD CONSTRAINT ai_image_sets_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.account_users(id);


--
-- Name: ai_price_schedules ai_price_schedules_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_price_schedules
    ADD CONSTRAINT ai_price_schedules_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.account_users(id);


--
-- Name: ai_requests ai_requests_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_requests
    ADD CONSTRAINT ai_requests_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id);


--
-- Name: ai_requests ai_requests_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_requests
    ADD CONSTRAINT ai_requests_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: ai_requests ai_requests_price_schedule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_requests
    ADD CONSTRAINT ai_requests_price_schedule_id_fkey FOREIGN KEY (price_schedule_id) REFERENCES public.ai_price_schedules(id);


--
-- Name: ai_requests ai_requests_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_requests
    ADD CONSTRAINT ai_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.account_users(id);


--
-- Name: audit_logs audit_logs_support_grant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_support_grant_id_fkey FOREIGN KEY (support_grant_id) REFERENCES public.support_grants(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: auth_email_tokens auth_email_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_email_tokens
    ADD CONSTRAINT auth_email_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.account_users(id) ON DELETE CASCADE;


--
-- Name: automation_asset_set_items automation_asset_set_items_runtime_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_asset_set_items
    ADD CONSTRAINT automation_asset_set_items_runtime_id_fkey FOREIGN KEY (runtime_id) REFERENCES public.automation_runtimes(id) ON DELETE SET NULL;


--
-- Name: automation_asset_set_items automation_asset_set_items_set_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_asset_set_items
    ADD CONSTRAINT automation_asset_set_items_set_id_fkey FOREIGN KEY (set_id) REFERENCES public.automation_asset_sets(id) ON DELETE CASCADE;


--
-- Name: automation_call_receipts automation_call_receipts_execution_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_call_receipts
    ADD CONSTRAINT automation_call_receipts_execution_fk FOREIGN KEY (grant_id, execution_id) REFERENCES public.automation_executions(grant_id, execution_id) ON DELETE RESTRICT;


--
-- Name: automation_executions automation_executions_grant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_executions
    ADD CONSTRAINT automation_executions_grant_id_fkey FOREIGN KEY (grant_id) REFERENCES public.automation_grants(id) ON DELETE RESTRICT;


--
-- Name: automation_runtimes automation_runtimes_grant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_runtimes
    ADD CONSTRAINT automation_runtimes_grant_id_fkey FOREIGN KEY (grant_id) REFERENCES public.automation_grants(id) ON DELETE CASCADE;


--
-- Name: billing_operations billing_operations_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_operations
    ADD CONSTRAINT billing_operations_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: client_listing_logs client_listing_logs_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_listing_logs
    ADD CONSTRAINT client_listing_logs_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: client_listing_logs client_listing_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_listing_logs
    ADD CONSTRAINT client_listing_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.account_users(id) ON DELETE CASCADE;


--
-- Name: console_store_metrics console_store_metrics_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.console_store_metrics
    ADD CONSTRAINT console_store_metrics_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: delegate_assets delegate_assets_binding_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegate_assets
    ADD CONSTRAINT delegate_assets_binding_id_fkey FOREIGN KEY (binding_id) REFERENCES public.delegate_bindings(binding_id) ON DELETE CASCADE;


--
-- Name: delegate_assets delegate_assets_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegate_assets
    ADD CONSTRAINT delegate_assets_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;


--
-- Name: delegate_bindings delegate_bindings_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegate_bindings
    ADD CONSTRAINT delegate_bindings_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.account_users(id);


--
-- Name: delegate_bindings delegate_bindings_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegate_bindings
    ADD CONSTRAINT delegate_bindings_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;


--
-- Name: delegate_bindings delegate_bindings_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegate_bindings
    ADD CONSTRAINT delegate_bindings_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.sc_sources(source_id) ON DELETE RESTRICT;


--
-- Name: delegate_dispatch_assets delegate_dispatch_assets_dispatch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegate_dispatch_assets
    ADD CONSTRAINT delegate_dispatch_assets_dispatch_id_fkey FOREIGN KEY (dispatch_id) REFERENCES public.delegate_dispatches(dispatch_id) ON DELETE CASCADE;


--
-- Name: delegate_dispatches delegate_dispatches_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegate_dispatches
    ADD CONSTRAINT delegate_dispatches_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.delegate_orders(order_id) ON DELETE CASCADE;


--
-- Name: delegate_dispatches delegate_dispatches_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegate_dispatches
    ADD CONSTRAINT delegate_dispatches_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;


--
-- Name: delegate_dispatches delegate_dispatches_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegate_dispatches
    ADD CONSTRAINT delegate_dispatches_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.sc_sources(source_id) ON DELETE RESTRICT;


--
-- Name: delegate_order_lines delegate_order_lines_binding_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegate_order_lines
    ADD CONSTRAINT delegate_order_lines_binding_id_fkey FOREIGN KEY (binding_id) REFERENCES public.delegate_bindings(binding_id) ON DELETE RESTRICT;


--
-- Name: delegate_order_lines delegate_order_lines_last_rejected_fulfiller_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegate_order_lines
    ADD CONSTRAINT delegate_order_lines_last_rejected_fulfiller_id_fkey FOREIGN KEY (last_rejected_fulfiller_id) REFERENCES public.sc_source_fulfillers(fulfiller_id) ON DELETE SET NULL;


--
-- Name: delegate_order_lines delegate_order_lines_last_rejected_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegate_order_lines
    ADD CONSTRAINT delegate_order_lines_last_rejected_source_id_fkey FOREIGN KEY (last_rejected_source_id) REFERENCES public.sc_sources(source_id) ON DELETE SET NULL;


--
-- Name: delegate_order_lines delegate_order_lines_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegate_order_lines
    ADD CONSTRAINT delegate_order_lines_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.delegate_orders(order_id) ON DELETE CASCADE;


--
-- Name: delegate_order_lines delegate_order_lines_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegate_order_lines
    ADD CONSTRAINT delegate_order_lines_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;


--
-- Name: delegate_orders delegate_orders_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegate_orders
    ADD CONSTRAINT delegate_orders_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;


--
-- Name: delegate_settlements delegate_settlements_dispatch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegate_settlements
    ADD CONSTRAINT delegate_settlements_dispatch_id_fkey FOREIGN KEY (dispatch_id) REFERENCES public.delegate_dispatches(dispatch_id);


--
-- Name: delegate_settlements delegate_settlements_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegate_settlements
    ADD CONSTRAINT delegate_settlements_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.delegate_orders(order_id);


--
-- Name: delegate_settlements delegate_settlements_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegate_settlements
    ADD CONSTRAINT delegate_settlements_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: delegate_settlements delegate_settlements_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegate_settlements
    ADD CONSTRAINT delegate_settlements_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.sc_sources(source_id);


--
-- Name: error_digest error_digest_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.error_digest
    ADD CONSTRAINT error_digest_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: delegate_dispatches fk_delegate_dispatches_fulfiller; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegate_dispatches
    ADD CONSTRAINT fk_delegate_dispatches_fulfiller FOREIGN KEY (source_id, fulfiller_id) REFERENCES public.sc_source_fulfillers(source_id, fulfiller_id) ON DELETE RESTRICT;


--
-- Name: ai_image_set_items image_request_tenant; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_image_set_items
    ADD CONSTRAINT image_request_tenant FOREIGN KEY (request_id, org_id) REFERENCES public.ai_requests(id, org_id);


--
-- Name: jobs jobs_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.organization_members(id) ON DELETE SET NULL;


--
-- Name: jobs jobs_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: jobs jobs_store_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_store_id_fkey FOREIGN KEY (store_id) REFERENCES public.organization_stores(uuid) ON DELETE SET NULL;


--
-- Name: listing_cards listing_cards_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_cards
    ADD CONSTRAINT listing_cards_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: listing_rows listing_rows_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_rows
    ADD CONSTRAINT listing_rows_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: media_bindings media_bindings_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_bindings
    ADD CONSTRAINT media_bindings_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.media_lib_assets(id);


--
-- Name: media_bindings media_bindings_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_bindings
    ADD CONSTRAINT media_bindings_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: media_blobs media_blobs_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_blobs
    ADD CONSTRAINT media_blobs_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: media_lib_assets media_lib_assets_blob_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_lib_assets
    ADD CONSTRAINT media_lib_assets_blob_id_fkey FOREIGN KEY (blob_id) REFERENCES public.media_blobs(id);


--
-- Name: media_lib_assets media_lib_assets_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_lib_assets
    ADD CONSTRAINT media_lib_assets_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: media_object_leases media_object_leases_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_object_leases
    ADD CONSTRAINT media_object_leases_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: media_uploads media_uploads_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_uploads
    ADD CONSTRAINT media_uploads_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.media_lib_assets(id);


--
-- Name: media_uploads media_uploads_blob_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_uploads
    ADD CONSTRAINT media_uploads_blob_id_fkey FOREIGN KEY (blob_id) REFERENCES public.media_blobs(id);


--
-- Name: media_uploads media_uploads_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_uploads
    ADD CONSTRAINT media_uploads_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: notifications notifications_invitation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_invitation_id_fkey FOREIGN KEY (invitation_id) REFERENCES public.org_invitations(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.account_users(id) ON DELETE CASCADE;


--
-- Name: org_invitations org_invitations_invitee_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_invitations
    ADD CONSTRAINT org_invitations_invitee_user_id_fkey FOREIGN KEY (invitee_user_id) REFERENCES public.account_users(id) ON DELETE CASCADE;


--
-- Name: organization_store_groups organization_store_groups_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_store_groups
    ADD CONSTRAINT organization_store_groups_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: organization_store_tags organization_store_tags_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_store_tags
    ADD CONSTRAINT organization_store_tags_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: organization_stores organization_stores_assignee_membership_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_stores
    ADD CONSTRAINT organization_stores_assignee_membership_id_fkey FOREIGN KEY (assignee_membership_id) REFERENCES public.organization_members(id) ON DELETE RESTRICT;


--
-- Name: organization_stores organization_stores_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_stores
    ADD CONSTRAINT organization_stores_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.organization_store_groups(id) ON DELETE SET NULL;


--
-- Name: organization_stores organization_stores_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_stores
    ADD CONSTRAINT organization_stores_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: organizations organizations_plan_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_plan_fkey FOREIGN KEY (plan) REFERENCES public.plans(key);


--
-- Name: ozon_delivery_methods ozon_delivery_methods_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ozon_delivery_methods
    ADD CONSTRAINT ozon_delivery_methods_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: ozon_dictionary_current ozon_dictionary_current_category_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ozon_dictionary_current
    ADD CONSTRAINT ozon_dictionary_current_category_fkey FOREIGN KEY (description_category_id, type_id, language) REFERENCES public.ozon_category_current(description_category_id, type_id, language) ON DELETE CASCADE;


--
-- Name: ozon_error_observation ozon_error_observation_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ozon_error_observation
    ADD CONSTRAINT ozon_error_observation_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: ozon_error_sighting ozon_error_sighting_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ozon_error_sighting
    ADD CONSTRAINT ozon_error_sighting_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: ozon_listing_field_templates ozon_recipe_schema_snapshot; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ozon_listing_field_templates
    ADD CONSTRAINT ozon_recipe_schema_snapshot FOREIGN KEY (schema_snapshot_id, category_id) REFERENCES public.ozon_listing_schema_snapshots(id, category_id);


--
-- Name: ozon_warehouse_fences ozon_warehouse_fences_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ozon_warehouse_fences
    ADD CONSTRAINT ozon_warehouse_fences_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: ozon_warehouse_intents ozon_warehouse_intents_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ozon_warehouse_intents
    ADD CONSTRAINT ozon_warehouse_intents_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: ozon_warehouse_sync ozon_warehouse_sync_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ozon_warehouse_sync
    ADD CONSTRAINT ozon_warehouse_sync_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: ozon_warehouses ozon_warehouses_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ozon_warehouses
    ADD CONSTRAINT ozon_warehouses_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: payment_orders payment_orders_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_orders
    ADD CONSTRAINT payment_orders_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.account_users(id);


--
-- Name: payment_orders payment_orders_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_orders
    ADD CONSTRAINT payment_orders_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: payment_orders payment_orders_plan_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_orders
    ADD CONSTRAINT payment_orders_plan_fkey FOREIGN KEY (plan) REFERENCES public.plans(key);


--
-- Name: payment_orders payment_orders_quote_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_orders
    ADD CONSTRAINT payment_orders_quote_id_fkey FOREIGN KEY (quote_id) REFERENCES public.subscription_quotes(id);


--
-- Name: platform_catalog_fetch_keys platform_catalog_fetch_keys_config_singleton_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_catalog_fetch_keys
    ADD CONSTRAINT platform_catalog_fetch_keys_config_singleton_fkey FOREIGN KEY (config_singleton) REFERENCES public.platform_catalog_fetch_config(singleton) ON DELETE CASCADE;


--
-- Name: platform_initialization platform_initialization_owner_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_initialization
    ADD CONSTRAINT platform_initialization_owner_account_id_fkey FOREIGN KEY (owner_account_id) REFERENCES public.account_users(id);


--
-- Name: product_variant_previews product_variant_previews_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_variant_previews
    ADD CONSTRAINT product_variant_previews_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: product_variant_previews product_variant_previews_store_pk_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_variant_previews
    ADD CONSTRAINT product_variant_previews_store_pk_fkey FOREIGN KEY (store_pk) REFERENCES public.organization_stores(id);


--
-- Name: prompt_revisions prompt_revisions_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_revisions
    ADD CONSTRAINT prompt_revisions_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.sc_products(product_id) ON DELETE CASCADE;


--
-- Name: sc_catalog_managers sc_catalog_managers_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_catalog_managers
    ADD CONSTRAINT sc_catalog_managers_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.account_users(id) ON DELETE RESTRICT;


--
-- Name: sc_catalog_managers sc_catalog_managers_revoked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_catalog_managers
    ADD CONSTRAINT sc_catalog_managers_revoked_by_fkey FOREIGN KEY (revoked_by) REFERENCES public.account_users(id) ON DELETE RESTRICT;


--
-- Name: sc_catalog_managers sc_catalog_managers_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_catalog_managers
    ADD CONSTRAINT sc_catalog_managers_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.sc_sources(source_id) ON DELETE RESTRICT;


--
-- Name: sc_catalog_managers sc_catalog_managers_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_catalog_managers
    ADD CONSTRAINT sc_catalog_managers_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.account_users(id) ON DELETE RESTRICT;


--
-- Name: sc_listing_bindings sc_listing_bindings_listing_row_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_listing_bindings
    ADD CONSTRAINT sc_listing_bindings_listing_row_id_fkey FOREIGN KEY (listing_row_id) REFERENCES public.listing_rows(id) ON DELETE CASCADE;


--
-- Name: sc_listing_bindings sc_listing_bindings_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_listing_bindings
    ADD CONSTRAINT sc_listing_bindings_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;


--
-- Name: sc_listing_bindings sc_listing_bindings_platform_sku_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_listing_bindings
    ADD CONSTRAINT sc_listing_bindings_platform_sku_id_fkey FOREIGN KEY (platform_sku_id) REFERENCES public.sc_skus(sku_id) ON DELETE RESTRICT;


--
-- Name: sc_order_lines sc_order_lines_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_order_lines
    ADD CONSTRAINT sc_order_lines_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.sc_orders(order_id) ON DELETE CASCADE;


--
-- Name: sc_order_lines sc_order_lines_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_order_lines
    ADD CONSTRAINT sc_order_lines_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;


--
-- Name: sc_order_quotes sc_order_quotes_listing_row_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_order_quotes
    ADD CONSTRAINT sc_order_quotes_listing_row_id_fkey FOREIGN KEY (listing_row_id) REFERENCES public.listing_rows(id) ON DELETE RESTRICT;


--
-- Name: sc_order_quotes sc_order_quotes_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_order_quotes
    ADD CONSTRAINT sc_order_quotes_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;


--
-- Name: sc_order_quotes sc_order_quotes_platform_sku_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_order_quotes
    ADD CONSTRAINT sc_order_quotes_platform_sku_id_fkey FOREIGN KEY (platform_sku_id) REFERENCES public.sc_skus(sku_id) ON DELETE RESTRICT;


--
-- Name: sc_order_quotes sc_order_quotes_price_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_order_quotes
    ADD CONSTRAINT sc_order_quotes_price_version_id_fkey FOREIGN KEY (price_version_id) REFERENCES public.sc_price_versions(id) ON DELETE RESTRICT;


--
-- Name: sc_orders sc_orders_listing_row_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_orders
    ADD CONSTRAINT sc_orders_listing_row_id_fkey FOREIGN KEY (listing_row_id) REFERENCES public.listing_rows(id) ON DELETE RESTRICT;


--
-- Name: sc_orders sc_orders_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_orders
    ADD CONSTRAINT sc_orders_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;


--
-- Name: sc_orders sc_orders_payment_order_public_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_orders
    ADD CONSTRAINT sc_orders_payment_order_public_id_fkey FOREIGN KEY (payment_order_public_id) REFERENCES public.payment_orders(public_id) ON DELETE RESTRICT;


--
-- Name: sc_orders sc_orders_platform_sku_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_orders
    ADD CONSTRAINT sc_orders_platform_sku_id_fkey FOREIGN KEY (platform_sku_id) REFERENCES public.sc_skus(sku_id) ON DELETE RESTRICT;


--
-- Name: sc_orders sc_orders_price_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_orders
    ADD CONSTRAINT sc_orders_price_version_id_fkey FOREIGN KEY (price_version_id) REFERENCES public.sc_price_versions(id) ON DELETE RESTRICT;


--
-- Name: sc_orders sc_orders_quote_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_orders
    ADD CONSTRAINT sc_orders_quote_id_fkey FOREIGN KEY (quote_id) REFERENCES public.sc_order_quotes(quote_id) ON DELETE RESTRICT;


--
-- Name: sc_price_versions sc_price_versions_sku_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_price_versions
    ADD CONSTRAINT sc_price_versions_sku_id_fkey FOREIGN KEY (sku_id) REFERENCES public.sc_skus(sku_id) ON DELETE RESTRICT;


--
-- Name: sc_procurements sc_procurements_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_procurements
    ADD CONSTRAINT sc_procurements_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;


--
-- Name: sc_procurements sc_procurements_platform_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_procurements
    ADD CONSTRAINT sc_procurements_platform_order_id_fkey FOREIGN KEY (platform_order_id) REFERENCES public.sc_orders(order_id) ON DELETE RESTRICT;


--
-- Name: sc_products sc_products_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_products
    ADD CONSTRAINT sc_products_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.sc_sources(source_id) ON DELETE RESTRICT;


--
-- Name: sc_skus sc_skus_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_skus
    ADD CONSTRAINT sc_skus_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.sc_products(product_id) ON DELETE RESTRICT;


--
-- Name: sc_source_fulfillers sc_source_fulfillers_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_source_fulfillers
    ADD CONSTRAINT sc_source_fulfillers_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.account_users(id) ON DELETE RESTRICT;


--
-- Name: sc_source_fulfillers sc_source_fulfillers_revoked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_source_fulfillers
    ADD CONSTRAINT sc_source_fulfillers_revoked_by_fkey FOREIGN KEY (revoked_by) REFERENCES public.account_users(id) ON DELETE RESTRICT;


--
-- Name: sc_source_fulfillers sc_source_fulfillers_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_source_fulfillers
    ADD CONSTRAINT sc_source_fulfillers_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.sc_sources(source_id) ON DELETE RESTRICT;


--
-- Name: sc_source_fulfillers sc_source_fulfillers_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_source_fulfillers
    ADD CONSTRAINT sc_source_fulfillers_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.account_users(id) ON DELETE RESTRICT;


--
-- Name: sc_source_members sc_source_members_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_source_members
    ADD CONSTRAINT sc_source_members_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.account_users(id);


--
-- Name: sc_source_members sc_source_members_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_source_members
    ADD CONSTRAINT sc_source_members_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.sc_sources(source_id) ON DELETE RESTRICT;


--
-- Name: sc_source_members sc_source_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_source_members
    ADD CONSTRAINT sc_source_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.account_users(id) ON DELETE RESTRICT;


--
-- Name: sc_source_offers sc_source_offers_sku_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_source_offers
    ADD CONSTRAINT sc_source_offers_sku_id_fkey FOREIGN KEY (sku_id) REFERENCES public.sc_skus(sku_id) ON DELETE CASCADE;


--
-- Name: sc_source_offers sc_source_offers_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_source_offers
    ADD CONSTRAINT sc_source_offers_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.sc_sources(source_id) ON DELETE CASCADE;


--
-- Name: sc_source_prop_defs sc_source_prop_defs_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sc_source_prop_defs
    ADD CONSTRAINT sc_source_prop_defs_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.sc_sources(source_id) ON DELETE CASCADE;


--
-- Name: seller_read_incidents seller_read_incidents_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seller_read_incidents
    ADD CONSTRAINT seller_read_incidents_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: seller_resource_occupancies seller_resource_occupancies_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seller_resource_occupancies
    ADD CONSTRAINT seller_resource_occupancies_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: seller_resource_occupancies seller_resource_occupancies_store_pk_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seller_resource_occupancies
    ADD CONSTRAINT seller_resource_occupancies_store_pk_fkey FOREIGN KEY (store_pk) REFERENCES public.organization_stores(id);


--
-- Name: seller_upstream_writes seller_upstream_writes_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seller_upstream_writes
    ADD CONSTRAINT seller_upstream_writes_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: seller_upstream_writes seller_upstream_writes_store_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seller_upstream_writes
    ADD CONSTRAINT seller_upstream_writes_store_id_fkey FOREIGN KEY (store_id) REFERENCES public.organization_stores(id);


--
-- Name: shipping_inject_operations shipping_inject_operations_preset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipping_inject_operations
    ADD CONSTRAINT shipping_inject_operations_preset_id_fkey FOREIGN KEY (preset_id) REFERENCES public.shipping_presets(preset_id) ON DELETE RESTRICT;


--
-- Name: shipping_preset_versions shipping_preset_versions_preset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipping_preset_versions
    ADD CONSTRAINT shipping_preset_versions_preset_id_fkey FOREIGN KEY (preset_id) REFERENCES public.shipping_presets(preset_id) ON DELETE RESTRICT;


--
-- Name: shipping_shop_injections shipping_shop_injections_preset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipping_shop_injections
    ADD CONSTRAINT shipping_shop_injections_preset_id_fkey FOREIGN KEY (preset_id) REFERENCES public.shipping_presets(preset_id) ON DELETE RESTRICT;


--
-- Name: shipping_sku_bindings shipping_sku_bindings_preset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipping_sku_bindings
    ADD CONSTRAINT shipping_sku_bindings_preset_id_fkey FOREIGN KEY (preset_id) REFERENCES public.shipping_presets(preset_id) ON DELETE RESTRICT;


--
-- Name: shipping_sku_bindings shipping_sku_bindings_sku_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipping_sku_bindings
    ADD CONSTRAINT shipping_sku_bindings_sku_id_fkey FOREIGN KEY (sku_id) REFERENCES public.sc_skus(sku_id) ON DELETE RESTRICT;


--
-- Name: storage_object_refs storage_object_refs_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_object_refs
    ADD CONSTRAINT storage_object_refs_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.storage_objects(id) ON DELETE RESTRICT;


--
-- Name: storage_object_refs storage_object_refs_owner_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_object_refs
    ADD CONSTRAINT storage_object_refs_owner_org_id_fkey FOREIGN KEY (owner_org_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;


--
-- Name: storage_objects storage_objects_owner_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_objects
    ADD CONSTRAINT storage_objects_owner_org_id_fkey FOREIGN KEY (owner_org_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;


--
-- Name: storage_uploads storage_uploads_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_uploads
    ADD CONSTRAINT storage_uploads_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.storage_objects(id) ON DELETE SET NULL;


--
-- Name: storage_uploads storage_uploads_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_uploads
    ADD CONSTRAINT storage_uploads_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;


--
-- Name: store_credential_verifications store_credential_verifications_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_credential_verifications
    ADD CONSTRAINT store_credential_verifications_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: store_credential_verifications store_credential_verifications_store_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_credential_verifications
    ADD CONSTRAINT store_credential_verifications_store_id_fkey FOREIGN KEY (store_id) REFERENCES public.organization_stores(id);


--
-- Name: store_credential_verifications store_credential_verifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_credential_verifications
    ADD CONSTRAINT store_credential_verifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.account_users(id) ON DELETE CASCADE;


--
-- Name: store_product_metrics store_product_metrics_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_product_metrics
    ADD CONSTRAINT store_product_metrics_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: store_product_metrics store_product_metrics_store_pk_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_product_metrics
    ADD CONSTRAINT store_product_metrics_store_pk_fkey FOREIGN KEY (store_pk) REFERENCES public.organization_stores(id) ON DELETE CASCADE;


--
-- Name: store_product_pass_pages store_product_pass_pages_store_pk_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_product_pass_pages
    ADD CONSTRAINT store_product_pass_pages_store_pk_fkey FOREIGN KEY (store_pk) REFERENCES public.organization_stores(id) ON DELETE CASCADE;


--
-- Name: store_product_sync store_product_sync_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_product_sync
    ADD CONSTRAINT store_product_sync_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: store_products store_products_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_products
    ADD CONSTRAINT store_products_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: store_products store_products_status_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_products
    ADD CONSTRAINT store_products_status_id_fkey FOREIGN KEY (status_id) REFERENCES public.ozon_product_status(id);


--
-- Name: store_products store_products_store_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_products
    ADD CONSTRAINT store_products_store_fk FOREIGN KEY (store_pk) REFERENCES public.organization_stores(id);


--
-- Name: store_rating_history store_rating_history_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_rating_history
    ADD CONSTRAINT store_rating_history_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: store_rating_history store_rating_history_store_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_rating_history
    ADD CONSTRAINT store_rating_history_store_id_fkey FOREIGN KEY (store_id) REFERENCES public.organization_stores(uuid) ON DELETE CASCADE;


--
-- Name: store_rating_snapshots store_rating_snapshots_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_rating_snapshots
    ADD CONSTRAINT store_rating_snapshots_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: store_rating_snapshots store_rating_snapshots_store_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_rating_snapshots
    ADD CONSTRAINT store_rating_snapshots_store_id_fkey FOREIGN KEY (store_id) REFERENCES public.organization_stores(uuid) ON DELETE CASCADE;


--
-- Name: store_rating_sync store_rating_sync_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_rating_sync
    ADD CONSTRAINT store_rating_sync_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: store_rating_sync store_rating_sync_store_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_rating_sync
    ADD CONSTRAINT store_rating_sync_store_id_fkey FOREIGN KEY (store_id) REFERENCES public.organization_stores(uuid) ON DELETE CASCADE;


--
-- Name: store_seller_credentials store_seller_credentials_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_seller_credentials
    ADD CONSTRAINT store_seller_credentials_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: store_seller_credentials store_seller_credentials_registered_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_seller_credentials
    ADD CONSTRAINT store_seller_credentials_registered_by_user_id_fkey FOREIGN KEY (registered_by_user_id) REFERENCES public.account_users(id);


--
-- Name: store_seller_credentials store_seller_credentials_store_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_seller_credentials
    ADD CONSTRAINT store_seller_credentials_store_id_fkey FOREIGN KEY (store_id) REFERENCES public.organization_stores(id) ON DELETE CASCADE;


--
-- Name: store_tag_links store_tag_links_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_tag_links
    ADD CONSTRAINT store_tag_links_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: store_tag_links store_tag_links_store_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_tag_links
    ADD CONSTRAINT store_tag_links_store_id_fkey FOREIGN KEY (store_id) REFERENCES public.organization_stores(id) ON DELETE CASCADE;


--
-- Name: store_tag_links store_tag_links_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_tag_links
    ADD CONSTRAINT store_tag_links_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.organization_store_tags(id) ON DELETE CASCADE;


--
-- Name: store_tombstone_consumptions store_tombstone_consumptions_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_tombstone_consumptions
    ADD CONSTRAINT store_tombstone_consumptions_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: store_tombstone_consumptions store_tombstone_consumptions_store_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_tombstone_consumptions
    ADD CONSTRAINT store_tombstone_consumptions_store_id_fkey FOREIGN KEY (store_id) REFERENCES public.organization_stores(id);


--
-- Name: store_tombstone_consumptions store_tombstone_consumptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_tombstone_consumptions
    ADD CONSTRAINT store_tombstone_consumptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.account_users(id) ON DELETE CASCADE;


--
-- Name: submission_intents submission_intents_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.submission_intents
    ADD CONSTRAINT submission_intents_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: subscription_events subscription_events_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_events
    ADD CONSTRAINT subscription_events_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.payment_orders(id);


--
-- Name: subscription_events subscription_events_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_events
    ADD CONSTRAINT subscription_events_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: subscription_periods subscription_periods_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_periods
    ADD CONSTRAINT subscription_periods_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.payment_orders(id);


--
-- Name: subscription_periods subscription_periods_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_periods
    ADD CONSTRAINT subscription_periods_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.subscriptions(org_id) ON DELETE CASCADE;


--
-- Name: subscription_periods subscription_periods_plan_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_periods
    ADD CONSTRAINT subscription_periods_plan_key_fkey FOREIGN KEY (plan_key) REFERENCES public.plans(key);


--
-- Name: subscription_quotes subscription_quotes_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_quotes
    ADD CONSTRAINT subscription_quotes_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: subscription_quotes subscription_quotes_plan_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_quotes
    ADD CONSTRAINT subscription_quotes_plan_key_fkey FOREIGN KEY (plan_key) REFERENCES public.plans(key);


--
-- Name: subscriptions subscriptions_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: subscriptions subscriptions_plan_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_plan_key_fkey FOREIGN KEY (plan_key) REFERENCES public.plans(key);


--
-- Name: supplier_media_objects supplier_media_objects_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_media_objects
    ADD CONSTRAINT supplier_media_objects_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.sc_products(product_id) ON DELETE CASCADE;


--
-- Name: supplier_media_objects supplier_media_objects_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_media_objects
    ADD CONSTRAINT supplier_media_objects_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.sc_sources(source_id) ON DELETE CASCADE;


--
-- Name: supplier_ozon_configs supplier_ozon_configs_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_ozon_configs
    ADD CONSTRAINT supplier_ozon_configs_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.sc_products(product_id) ON DELETE CASCADE;


--
-- Name: supplier_ozon_configs supplier_ozon_configs_published_revision_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_ozon_configs
    ADD CONSTRAINT supplier_ozon_configs_published_revision_fk FOREIGN KEY (product_id, published_revision) REFERENCES public.prompt_revisions(product_id, revision) ON DELETE CASCADE;


--
-- Name: supplier_wallet_ledger supplier_wallet_ledger_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_wallet_ledger
    ADD CONSTRAINT supplier_wallet_ledger_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.sc_sources(source_id);


--
-- Name: supplier_wallets supplier_wallets_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_wallets
    ADD CONSTRAINT supplier_wallets_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.sc_sources(source_id);


--
-- Name: supplier_withdrawals supplier_withdrawals_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_withdrawals
    ADD CONSTRAINT supplier_withdrawals_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.sc_sources(source_id);


--
-- Name: user_wallets user_wallets_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_wallets
    ADD CONSTRAINT user_wallets_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.account_users(id);


--
-- Name: wallet_ledger wallet_ledger_ai_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_ledger
    ADD CONSTRAINT wallet_ledger_ai_request_id_fkey FOREIGN KEY (ai_request_id) REFERENCES public.ai_requests(id);


--
-- Name: wallet_ledger wallet_ledger_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_ledger
    ADD CONSTRAINT wallet_ledger_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: wallet_ledger wallet_ledger_payment_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_ledger
    ADD CONSTRAINT wallet_ledger_payment_order_id_fkey FOREIGN KEY (payment_order_id) REFERENCES public.payment_orders(id);


--
-- Name: wallet_ledger wallet_ledger_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_ledger
    ADD CONSTRAINT wallet_ledger_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.account_users(id);


--
-- Name: wb_category_field_defaults wb_category_field_defaults_subject_id_language_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_category_field_defaults
    ADD CONSTRAINT wb_category_field_defaults_subject_id_language_fkey FOREIGN KEY (subject_id, language) REFERENCES public.wb_category_current(subject_id, language);


--
-- Name: workspace_psd_templates workspace_psd_templates_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_psd_templates
    ADD CONSTRAINT workspace_psd_templates_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.account_users(id);


--
-- Name: workspace_psd_templates workspace_psd_templates_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_psd_templates
    ADD CONSTRAINT workspace_psd_templates_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.storage_objects(id) ON DELETE RESTRICT;


--
-- Name: workspace_psd_templates workspace_psd_templates_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_psd_templates
    ADD CONSTRAINT workspace_psd_templates_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: ai_billing_ratio_documents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_billing_ratio_documents ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_consume_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_consume_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_image_set_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_image_set_items ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_image_sets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_image_sets ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_requests ai_requests_maintenance_prune; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ai_requests_maintenance_prune ON public.ai_requests FOR UPDATE TO podhub_maintenance USING ((settled_at IS NOT NULL)) WITH CHECK ((response_body IS NULL));


--
-- Name: ai_requests ai_requests_maintenance_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ai_requests_maintenance_read ON public.ai_requests FOR SELECT TO podhub_maintenance USING (true);


--
-- Name: automation_asset_set_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.automation_asset_set_items ENABLE ROW LEVEL SECURITY;

--
-- Name: automation_asset_sets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.automation_asset_sets ENABLE ROW LEVEL SECURITY;

--
-- Name: automation_call_receipts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.automation_call_receipts ENABLE ROW LEVEL SECURITY;

--
-- Name: automation_executions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.automation_executions ENABLE ROW LEVEL SECURITY;

--
-- Name: automation_runtimes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.automation_runtimes ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_orders billing_lookup; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY billing_lookup ON public.payment_orders TO podhub_billing_lookup USING (true) WITH CHECK (true);


--
-- Name: redeem_codes billing_lookup; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY billing_lookup ON public.redeem_codes TO podhub_billing_lookup USING (true) WITH CHECK (true);


--
-- Name: subscription_events billing_lookup; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY billing_lookup ON public.subscription_events TO podhub_billing_lookup USING (true) WITH CHECK (true);


--
-- Name: subscription_periods billing_lookup; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY billing_lookup ON public.subscription_periods FOR SELECT TO podhub_billing_lookup USING (true);


--
-- Name: subscription_quotes billing_lookup; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY billing_lookup ON public.subscription_quotes TO podhub_billing_lookup USING (true) WITH CHECK (true);


--
-- Name: subscriptions billing_lookup; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY billing_lookup ON public.subscriptions TO podhub_billing_lookup USING (true) WITH CHECK (true);


--
-- Name: billing_operations billing_operation_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY billing_operation_tenant_isolation ON public.billing_operations TO podhub_app USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: billing_operations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.billing_operations ENABLE ROW LEVEL SECURITY;

--
-- Name: billing_operations billing_operations_maintenance_lock; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY billing_operations_maintenance_lock ON public.billing_operations FOR UPDATE TO podhub_maintenance USING (((state)::text = ANY ((ARRAY['reserved'::character varying, 'outcome_unknown'::character varying])::text[]))) WITH CHECK (false);


--
-- Name: billing_operations billing_operations_maintenance_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY billing_operations_maintenance_read ON public.billing_operations FOR SELECT TO podhub_maintenance USING (true);


--
-- Name: browser_commands; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.browser_commands ENABLE ROW LEVEL SECURITY;

--
-- Name: client_listing_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.client_listing_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: client_listing_logs client_listing_logs_maintenance_prune; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY client_listing_logs_maintenance_prune ON public.client_listing_logs FOR DELETE TO podhub_maintenance USING (true);


--
-- Name: client_listing_logs client_listing_logs_maintenance_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY client_listing_logs_maintenance_read ON public.client_listing_logs FOR SELECT TO podhub_maintenance USING (true);


--
-- Name: console_store_metrics; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.console_store_metrics ENABLE ROW LEVEL SECURITY;

--
-- Name: delegate_assets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.delegate_assets ENABLE ROW LEVEL SECURITY;

--
-- Name: delegate_bindings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.delegate_bindings ENABLE ROW LEVEL SECURITY;

--
-- Name: delegate_dispatch_assets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.delegate_dispatch_assets ENABLE ROW LEVEL SECURITY;

--
-- Name: delegate_dispatches; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.delegate_dispatches ENABLE ROW LEVEL SECURITY;

--
-- Name: delegate_dispatches delegate_fulfiller_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delegate_fulfiller_isolation ON public.delegate_dispatches TO podhub_app USING ((fulfiller_id IN ( SELECT f.fulfiller_id
   FROM public.sc_source_fulfillers f
  WHERE (f.user_id = (NULLIF(current_setting('app.current_supplier_user_id'::text, true), ''::text))::bigint)))) WITH CHECK ((fulfiller_id IN ( SELECT f.fulfiller_id
   FROM public.sc_source_fulfillers f
  WHERE ((f.user_id = (NULLIF(current_setting('app.current_supplier_user_id'::text, true), ''::text))::bigint) AND (f.status = 'active'::text)))));


--
-- Name: delegate_settlements delegate_fulfiller_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delegate_fulfiller_isolation ON public.delegate_settlements TO podhub_app USING ((EXISTS ( SELECT 1
   FROM public.delegate_dispatches d
  WHERE ((d.dispatch_id = delegate_settlements.dispatch_id) AND (d.fulfiller_id IN ( SELECT f.fulfiller_id
           FROM public.sc_source_fulfillers f
          WHERE (f.user_id = (NULLIF(current_setting('app.current_supplier_user_id'::text, true), ''::text))::bigint))))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.delegate_dispatches d
  WHERE ((d.dispatch_id = delegate_settlements.dispatch_id) AND (d.fulfiller_id IN ( SELECT f.fulfiller_id
           FROM public.sc_source_fulfillers f
          WHERE ((f.user_id = (NULLIF(current_setting('app.current_supplier_user_id'::text, true), ''::text))::bigint) AND (f.status = 'active'::text))))))));


--
-- Name: delegate_order_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.delegate_order_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: delegate_orders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.delegate_orders ENABLE ROW LEVEL SECURITY;

--
-- Name: delegate_assets delegate_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delegate_org_isolation ON public.delegate_assets TO podhub_app USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: delegate_bindings delegate_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delegate_org_isolation ON public.delegate_bindings TO podhub_app USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: delegate_dispatch_assets delegate_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delegate_org_isolation ON public.delegate_dispatch_assets TO podhub_app USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: delegate_dispatches delegate_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delegate_org_isolation ON public.delegate_dispatches TO podhub_app USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: delegate_order_lines delegate_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delegate_org_isolation ON public.delegate_order_lines TO podhub_app USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: delegate_orders delegate_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delegate_org_isolation ON public.delegate_orders TO podhub_app USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: delegate_settlements delegate_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delegate_org_isolation ON public.delegate_settlements TO podhub_app USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: delegate_settlements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.delegate_settlements ENABLE ROW LEVEL SECURITY;

--
-- Name: delegate_assets delegate_staff_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delegate_staff_isolation ON public.delegate_assets TO podhub_app USING ((current_setting('app.staff_access'::text, true) = '1'::text)) WITH CHECK ((current_setting('app.staff_access'::text, true) = '1'::text));


--
-- Name: delegate_bindings delegate_staff_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delegate_staff_isolation ON public.delegate_bindings TO podhub_app USING ((current_setting('app.staff_access'::text, true) = '1'::text)) WITH CHECK ((current_setting('app.staff_access'::text, true) = '1'::text));


--
-- Name: delegate_dispatch_assets delegate_staff_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delegate_staff_isolation ON public.delegate_dispatch_assets TO podhub_app USING ((current_setting('app.staff_access'::text, true) = '1'::text)) WITH CHECK ((current_setting('app.staff_access'::text, true) = '1'::text));


--
-- Name: delegate_dispatches delegate_staff_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delegate_staff_isolation ON public.delegate_dispatches TO podhub_app USING ((current_setting('app.staff_access'::text, true) = '1'::text)) WITH CHECK ((current_setting('app.staff_access'::text, true) = '1'::text));


--
-- Name: delegate_order_lines delegate_staff_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delegate_staff_isolation ON public.delegate_order_lines TO podhub_app USING ((current_setting('app.staff_access'::text, true) = '1'::text)) WITH CHECK ((current_setting('app.staff_access'::text, true) = '1'::text));


--
-- Name: delegate_orders delegate_staff_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delegate_staff_isolation ON public.delegate_orders TO podhub_app USING ((current_setting('app.staff_access'::text, true) = '1'::text)) WITH CHECK ((current_setting('app.staff_access'::text, true) = '1'::text));


--
-- Name: delegate_settlements delegate_staff_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delegate_staff_isolation ON public.delegate_settlements TO podhub_app USING ((current_setting('app.staff_access'::text, true) = '1'::text)) WITH CHECK ((current_setting('app.staff_access'::text, true) = '1'::text));


--
-- Name: error_digest; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.error_digest ENABLE ROW LEVEL SECURITY;

--
-- Name: error_digest error_digest_platform_observe; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY error_digest_platform_observe ON public.error_digest FOR SELECT TO podhub_app USING (((org_id IS NULL) AND (EXISTS ( SELECT 1
   FROM public.account_users observer
  WHERE (((observer.id)::text = current_setting('app.platform_observer_id'::text, true)) AND ((observer.role)::text = 'super_admin'::text) AND (observer.disabled_at IS NULL))))));


--
-- Name: error_digest error_digest_platform_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY error_digest_platform_write ON public.error_digest TO podhub_digest_platform USING ((org_id IS NULL)) WITH CHECK ((org_id IS NULL));


--
-- Name: error_digest error_digest_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY error_digest_tenant ON public.error_digest TO podhub_app USING (((org_id IS NOT NULL) AND (org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint))) WITH CHECK (((org_id IS NOT NULL) AND (org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)));


--
-- Name: execution_permits; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.execution_permits ENABLE ROW LEVEL SECURITY;

--
-- Name: automation_call_receipts grant_owner_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY grant_owner_isolation ON public.automation_call_receipts TO podhub_app USING ((grant_id = (NULLIF(current_setting('app.automation_grant_id'::text, true), ''::text))::uuid)) WITH CHECK ((grant_id = (NULLIF(current_setting('app.automation_grant_id'::text, true), ''::text))::uuid));


--
-- Name: automation_executions grant_owner_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY grant_owner_isolation ON public.automation_executions TO podhub_app USING ((grant_id = (NULLIF(current_setting('app.automation_grant_id'::text, true), ''::text))::uuid)) WITH CHECK ((grant_id = (NULLIF(current_setting('app.automation_grant_id'::text, true), ''::text))::uuid));


--
-- Name: ai_image_set_items image_item_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY image_item_tenant ON public.ai_image_set_items TO podhub_app USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: ai_image_sets image_set_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY image_set_tenant ON public.ai_image_sets TO podhub_app USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: jobs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;

--
-- Name: listing_card_cursors; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.listing_card_cursors ENABLE ROW LEVEL SECURITY;

--
-- Name: listing_cards; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.listing_cards ENABLE ROW LEVEL SECURITY;

--
-- Name: listing_row_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.listing_row_events ENABLE ROW LEVEL SECURITY;

--
-- Name: listing_rows; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.listing_rows ENABLE ROW LEVEL SECURITY;

--
-- Name: media_bindings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.media_bindings ENABLE ROW LEVEL SECURITY;

--
-- Name: media_blobs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.media_blobs ENABLE ROW LEVEL SECURITY;

--
-- Name: media_lib_assets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.media_lib_assets ENABLE ROW LEVEL SECURITY;

--
-- Name: media_uploads; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.media_uploads ENABLE ROW LEVEL SECURITY;

--
-- Name: ozon_delivery_methods; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ozon_delivery_methods ENABLE ROW LEVEL SECURITY;

--
-- Name: ozon_delivery_methods ozon_delivery_methods_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ozon_delivery_methods_tenant ON public.ozon_delivery_methods TO podhub_app USING (((org_id IS NOT NULL) AND (org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint))) WITH CHECK (((org_id IS NOT NULL) AND (org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)));


--
-- Name: ozon_error_catalog; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ozon_error_catalog ENABLE ROW LEVEL SECURITY;

--
-- Name: ozon_error_catalog ozon_error_catalog_observe; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ozon_error_catalog_observe ON public.ozon_error_catalog FOR SELECT TO podhub_app USING ((EXISTS ( SELECT 1
   FROM public.account_users observer
  WHERE (((observer.id)::text = current_setting('app.platform_observer_id'::text, true)) AND ((observer.role)::text = 'super_admin'::text) AND (observer.disabled_at IS NULL)))));


--
-- Name: ozon_error_catalog ozon_error_catalog_sample_prune; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ozon_error_catalog_sample_prune ON public.ozon_error_catalog FOR UPDATE TO podhub_ozon_sample_prune USING ((source <> 'docs_seed'::text)) WITH CHECK (((source <> 'docs_seed'::text) AND (sample_description = ''::text)));


--
-- Name: ozon_error_catalog ozon_error_catalog_sample_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ozon_error_catalog_sample_read ON public.ozon_error_catalog FOR SELECT TO podhub_ozon_sample_prune USING ((source <> 'docs_seed'::text));


--
-- Name: ozon_error_catalog ozon_error_catalog_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ozon_error_catalog_write ON public.ozon_error_catalog TO podhub_ozon_catalog USING ((source = ANY (ARRAY['ozon_import_info'::text, 'ozon_request'::text]))) WITH CHECK ((source = ANY (ARRAY['ozon_import_info'::text, 'ozon_request'::text])));


--
-- Name: ozon_error_observation; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ozon_error_observation ENABLE ROW LEVEL SECURITY;

--
-- Name: ozon_error_observation ozon_error_observation_sample_prune; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ozon_error_observation_sample_prune ON public.ozon_error_observation FOR UPDATE TO podhub_ozon_sample_prune USING (true) WITH CHECK ((sample_description = ''::text));


--
-- Name: ozon_error_observation ozon_error_observation_sample_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ozon_error_observation_sample_read ON public.ozon_error_observation FOR SELECT TO podhub_ozon_sample_prune USING (true);


--
-- Name: ozon_error_sighting; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ozon_error_sighting ENABLE ROW LEVEL SECURITY;

--
-- Name: ozon_warehouse_fences; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ozon_warehouse_fences ENABLE ROW LEVEL SECURITY;

--
-- Name: ozon_warehouse_fences ozon_warehouse_fences_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ozon_warehouse_fences_tenant ON public.ozon_warehouse_fences TO podhub_app USING (((org_id IS NOT NULL) AND (org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint))) WITH CHECK (((org_id IS NOT NULL) AND (org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)));


--
-- Name: ozon_warehouse_intents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ozon_warehouse_intents ENABLE ROW LEVEL SECURITY;

--
-- Name: ozon_warehouse_intents ozon_warehouse_intents_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ozon_warehouse_intents_tenant ON public.ozon_warehouse_intents TO podhub_app USING (((org_id IS NOT NULL) AND (org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint))) WITH CHECK (((org_id IS NOT NULL) AND (org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)));


--
-- Name: ozon_warehouse_sync; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ozon_warehouse_sync ENABLE ROW LEVEL SECURITY;

--
-- Name: ozon_warehouse_sync ozon_warehouse_sync_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ozon_warehouse_sync_tenant ON public.ozon_warehouse_sync TO podhub_app USING (((org_id IS NOT NULL) AND (org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint))) WITH CHECK (((org_id IS NOT NULL) AND (org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)));


--
-- Name: ozon_warehouses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ozon_warehouses ENABLE ROW LEVEL SECURITY;

--
-- Name: ozon_warehouses ozon_warehouses_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ozon_warehouses_tenant ON public.ozon_warehouses TO podhub_app USING (((org_id IS NOT NULL) AND (org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint))) WITH CHECK (((org_id IS NOT NULL) AND (org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)));


--
-- Name: payment_orders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payment_orders ENABLE ROW LEVEL SECURITY;

--
-- Name: console_store_metrics platform_observation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY platform_observation_select ON public.console_store_metrics FOR SELECT TO podhub_app USING ((EXISTS ( SELECT 1
   FROM public.account_users observer
  WHERE (((observer.id)::text = current_setting('app.platform_observer_id'::text, true)) AND ((observer.role)::text = 'super_admin'::text) AND (observer.disabled_at IS NULL)))));


--
-- Name: seller_upstream_writes platform_observation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY platform_observation_select ON public.seller_upstream_writes FOR SELECT TO podhub_app USING ((EXISTS ( SELECT 1
   FROM public.account_users observer
  WHERE (((observer.id)::text = current_setting('app.platform_observer_id'::text, true)) AND ((observer.role)::text = 'super_admin'::text) AND (observer.disabled_at IS NULL)))));


--
-- Name: store_product_metrics platform_observation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY platform_observation_select ON public.store_product_metrics FOR SELECT TO podhub_app USING ((EXISTS ( SELECT 1
   FROM public.account_users observer
  WHERE (((observer.id)::text = current_setting('app.platform_observer_id'::text, true)) AND ((observer.role)::text = 'super_admin'::text) AND (observer.disabled_at IS NULL)))));


--
-- Name: store_product_sync platform_observation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY platform_observation_select ON public.store_product_sync FOR SELECT TO podhub_app USING ((EXISTS ( SELECT 1
   FROM public.account_users observer
  WHERE (((observer.id)::text = current_setting('app.platform_observer_id'::text, true)) AND ((observer.role)::text = 'super_admin'::text) AND (observer.disabled_at IS NULL)))));


--
-- Name: store_products platform_observation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY platform_observation_select ON public.store_products FOR SELECT TO podhub_app USING ((EXISTS ( SELECT 1
   FROM public.account_users observer
  WHERE (((observer.id)::text = current_setting('app.platform_observer_id'::text, true)) AND ((observer.role)::text = 'super_admin'::text) AND (observer.disabled_at IS NULL)))));


--
-- Name: submission_intents platform_observation_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY platform_observation_select ON public.submission_intents FOR SELECT TO podhub_app USING ((EXISTS ( SELECT 1
   FROM public.account_users observer
  WHERE (((observer.id)::text = current_setting('app.platform_observer_id'::text, true)) AND ((observer.role)::text = 'super_admin'::text) AND (observer.disabled_at IS NULL)))));


--
-- Name: product_variant_previews; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.product_variant_previews ENABLE ROW LEVEL SECURITY;

--
-- Name: redeem_codes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.redeem_codes ENABLE ROW LEVEL SECURITY;

--
-- Name: sc_catalog_managers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sc_catalog_managers ENABLE ROW LEVEL SECURITY;

--
-- Name: sc_catalog_managers sc_catalog_managers_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sc_catalog_managers_member_read ON public.sc_catalog_managers FOR SELECT TO podhub_app USING ((user_id = (NULLIF(current_setting('app.current_org_user_id'::text, true), ''::text))::bigint));


--
-- Name: sc_catalog_managers sc_catalog_managers_staff_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sc_catalog_managers_staff_all ON public.sc_catalog_managers TO podhub_app USING ((current_setting('app.staff_access'::text, true) = '1'::text)) WITH CHECK ((current_setting('app.staff_access'::text, true) = '1'::text));


--
-- Name: sc_order_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sc_order_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: sc_orders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sc_orders ENABLE ROW LEVEL SECURITY;

--
-- Name: sc_price_versions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sc_price_versions ENABLE ROW LEVEL SECURITY;

--
-- Name: sc_price_versions sc_price_versions_manager_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sc_price_versions_manager_read ON public.sc_price_versions FOR SELECT TO podhub_app USING ((EXISTS ( SELECT 1
   FROM ((public.sc_skus k
     JOIN public.sc_products p ON ((p.product_id = k.product_id)))
     JOIN public.sc_catalog_managers m ON ((m.source_id = p.source_id)))
  WHERE ((k.sku_id = sc_price_versions.sku_id) AND (m.user_id = (NULLIF(current_setting('app.current_org_user_id'::text, true), ''::text))::bigint) AND (m.status = 'active'::text)))));


--
-- Name: sc_price_versions sc_price_versions_published_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sc_price_versions_published_read ON public.sc_price_versions FOR SELECT TO podhub_app USING ((EXISTS ( SELECT 1
   FROM public.sc_skus k
  WHERE ((k.sku_id = sc_price_versions.sku_id) AND k.published))));


--
-- Name: sc_price_versions sc_price_versions_seller_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sc_price_versions_seller_read ON public.sc_price_versions FOR SELECT TO podhub_app USING ((EXISTS ( SELECT 1
   FROM ((public.sc_skus k
     JOIN public.sc_products p ON ((p.product_id = k.product_id)))
     JOIN public.delegate_bindings b ON ((b.source_id = p.source_id)))
  WHERE ((k.sku_id = sc_price_versions.sku_id) AND (b.org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)))));


--
-- Name: sc_price_versions sc_price_versions_staff_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sc_price_versions_staff_all ON public.sc_price_versions TO podhub_app USING ((current_setting('app.staff_access'::text, true) = '1'::text)) WITH CHECK ((current_setting('app.staff_access'::text, true) = '1'::text));


--
-- Name: sc_price_versions sc_price_versions_supplier_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sc_price_versions_supplier_read ON public.sc_price_versions FOR SELECT TO podhub_app USING ((EXISTS ( SELECT 1
   FROM ((public.sc_skus k
     JOIN public.sc_products p ON ((p.product_id = k.product_id)))
     JOIN public.sc_source_members sm ON ((sm.source_id = p.source_id)))
  WHERE ((k.sku_id = sc_price_versions.sku_id) AND (sm.user_id = (NULLIF(current_setting('app.current_supplier_user_id'::text, true), ''::text))::bigint) AND (sm.status = 'active'::text)))));


--
-- Name: sc_products; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sc_products ENABLE ROW LEVEL SECURITY;

--
-- Name: sc_products sc_products_manager_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sc_products_manager_all ON public.sc_products TO podhub_app USING ((EXISTS ( SELECT 1
   FROM public.sc_catalog_managers m
  WHERE ((m.source_id = sc_products.source_id) AND (m.user_id = (NULLIF(current_setting('app.current_org_user_id'::text, true), ''::text))::bigint) AND (m.status = 'active'::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.sc_catalog_managers m
  WHERE ((m.source_id = sc_products.source_id) AND (m.user_id = (NULLIF(current_setting('app.current_org_user_id'::text, true), ''::text))::bigint) AND (m.status = 'active'::text)))));


--
-- Name: sc_products sc_products_published_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sc_products_published_read ON public.sc_products FOR SELECT TO podhub_app USING (published);


--
-- Name: sc_products sc_products_seller_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sc_products_seller_read ON public.sc_products FOR SELECT TO podhub_app USING ((EXISTS ( SELECT 1
   FROM public.delegate_bindings b
  WHERE ((b.source_id = sc_products.source_id) AND (b.org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)))));


--
-- Name: sc_products sc_products_staff_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sc_products_staff_all ON public.sc_products TO podhub_app USING ((current_setting('app.staff_access'::text, true) = '1'::text)) WITH CHECK ((current_setting('app.staff_access'::text, true) = '1'::text));


--
-- Name: sc_products sc_products_supplier_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sc_products_supplier_read ON public.sc_products FOR SELECT TO podhub_app USING ((EXISTS ( SELECT 1
   FROM public.sc_source_members sm
  WHERE ((sm.source_id = sc_products.source_id) AND (sm.user_id = (NULLIF(current_setting('app.current_supplier_user_id'::text, true), ''::text))::bigint) AND (sm.status = 'active'::text)))));


--
-- Name: sc_skus; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sc_skus ENABLE ROW LEVEL SECURITY;

--
-- Name: sc_skus sc_skus_manager_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sc_skus_manager_all ON public.sc_skus TO podhub_app USING ((EXISTS ( SELECT 1
   FROM (public.sc_products p
     JOIN public.sc_catalog_managers m ON ((m.source_id = p.source_id)))
  WHERE ((p.product_id = sc_skus.product_id) AND (m.user_id = (NULLIF(current_setting('app.current_org_user_id'::text, true), ''::text))::bigint) AND (m.status = 'active'::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM (public.sc_products p
     JOIN public.sc_catalog_managers m ON ((m.source_id = p.source_id)))
  WHERE ((p.product_id = sc_skus.product_id) AND (m.user_id = (NULLIF(current_setting('app.current_org_user_id'::text, true), ''::text))::bigint) AND (m.status = 'active'::text)))));


--
-- Name: sc_skus sc_skus_published_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sc_skus_published_read ON public.sc_skus FOR SELECT TO podhub_app USING (published);


--
-- Name: sc_skus sc_skus_seller_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sc_skus_seller_read ON public.sc_skus FOR SELECT TO podhub_app USING ((EXISTS ( SELECT 1
   FROM (public.sc_products p
     JOIN public.delegate_bindings b ON ((b.source_id = p.source_id)))
  WHERE ((p.product_id = sc_skus.product_id) AND (b.org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)))));


--
-- Name: sc_skus sc_skus_staff_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sc_skus_staff_all ON public.sc_skus TO podhub_app USING ((current_setting('app.staff_access'::text, true) = '1'::text)) WITH CHECK ((current_setting('app.staff_access'::text, true) = '1'::text));


--
-- Name: sc_skus sc_skus_supplier_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sc_skus_supplier_read ON public.sc_skus FOR SELECT TO podhub_app USING ((EXISTS ( SELECT 1
   FROM (public.sc_products p
     JOIN public.sc_source_members sm ON ((sm.source_id = p.source_id)))
  WHERE ((p.product_id = sc_skus.product_id) AND (sm.user_id = (NULLIF(current_setting('app.current_supplier_user_id'::text, true), ''::text))::bigint) AND (sm.status = 'active'::text)))));


--
-- Name: sc_source_fulfillers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sc_source_fulfillers ENABLE ROW LEVEL SECURITY;

--
-- Name: sc_source_fulfillers sc_source_fulfillers_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sc_source_fulfillers_member_read ON public.sc_source_fulfillers FOR SELECT TO podhub_app USING ((user_id = (NULLIF(current_setting('app.current_supplier_user_id'::text, true), ''::text))::bigint));


--
-- Name: sc_source_fulfillers sc_source_fulfillers_staff_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sc_source_fulfillers_staff_all ON public.sc_source_fulfillers TO podhub_app USING ((current_setting('app.staff_access'::text, true) = '1'::text)) WITH CHECK ((current_setting('app.staff_access'::text, true) = '1'::text));


--
-- Name: sc_source_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sc_source_members ENABLE ROW LEVEL SECURITY;

--
-- Name: sc_source_offers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sc_source_offers ENABLE ROW LEVEL SECURITY;

--
-- Name: sc_source_offers sc_source_offers_manager_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sc_source_offers_manager_insert ON public.sc_source_offers FOR INSERT TO podhub_app WITH CHECK ((EXISTS ( SELECT 1
   FROM public.sc_catalog_managers m
  WHERE ((m.source_id = sc_source_offers.source_id) AND (m.user_id = (NULLIF(current_setting('app.current_org_user_id'::text, true), ''::text))::bigint) AND (m.status = 'active'::text)))));


--
-- Name: sc_source_offers sc_source_offers_manager_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sc_source_offers_manager_read ON public.sc_source_offers FOR SELECT TO podhub_app USING ((EXISTS ( SELECT 1
   FROM public.sc_catalog_managers m
  WHERE ((m.source_id = sc_source_offers.source_id) AND (m.user_id = (NULLIF(current_setting('app.current_org_user_id'::text, true), ''::text))::bigint) AND (m.status = 'active'::text)))));


--
-- Name: sc_source_offers sc_source_offers_manager_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sc_source_offers_manager_update ON public.sc_source_offers FOR UPDATE TO podhub_app USING ((EXISTS ( SELECT 1
   FROM public.sc_catalog_managers m
  WHERE ((m.source_id = sc_source_offers.source_id) AND (m.user_id = (NULLIF(current_setting('app.current_org_user_id'::text, true), ''::text))::bigint) AND (m.status = 'active'::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.sc_catalog_managers m
  WHERE ((m.source_id = sc_source_offers.source_id) AND (m.user_id = (NULLIF(current_setting('app.current_org_user_id'::text, true), ''::text))::bigint) AND (m.status = 'active'::text)))));


--
-- Name: sc_source_offers sc_source_offers_staff_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sc_source_offers_staff_all ON public.sc_source_offers TO podhub_app USING ((current_setting('app.staff_access'::text, true) = '1'::text)) WITH CHECK ((current_setting('app.staff_access'::text, true) = '1'::text));


--
-- Name: sc_source_offers sc_source_offers_supplier_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sc_source_offers_supplier_read ON public.sc_source_offers FOR SELECT TO podhub_app USING ((EXISTS ( SELECT 1
   FROM public.sc_source_members sm
  WHERE ((sm.source_id = sc_source_offers.source_id) AND (sm.user_id = (NULLIF(current_setting('app.current_supplier_user_id'::text, true), ''::text))::bigint) AND (sm.status = 'active'::text)))));


--
-- Name: sc_source_prop_defs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sc_source_prop_defs ENABLE ROW LEVEL SECURITY;

--
-- Name: sc_source_prop_defs sc_source_prop_defs_manager_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sc_source_prop_defs_manager_all ON public.sc_source_prop_defs TO podhub_app USING ((EXISTS ( SELECT 1
   FROM public.sc_catalog_managers m
  WHERE ((m.source_id = sc_source_prop_defs.source_id) AND (m.user_id = (NULLIF(current_setting('app.current_org_user_id'::text, true), ''::text))::bigint) AND (m.status = 'active'::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.sc_catalog_managers m
  WHERE ((m.source_id = sc_source_prop_defs.source_id) AND (m.user_id = (NULLIF(current_setting('app.current_org_user_id'::text, true), ''::text))::bigint) AND (m.status = 'active'::text)))));


--
-- Name: sc_source_prop_defs sc_source_prop_defs_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sc_source_prop_defs_read ON public.sc_source_prop_defs FOR SELECT TO podhub_app USING ((EXISTS ( SELECT 1
   FROM public.sc_sources s
  WHERE ((s.source_id = sc_source_prop_defs.source_id) AND s.listed))));


--
-- Name: sc_source_prop_defs sc_source_prop_defs_seller_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sc_source_prop_defs_seller_read ON public.sc_source_prop_defs FOR SELECT TO podhub_app USING ((EXISTS ( SELECT 1
   FROM public.delegate_bindings b
  WHERE ((b.source_id = sc_source_prop_defs.source_id) AND (b.org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)))));


--
-- Name: sc_source_prop_defs sc_source_prop_defs_staff_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sc_source_prop_defs_staff_all ON public.sc_source_prop_defs TO podhub_app USING ((current_setting('app.staff_access'::text, true) = '1'::text)) WITH CHECK ((current_setting('app.staff_access'::text, true) = '1'::text));


--
-- Name: sc_source_prop_defs sc_source_prop_defs_supplier_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sc_source_prop_defs_supplier_read ON public.sc_source_prop_defs FOR SELECT TO podhub_app USING ((EXISTS ( SELECT 1
   FROM public.sc_source_members sm
  WHERE ((sm.source_id = sc_source_prop_defs.source_id) AND (sm.user_id = (NULLIF(current_setting('app.current_supplier_user_id'::text, true), ''::text))::bigint) AND (sm.status = 'active'::text)))));


--
-- Name: sc_sources; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sc_sources ENABLE ROW LEVEL SECURITY;

--
-- Name: sc_sources sc_sources_listed_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sc_sources_listed_read ON public.sc_sources FOR SELECT TO podhub_app USING ((listed OR (source_id = 'src_unassigned'::text)));


--
-- Name: sc_sources sc_sources_manager_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sc_sources_manager_all ON public.sc_sources TO podhub_app USING ((EXISTS ( SELECT 1
   FROM public.sc_catalog_managers m
  WHERE ((m.source_id = sc_sources.source_id) AND (m.user_id = (NULLIF(current_setting('app.current_org_user_id'::text, true), ''::text))::bigint) AND (m.status = 'active'::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.sc_catalog_managers m
  WHERE ((m.source_id = sc_sources.source_id) AND (m.user_id = (NULLIF(current_setting('app.current_org_user_id'::text, true), ''::text))::bigint) AND (m.status = 'active'::text)))));


--
-- Name: sc_sources sc_sources_seller_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sc_sources_seller_read ON public.sc_sources FOR SELECT TO podhub_app USING ((EXISTS ( SELECT 1
   FROM public.delegate_bindings b
  WHERE ((b.source_id = sc_sources.source_id) AND (b.org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)))));


--
-- Name: sc_sources sc_sources_staff_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sc_sources_staff_all ON public.sc_sources TO podhub_app USING ((current_setting('app.staff_access'::text, true) = '1'::text)) WITH CHECK ((current_setting('app.staff_access'::text, true) = '1'::text));


--
-- Name: sc_sources sc_sources_supplier_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sc_sources_supplier_read ON public.sc_sources FOR SELECT TO podhub_app USING ((EXISTS ( SELECT 1
   FROM public.sc_source_members sm
  WHERE ((sm.source_id = sc_sources.source_id) AND (sm.user_id = (NULLIF(current_setting('app.current_supplier_user_id'::text, true), ''::text))::bigint) AND (sm.status = 'active'::text)))));


--
-- Name: seller_read_incidents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.seller_read_incidents ENABLE ROW LEVEL SECURITY;

--
-- Name: seller_resource_occupancies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.seller_resource_occupancies ENABLE ROW LEVEL SECURITY;

--
-- Name: seller_upstream_writes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.seller_upstream_writes ENABLE ROW LEVEL SECURITY;

--
-- Name: storage_object_refs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.storage_object_refs ENABLE ROW LEVEL SECURITY;

--
-- Name: storage_object_refs storage_ref_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY storage_ref_read ON public.storage_object_refs FOR SELECT TO podhub_app USING (((owner_org_id IS NULL) OR (owner_org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint) OR (current_setting('app.staff_access'::text, true) = '1'::text)));


--
-- Name: store_product_metrics; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.store_product_metrics ENABLE ROW LEVEL SECURITY;

--
-- Name: store_product_sync; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.store_product_sync ENABLE ROW LEVEL SECURITY;

--
-- Name: store_products; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.store_products ENABLE ROW LEVEL SECURITY;

--
-- Name: store_rating_history; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.store_rating_history ENABLE ROW LEVEL SECURITY;

--
-- Name: store_rating_snapshots; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.store_rating_snapshots ENABLE ROW LEVEL SECURITY;

--
-- Name: store_rating_sync; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.store_rating_sync ENABLE ROW LEVEL SECURITY;

--
-- Name: submission_intents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.submission_intents ENABLE ROW LEVEL SECURITY;

--
-- Name: subscription_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.subscription_events ENABLE ROW LEVEL SECURITY;

--
-- Name: subscription_periods; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.subscription_periods ENABLE ROW LEVEL SECURITY;

--
-- Name: subscription_quotes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.subscription_quotes ENABLE ROW LEVEL SECURITY;

--
-- Name: subscriptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

--
-- Name: sc_source_members supplier_member_self_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY supplier_member_self_isolation ON public.sc_source_members TO podhub_app USING ((user_id = (NULLIF(current_setting('app.current_supplier_user_id'::text, true), ''::text))::bigint)) WITH CHECK ((user_id = (NULLIF(current_setting('app.current_supplier_user_id'::text, true), ''::text))::bigint));


--
-- Name: sc_source_members supplier_member_staff_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY supplier_member_staff_isolation ON public.sc_source_members TO podhub_app USING ((current_setting('app.staff_access'::text, true) = '1'::text)) WITH CHECK ((current_setting('app.staff_access'::text, true) = '1'::text));


--
-- Name: supplier_wallet_ledger supplier_staff_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY supplier_staff_isolation ON public.supplier_wallet_ledger TO podhub_app USING ((current_setting('app.staff_access'::text, true) = '1'::text)) WITH CHECK ((current_setting('app.staff_access'::text, true) = '1'::text));


--
-- Name: supplier_wallets supplier_staff_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY supplier_staff_isolation ON public.supplier_wallets TO podhub_app USING ((current_setting('app.staff_access'::text, true) = '1'::text)) WITH CHECK ((current_setting('app.staff_access'::text, true) = '1'::text));


--
-- Name: supplier_withdrawals supplier_staff_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY supplier_staff_isolation ON public.supplier_withdrawals TO podhub_app USING ((current_setting('app.staff_access'::text, true) = '1'::text)) WITH CHECK ((current_setting('app.staff_access'::text, true) = '1'::text));


--
-- Name: supplier_wallet_ledger; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.supplier_wallet_ledger ENABLE ROW LEVEL SECURITY;

--
-- Name: supplier_wallets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.supplier_wallets ENABLE ROW LEVEL SECURITY;

--
-- Name: supplier_withdrawals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.supplier_withdrawals ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_billing_ratio_documents tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.ai_billing_ratio_documents TO podhub_app USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: ai_consume_logs tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.ai_consume_logs TO podhub_app USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: ai_requests tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.ai_requests TO podhub_app USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: automation_asset_set_items tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.automation_asset_set_items USING ((set_id IN ( SELECT s.id
   FROM public.automation_asset_sets s
  WHERE (s.org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)))) WITH CHECK ((set_id IN ( SELECT s.id
   FROM public.automation_asset_sets s
  WHERE (s.org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint))));


--
-- Name: automation_asset_sets tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.automation_asset_sets USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: automation_runtimes tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.automation_runtimes USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: browser_commands tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.browser_commands USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: client_listing_logs tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.client_listing_logs TO podhub_app USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: console_store_metrics tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.console_store_metrics TO podhub_app USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: execution_permits tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.execution_permits TO podhub_app USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: jobs tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.jobs TO podhub_app USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: listing_card_cursors tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.listing_card_cursors TO podhub_app USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: listing_cards tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.listing_cards TO podhub_app USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: listing_row_events tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.listing_row_events TO podhub_app USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: listing_rows tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.listing_rows TO podhub_app USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: media_bindings tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.media_bindings TO podhub_app USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: media_blobs tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.media_blobs TO podhub_app USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: media_lib_assets tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.media_lib_assets TO podhub_app USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: media_uploads tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.media_uploads TO podhub_app USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: ozon_error_observation tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.ozon_error_observation TO podhub_app USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: ozon_error_sighting tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.ozon_error_sighting TO podhub_app USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: payment_orders tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.payment_orders TO podhub_app USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: product_variant_previews tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.product_variant_previews TO podhub_app USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: sc_order_lines tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.sc_order_lines TO podhub_app USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: sc_orders tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.sc_orders TO podhub_app USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: seller_read_incidents tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.seller_read_incidents TO podhub_app USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: seller_resource_occupancies tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.seller_resource_occupancies TO podhub_app USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: seller_upstream_writes tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.seller_upstream_writes TO podhub_app USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: store_product_metrics tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.store_product_metrics TO podhub_app USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: store_product_sync tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.store_product_sync TO podhub_app USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: store_products tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.store_products TO podhub_app USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: store_rating_history tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.store_rating_history TO podhub_app USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: store_rating_snapshots tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.store_rating_snapshots TO podhub_app USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: store_rating_sync tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.store_rating_sync TO podhub_app USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: submission_intents tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.submission_intents TO podhub_app USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: subscription_events tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.subscription_events TO podhub_app USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: subscription_periods tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.subscription_periods TO podhub_app USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: subscription_quotes tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.subscription_quotes TO podhub_app USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: subscriptions tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.subscriptions TO podhub_app USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: workspace_psd_templates tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation ON public.workspace_psd_templates TO podhub_app USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)) WITH CHECK ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint));


--
-- Name: user_wallets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_wallets ENABLE ROW LEVEL SECURITY;

--
-- Name: wallet_ledger; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.wallet_ledger ENABLE ROW LEVEL SECURITY;

--
-- Name: wallet_ledger wallet_ledger_insert_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY wallet_ledger_insert_isolation ON public.wallet_ledger FOR INSERT TO podhub_app WITH CHECK (((user_id = (NULLIF(current_setting('app.current_wallet_user_id'::text, true), ''::text))::bigint) AND (org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::bigint)));


--
-- Name: wallet_ledger wallet_ledger_user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY wallet_ledger_user_isolation ON public.wallet_ledger FOR SELECT TO podhub_app USING ((user_id = (NULLIF(current_setting('app.current_wallet_user_id'::text, true), ''::text))::bigint));


--
-- Name: user_wallets wallet_user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY wallet_user_isolation ON public.user_wallets TO podhub_app USING ((user_id = (NULLIF(current_setting('app.current_wallet_user_id'::text, true), ''::text))::bigint)) WITH CHECK ((user_id = (NULLIF(current_setting('app.current_wallet_user_id'::text, true), ''::text))::bigint));


--
-- Name: ai_requests worker_claim; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY worker_claim ON public.ai_requests TO podhub_worker USING (true) WITH CHECK (true);


--
-- Name: payment_orders worker_claim; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY worker_claim ON public.payment_orders TO podhub_worker USING (true) WITH CHECK (true);


--
-- Name: redeem_codes worker_claim; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY worker_claim ON public.redeem_codes TO podhub_worker USING (true) WITH CHECK (true);


--
-- Name: sc_order_lines worker_claim; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY worker_claim ON public.sc_order_lines TO podhub_worker USING (true) WITH CHECK (true);


--
-- Name: sc_orders worker_claim; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY worker_claim ON public.sc_orders TO podhub_worker USING (true) WITH CHECK (true);


--
-- Name: subscription_events worker_claim; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY worker_claim ON public.subscription_events TO podhub_worker USING (true) WITH CHECK (true);


--
-- Name: subscription_periods worker_claim; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY worker_claim ON public.subscription_periods TO podhub_worker USING (true) WITH CHECK (true);


--
-- Name: subscription_quotes worker_claim; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY worker_claim ON public.subscription_quotes TO podhub_worker USING (true) WITH CHECK (true);


--
-- Name: subscriptions worker_claim; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY worker_claim ON public.subscriptions TO podhub_worker USING (true) WITH CHECK (true);


--
-- Name: workspace_psd_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workspace_psd_templates ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO podhub_app;
GRANT USAGE ON SCHEMA public TO podhub_worker;
GRANT USAGE ON SCHEMA public TO podhub_billing_lookup;


--
-- Name: FUNCTION gbtreekey16_in(cstring); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbtreekey16_in(cstring) TO podhub_app;
GRANT ALL ON FUNCTION public.gbtreekey16_in(cstring) TO podhub_worker;


--
-- Name: FUNCTION gbtreekey16_out(public.gbtreekey16); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbtreekey16_out(public.gbtreekey16) TO podhub_app;
GRANT ALL ON FUNCTION public.gbtreekey16_out(public.gbtreekey16) TO podhub_worker;


--
-- Name: FUNCTION gbtreekey2_in(cstring); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbtreekey2_in(cstring) TO podhub_app;
GRANT ALL ON FUNCTION public.gbtreekey2_in(cstring) TO podhub_worker;


--
-- Name: FUNCTION gbtreekey2_out(public.gbtreekey2); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbtreekey2_out(public.gbtreekey2) TO podhub_app;
GRANT ALL ON FUNCTION public.gbtreekey2_out(public.gbtreekey2) TO podhub_worker;


--
-- Name: FUNCTION gbtreekey32_in(cstring); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbtreekey32_in(cstring) TO podhub_app;
GRANT ALL ON FUNCTION public.gbtreekey32_in(cstring) TO podhub_worker;


--
-- Name: FUNCTION gbtreekey32_out(public.gbtreekey32); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbtreekey32_out(public.gbtreekey32) TO podhub_app;
GRANT ALL ON FUNCTION public.gbtreekey32_out(public.gbtreekey32) TO podhub_worker;


--
-- Name: FUNCTION gbtreekey4_in(cstring); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbtreekey4_in(cstring) TO podhub_app;
GRANT ALL ON FUNCTION public.gbtreekey4_in(cstring) TO podhub_worker;


--
-- Name: FUNCTION gbtreekey4_out(public.gbtreekey4); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbtreekey4_out(public.gbtreekey4) TO podhub_app;
GRANT ALL ON FUNCTION public.gbtreekey4_out(public.gbtreekey4) TO podhub_worker;


--
-- Name: FUNCTION gbtreekey8_in(cstring); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbtreekey8_in(cstring) TO podhub_app;
GRANT ALL ON FUNCTION public.gbtreekey8_in(cstring) TO podhub_worker;


--
-- Name: FUNCTION gbtreekey8_out(public.gbtreekey8); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbtreekey8_out(public.gbtreekey8) TO podhub_app;
GRANT ALL ON FUNCTION public.gbtreekey8_out(public.gbtreekey8) TO podhub_worker;


--
-- Name: FUNCTION gbtreekey_var_in(cstring); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbtreekey_var_in(cstring) TO podhub_app;
GRANT ALL ON FUNCTION public.gbtreekey_var_in(cstring) TO podhub_worker;


--
-- Name: FUNCTION gbtreekey_var_out(public.gbtreekey_var); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbtreekey_var_out(public.gbtreekey_var) TO podhub_app;
GRANT ALL ON FUNCTION public.gbtreekey_var_out(public.gbtreekey_var) TO podhub_worker;


--
-- Name: FUNCTION gtrgm_in(cstring); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gtrgm_in(cstring) TO podhub_app;
GRANT ALL ON FUNCTION public.gtrgm_in(cstring) TO podhub_worker;


--
-- Name: FUNCTION gtrgm_out(public.gtrgm); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gtrgm_out(public.gtrgm) TO podhub_app;
GRANT ALL ON FUNCTION public.gtrgm_out(public.gtrgm) TO podhub_worker;


--
-- Name: FUNCTION account_users_attribution_is_write_once(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.account_users_attribution_is_write_once() TO podhub_app;
GRANT ALL ON FUNCTION public.account_users_attribution_is_write_once() TO podhub_worker;


--
-- Name: FUNCTION agent_commission_ledger_is_immutable(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.agent_commission_ledger_is_immutable() TO podhub_app;
GRANT ALL ON FUNCTION public.agent_commission_ledger_is_immutable() TO podhub_worker;


--
-- Name: FUNCTION armor(bytea); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.armor(bytea) TO podhub_app;
GRANT ALL ON FUNCTION public.armor(bytea) TO podhub_worker;


--
-- Name: FUNCTION armor(bytea, text[], text[]); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.armor(bytea, text[], text[]) TO podhub_app;
GRANT ALL ON FUNCTION public.armor(bytea, text[], text[]) TO podhub_worker;


--
-- Name: FUNCTION automation_grant_authority_immutable(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.automation_grant_authority_immutable() TO podhub_app;
GRANT ALL ON FUNCTION public.automation_grant_authority_immutable() TO podhub_worker;


--
-- Name: FUNCTION billing_consume_redeem_code(p_id bigint, p_user bigint, p_org bigint, p_used_at_ms bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.billing_consume_redeem_code(p_id bigint, p_user bigint, p_org bigint, p_used_at_ms bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.billing_consume_redeem_code(p_id bigint, p_user bigint, p_org bigint, p_used_at_ms bigint) TO podhub_app;
GRANT ALL ON FUNCTION public.billing_consume_redeem_code(p_id bigint, p_user bigint, p_org bigint, p_used_at_ms bigint) TO podhub_worker;
GRANT ALL ON FUNCTION public.billing_consume_redeem_code(p_id bigint, p_user bigint, p_org bigint, p_used_at_ms bigint) TO podhub_login_api;


--
-- Name: FUNCTION billing_due_drains(deadline_seconds bigint, at_time timestamp with time zone, batch_size integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.billing_due_drains(deadline_seconds bigint, at_time timestamp with time zone, batch_size integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.billing_due_drains(deadline_seconds bigint, at_time timestamp with time zone, batch_size integer) TO podhub_app;
GRANT ALL ON FUNCTION public.billing_due_drains(deadline_seconds bigint, at_time timestamp with time zone, batch_size integer) TO podhub_worker;


--
-- Name: FUNCTION billing_due_subscriptions(at_time timestamp with time zone, batch_size integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.billing_due_subscriptions(at_time timestamp with time zone, batch_size integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.billing_due_subscriptions(at_time timestamp with time zone, batch_size integer) TO podhub_app;
GRANT ALL ON FUNCTION public.billing_due_subscriptions(at_time timestamp with time zone, batch_size integer) TO podhub_worker;


--
-- Name: FUNCTION billing_lock_payment_order(p_public_id text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.billing_lock_payment_order(p_public_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.billing_lock_payment_order(p_public_id text) TO podhub_app;
GRANT ALL ON FUNCTION public.billing_lock_payment_order(p_public_id text) TO podhub_worker;
GRANT ALL ON FUNCTION public.billing_lock_payment_order(p_public_id text) TO podhub_login_api;


--
-- Name: FUNCTION billing_lock_redeem_code(p_code text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.billing_lock_redeem_code(p_code text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.billing_lock_redeem_code(p_code text) TO podhub_app;
GRANT ALL ON FUNCTION public.billing_lock_redeem_code(p_code text) TO podhub_worker;
GRANT ALL ON FUNCTION public.billing_lock_redeem_code(p_code text) TO podhub_login_api;


--
-- Name: FUNCTION billing_owner_paid_orders(p_user_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.billing_owner_paid_orders(p_user_id bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.billing_owner_paid_orders(p_user_id bigint) TO podhub_app;
GRANT ALL ON FUNCTION public.billing_owner_paid_orders(p_user_id bigint) TO podhub_worker;
GRANT ALL ON FUNCTION public.billing_owner_paid_orders(p_user_id bigint) TO podhub_login_api;


--
-- Name: FUNCTION billing_payment_order_brief(p_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.billing_payment_order_brief(p_id bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.billing_payment_order_brief(p_id bigint) TO podhub_app;
GRANT ALL ON FUNCTION public.billing_payment_order_brief(p_id bigint) TO podhub_worker;
GRANT ALL ON FUNCTION public.billing_payment_order_brief(p_id bigint) TO podhub_login_api;


--
-- Name: FUNCTION billing_payment_order_org(p_public_id text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.billing_payment_order_org(p_public_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.billing_payment_order_org(p_public_id text) TO podhub_app;
GRANT ALL ON FUNCTION public.billing_payment_order_org(p_public_id text) TO podhub_worker;
GRANT ALL ON FUNCTION public.billing_payment_order_org(p_public_id text) TO podhub_login_api;


--
-- Name: FUNCTION billing_reap_subscription_orders(at_time timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.billing_reap_subscription_orders(at_time timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.billing_reap_subscription_orders(at_time timestamp with time zone) TO podhub_app;
GRANT ALL ON FUNCTION public.billing_reap_subscription_orders(at_time timestamp with time zone) TO podhub_worker;


--
-- Name: FUNCTION billing_replay_candidates(p_seconds bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.billing_replay_candidates(p_seconds bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.billing_replay_candidates(p_seconds bigint) TO podhub_app;
GRANT ALL ON FUNCTION public.billing_replay_candidates(p_seconds bigint) TO podhub_worker;
GRANT ALL ON FUNCTION public.billing_replay_candidates(p_seconds bigint) TO podhub_login_api;


--
-- Name: FUNCTION bump_listing_view_revision(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.bump_listing_view_revision() TO podhub_app;
GRANT ALL ON FUNCTION public.bump_listing_view_revision() TO podhub_worker;


--
-- Name: FUNCTION cash_dist(money, money); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.cash_dist(money, money) TO podhub_app;
GRANT ALL ON FUNCTION public.cash_dist(money, money) TO podhub_worker;


--
-- Name: FUNCTION check_ai_image_owner(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.check_ai_image_owner() TO podhub_app;
GRANT ALL ON FUNCTION public.check_ai_image_owner() TO podhub_worker;


--
-- Name: FUNCTION crypt(text, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.crypt(text, text) TO podhub_app;
GRANT ALL ON FUNCTION public.crypt(text, text) TO podhub_worker;


--
-- Name: FUNCTION date_dist(date, date); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.date_dist(date, date) TO podhub_app;
GRANT ALL ON FUNCTION public.date_dist(date, date) TO podhub_worker;


--
-- Name: FUNCTION dearmor(text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.dearmor(text) TO podhub_app;
GRANT ALL ON FUNCTION public.dearmor(text) TO podhub_worker;


--
-- Name: FUNCTION decrypt(bytea, bytea, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.decrypt(bytea, bytea, text) TO podhub_app;
GRANT ALL ON FUNCTION public.decrypt(bytea, bytea, text) TO podhub_worker;


--
-- Name: FUNCTION decrypt_iv(bytea, bytea, bytea, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.decrypt_iv(bytea, bytea, bytea, text) TO podhub_app;
GRANT ALL ON FUNCTION public.decrypt_iv(bytea, bytea, bytea, text) TO podhub_worker;


--
-- Name: FUNCTION delegate_credit_fulfiller_wallet(p_dispatch_id uuid, p_now_ms bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.delegate_credit_fulfiller_wallet(p_dispatch_id uuid, p_now_ms bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.delegate_credit_fulfiller_wallet(p_dispatch_id uuid, p_now_ms bigint) TO podhub_app;
GRANT ALL ON FUNCTION public.delegate_credit_fulfiller_wallet(p_dispatch_id uuid, p_now_ms bigint) TO podhub_worker;


--
-- Name: FUNCTION delegate_source_active_fulfiller_count(p_source_id text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.delegate_source_active_fulfiller_count(p_source_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.delegate_source_active_fulfiller_count(p_source_id text) TO podhub_app;
GRANT ALL ON FUNCTION public.delegate_source_active_fulfiller_count(p_source_id text) TO podhub_worker;


--
-- Name: FUNCTION delegate_source_active_fulfiller_id(p_source_id text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.delegate_source_active_fulfiller_id(p_source_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.delegate_source_active_fulfiller_id(p_source_id text) TO podhub_app;
GRANT ALL ON FUNCTION public.delegate_source_active_fulfiller_id(p_source_id text) TO podhub_worker;


--
-- Name: FUNCTION delegate_source_active_member_count(p_source_id text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.delegate_source_active_member_count(p_source_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.delegate_source_active_member_count(p_source_id text) TO podhub_app;
GRANT ALL ON FUNCTION public.delegate_source_active_member_count(p_source_id text) TO podhub_worker;


--
-- Name: FUNCTION delegate_supplier_accept(p_dispatch_id uuid, p_supplier_user_id bigint, p_fulfiller_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.delegate_supplier_accept(p_dispatch_id uuid, p_supplier_user_id bigint, p_fulfiller_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.delegate_supplier_accept(p_dispatch_id uuid, p_supplier_user_id bigint, p_fulfiller_id uuid) TO podhub_app;
GRANT ALL ON FUNCTION public.delegate_supplier_accept(p_dispatch_id uuid, p_supplier_user_id bigint, p_fulfiller_id uuid) TO podhub_worker;


--
-- Name: FUNCTION delegate_supplier_recompute_order_state(p_order_id uuid, p_now_ms bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.delegate_supplier_recompute_order_state(p_order_id uuid, p_now_ms bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.delegate_supplier_recompute_order_state(p_order_id uuid, p_now_ms bigint) TO podhub_app;
GRANT ALL ON FUNCTION public.delegate_supplier_recompute_order_state(p_order_id uuid, p_now_ms bigint) TO podhub_worker;


--
-- Name: FUNCTION delegate_supplier_reject(p_dispatch_id uuid, p_supplier_user_id bigint, p_reason text, p_fulfiller_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.delegate_supplier_reject(p_dispatch_id uuid, p_supplier_user_id bigint, p_reason text, p_fulfiller_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.delegate_supplier_reject(p_dispatch_id uuid, p_supplier_user_id bigint, p_reason text, p_fulfiller_id uuid) TO podhub_app;
GRANT ALL ON FUNCTION public.delegate_supplier_reject(p_dispatch_id uuid, p_supplier_user_id bigint, p_reason text, p_fulfiller_id uuid) TO podhub_worker;


--
-- Name: FUNCTION delegate_supplier_ship(p_dispatch_id uuid, p_supplier_user_id bigint, p_tracking_no text, p_note text, p_now_ms bigint, p_fulfiller_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.delegate_supplier_ship(p_dispatch_id uuid, p_supplier_user_id bigint, p_tracking_no text, p_note text, p_now_ms bigint, p_fulfiller_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.delegate_supplier_ship(p_dispatch_id uuid, p_supplier_user_id bigint, p_tracking_no text, p_note text, p_now_ms bigint, p_fulfiller_id uuid) TO podhub_app;
GRANT ALL ON FUNCTION public.delegate_supplier_ship(p_dispatch_id uuid, p_supplier_user_id bigint, p_tracking_no text, p_note text, p_now_ms bigint, p_fulfiller_id uuid) TO podhub_worker;


--
-- Name: FUNCTION digest(bytea, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.digest(bytea, text) TO podhub_app;
GRANT ALL ON FUNCTION public.digest(bytea, text) TO podhub_worker;


--
-- Name: FUNCTION digest(text, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.digest(text, text) TO podhub_app;
GRANT ALL ON FUNCTION public.digest(text, text) TO podhub_worker;


--
-- Name: FUNCTION encrypt(bytea, bytea, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.encrypt(bytea, bytea, text) TO podhub_app;
GRANT ALL ON FUNCTION public.encrypt(bytea, bytea, text) TO podhub_worker;


--
-- Name: FUNCTION encrypt_iv(bytea, bytea, bytea, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.encrypt_iv(bytea, bytea, bytea, text) TO podhub_app;
GRANT ALL ON FUNCTION public.encrypt_iv(bytea, bytea, bytea, text) TO podhub_worker;


--
-- Name: FUNCTION execution_member_active(p_org_id bigint, p_user_id bigint); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.execution_member_active(p_org_id bigint, p_user_id bigint) TO podhub_app;
GRANT ALL ON FUNCTION public.execution_member_active(p_org_id bigint, p_user_id bigint) TO podhub_worker;


--
-- Name: FUNCTION execution_quota_user_limit(p_class text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.execution_quota_user_limit(p_class text) TO podhub_app;
GRANT ALL ON FUNCTION public.execution_quota_user_limit(p_class text) TO podhub_worker;


--
-- Name: FUNCTION float4_dist(real, real); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.float4_dist(real, real) TO podhub_app;
GRANT ALL ON FUNCTION public.float4_dist(real, real) TO podhub_worker;


--
-- Name: FUNCTION float8_dist(double precision, double precision); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.float8_dist(double precision, double precision) TO podhub_app;
GRANT ALL ON FUNCTION public.float8_dist(double precision, double precision) TO podhub_worker;


--
-- Name: FUNCTION gbt_bit_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_bit_compress(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_bit_compress(internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_bit_consistent(internal, bit, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_bit_consistent(internal, bit, smallint, oid, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_bit_consistent(internal, bit, smallint, oid, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_bit_penalty(internal, internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_bit_penalty(internal, internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_bit_penalty(internal, internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_bit_picksplit(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_bit_picksplit(internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_bit_picksplit(internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_bit_same(public.gbtreekey_var, public.gbtreekey_var, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_bit_same(public.gbtreekey_var, public.gbtreekey_var, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_bit_same(public.gbtreekey_var, public.gbtreekey_var, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_bit_union(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_bit_union(internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_bit_union(internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_bool_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_bool_compress(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_bool_compress(internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_bool_consistent(internal, boolean, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_bool_consistent(internal, boolean, smallint, oid, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_bool_consistent(internal, boolean, smallint, oid, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_bool_fetch(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_bool_fetch(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_bool_fetch(internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_bool_penalty(internal, internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_bool_penalty(internal, internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_bool_penalty(internal, internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_bool_picksplit(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_bool_picksplit(internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_bool_picksplit(internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_bool_same(public.gbtreekey2, public.gbtreekey2, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_bool_same(public.gbtreekey2, public.gbtreekey2, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_bool_same(public.gbtreekey2, public.gbtreekey2, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_bool_union(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_bool_union(internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_bool_union(internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_bpchar_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_bpchar_compress(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_bpchar_compress(internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_bpchar_consistent(internal, character, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_bpchar_consistent(internal, character, smallint, oid, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_bpchar_consistent(internal, character, smallint, oid, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_bytea_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_bytea_compress(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_bytea_compress(internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_bytea_consistent(internal, bytea, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_bytea_consistent(internal, bytea, smallint, oid, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_bytea_consistent(internal, bytea, smallint, oid, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_bytea_penalty(internal, internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_bytea_penalty(internal, internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_bytea_penalty(internal, internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_bytea_picksplit(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_bytea_picksplit(internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_bytea_picksplit(internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_bytea_same(public.gbtreekey_var, public.gbtreekey_var, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_bytea_same(public.gbtreekey_var, public.gbtreekey_var, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_bytea_same(public.gbtreekey_var, public.gbtreekey_var, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_bytea_union(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_bytea_union(internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_bytea_union(internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_cash_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_cash_compress(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_cash_compress(internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_cash_consistent(internal, money, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_cash_consistent(internal, money, smallint, oid, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_cash_consistent(internal, money, smallint, oid, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_cash_distance(internal, money, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_cash_distance(internal, money, smallint, oid, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_cash_distance(internal, money, smallint, oid, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_cash_fetch(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_cash_fetch(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_cash_fetch(internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_cash_penalty(internal, internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_cash_penalty(internal, internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_cash_penalty(internal, internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_cash_picksplit(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_cash_picksplit(internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_cash_picksplit(internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_cash_same(public.gbtreekey16, public.gbtreekey16, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_cash_same(public.gbtreekey16, public.gbtreekey16, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_cash_same(public.gbtreekey16, public.gbtreekey16, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_cash_union(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_cash_union(internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_cash_union(internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_date_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_date_compress(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_date_compress(internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_date_consistent(internal, date, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_date_consistent(internal, date, smallint, oid, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_date_consistent(internal, date, smallint, oid, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_date_distance(internal, date, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_date_distance(internal, date, smallint, oid, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_date_distance(internal, date, smallint, oid, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_date_fetch(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_date_fetch(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_date_fetch(internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_date_penalty(internal, internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_date_penalty(internal, internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_date_penalty(internal, internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_date_picksplit(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_date_picksplit(internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_date_picksplit(internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_date_same(public.gbtreekey8, public.gbtreekey8, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_date_same(public.gbtreekey8, public.gbtreekey8, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_date_same(public.gbtreekey8, public.gbtreekey8, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_date_union(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_date_union(internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_date_union(internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_decompress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_decompress(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_decompress(internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_enum_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_enum_compress(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_enum_compress(internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_enum_consistent(internal, anyenum, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_enum_consistent(internal, anyenum, smallint, oid, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_enum_consistent(internal, anyenum, smallint, oid, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_enum_fetch(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_enum_fetch(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_enum_fetch(internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_enum_penalty(internal, internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_enum_penalty(internal, internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_enum_penalty(internal, internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_enum_picksplit(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_enum_picksplit(internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_enum_picksplit(internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_enum_same(public.gbtreekey8, public.gbtreekey8, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_enum_same(public.gbtreekey8, public.gbtreekey8, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_enum_same(public.gbtreekey8, public.gbtreekey8, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_enum_union(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_enum_union(internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_enum_union(internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_float4_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_float4_compress(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_float4_compress(internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_float4_consistent(internal, real, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_float4_consistent(internal, real, smallint, oid, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_float4_consistent(internal, real, smallint, oid, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_float4_distance(internal, real, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_float4_distance(internal, real, smallint, oid, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_float4_distance(internal, real, smallint, oid, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_float4_fetch(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_float4_fetch(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_float4_fetch(internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_float4_penalty(internal, internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_float4_penalty(internal, internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_float4_penalty(internal, internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_float4_picksplit(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_float4_picksplit(internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_float4_picksplit(internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_float4_same(public.gbtreekey8, public.gbtreekey8, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_float4_same(public.gbtreekey8, public.gbtreekey8, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_float4_same(public.gbtreekey8, public.gbtreekey8, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_float4_union(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_float4_union(internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_float4_union(internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_float8_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_float8_compress(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_float8_compress(internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_float8_consistent(internal, double precision, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_float8_consistent(internal, double precision, smallint, oid, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_float8_consistent(internal, double precision, smallint, oid, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_float8_distance(internal, double precision, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_float8_distance(internal, double precision, smallint, oid, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_float8_distance(internal, double precision, smallint, oid, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_float8_fetch(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_float8_fetch(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_float8_fetch(internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_float8_penalty(internal, internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_float8_penalty(internal, internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_float8_penalty(internal, internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_float8_picksplit(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_float8_picksplit(internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_float8_picksplit(internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_float8_same(public.gbtreekey16, public.gbtreekey16, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_float8_same(public.gbtreekey16, public.gbtreekey16, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_float8_same(public.gbtreekey16, public.gbtreekey16, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_float8_union(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_float8_union(internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_float8_union(internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_inet_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_inet_compress(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_inet_compress(internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_inet_consistent(internal, inet, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_inet_consistent(internal, inet, smallint, oid, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_inet_consistent(internal, inet, smallint, oid, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_inet_penalty(internal, internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_inet_penalty(internal, internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_inet_penalty(internal, internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_inet_picksplit(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_inet_picksplit(internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_inet_picksplit(internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_inet_same(public.gbtreekey16, public.gbtreekey16, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_inet_same(public.gbtreekey16, public.gbtreekey16, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_inet_same(public.gbtreekey16, public.gbtreekey16, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_inet_union(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_inet_union(internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_inet_union(internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_int2_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int2_compress(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_int2_compress(internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_int2_consistent(internal, smallint, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int2_consistent(internal, smallint, smallint, oid, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_int2_consistent(internal, smallint, smallint, oid, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_int2_distance(internal, smallint, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int2_distance(internal, smallint, smallint, oid, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_int2_distance(internal, smallint, smallint, oid, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_int2_fetch(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int2_fetch(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_int2_fetch(internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_int2_penalty(internal, internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int2_penalty(internal, internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_int2_penalty(internal, internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_int2_picksplit(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int2_picksplit(internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_int2_picksplit(internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_int2_same(public.gbtreekey4, public.gbtreekey4, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int2_same(public.gbtreekey4, public.gbtreekey4, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_int2_same(public.gbtreekey4, public.gbtreekey4, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_int2_union(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int2_union(internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_int2_union(internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_int4_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int4_compress(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_int4_compress(internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_int4_consistent(internal, integer, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int4_consistent(internal, integer, smallint, oid, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_int4_consistent(internal, integer, smallint, oid, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_int4_distance(internal, integer, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int4_distance(internal, integer, smallint, oid, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_int4_distance(internal, integer, smallint, oid, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_int4_fetch(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int4_fetch(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_int4_fetch(internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_int4_penalty(internal, internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int4_penalty(internal, internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_int4_penalty(internal, internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_int4_picksplit(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int4_picksplit(internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_int4_picksplit(internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_int4_same(public.gbtreekey8, public.gbtreekey8, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int4_same(public.gbtreekey8, public.gbtreekey8, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_int4_same(public.gbtreekey8, public.gbtreekey8, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_int4_union(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int4_union(internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_int4_union(internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_int8_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int8_compress(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_int8_compress(internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_int8_consistent(internal, bigint, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int8_consistent(internal, bigint, smallint, oid, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_int8_consistent(internal, bigint, smallint, oid, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_int8_distance(internal, bigint, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int8_distance(internal, bigint, smallint, oid, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_int8_distance(internal, bigint, smallint, oid, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_int8_fetch(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int8_fetch(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_int8_fetch(internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_int8_penalty(internal, internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int8_penalty(internal, internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_int8_penalty(internal, internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_int8_picksplit(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int8_picksplit(internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_int8_picksplit(internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_int8_same(public.gbtreekey16, public.gbtreekey16, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int8_same(public.gbtreekey16, public.gbtreekey16, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_int8_same(public.gbtreekey16, public.gbtreekey16, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_int8_union(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_int8_union(internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_int8_union(internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_intv_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_intv_compress(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_intv_compress(internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_intv_consistent(internal, interval, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_intv_consistent(internal, interval, smallint, oid, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_intv_consistent(internal, interval, smallint, oid, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_intv_decompress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_intv_decompress(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_intv_decompress(internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_intv_distance(internal, interval, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_intv_distance(internal, interval, smallint, oid, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_intv_distance(internal, interval, smallint, oid, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_intv_fetch(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_intv_fetch(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_intv_fetch(internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_intv_penalty(internal, internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_intv_penalty(internal, internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_intv_penalty(internal, internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_intv_picksplit(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_intv_picksplit(internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_intv_picksplit(internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_intv_same(public.gbtreekey32, public.gbtreekey32, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_intv_same(public.gbtreekey32, public.gbtreekey32, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_intv_same(public.gbtreekey32, public.gbtreekey32, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_intv_union(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_intv_union(internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_intv_union(internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_macad8_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_macad8_compress(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_macad8_compress(internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_macad8_consistent(internal, macaddr8, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_macad8_consistent(internal, macaddr8, smallint, oid, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_macad8_consistent(internal, macaddr8, smallint, oid, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_macad8_fetch(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_macad8_fetch(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_macad8_fetch(internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_macad8_penalty(internal, internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_macad8_penalty(internal, internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_macad8_penalty(internal, internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_macad8_picksplit(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_macad8_picksplit(internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_macad8_picksplit(internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_macad8_same(public.gbtreekey16, public.gbtreekey16, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_macad8_same(public.gbtreekey16, public.gbtreekey16, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_macad8_same(public.gbtreekey16, public.gbtreekey16, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_macad8_union(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_macad8_union(internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_macad8_union(internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_macad_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_macad_compress(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_macad_compress(internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_macad_consistent(internal, macaddr, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_macad_consistent(internal, macaddr, smallint, oid, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_macad_consistent(internal, macaddr, smallint, oid, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_macad_fetch(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_macad_fetch(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_macad_fetch(internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_macad_penalty(internal, internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_macad_penalty(internal, internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_macad_penalty(internal, internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_macad_picksplit(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_macad_picksplit(internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_macad_picksplit(internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_macad_same(public.gbtreekey16, public.gbtreekey16, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_macad_same(public.gbtreekey16, public.gbtreekey16, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_macad_same(public.gbtreekey16, public.gbtreekey16, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_macad_union(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_macad_union(internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_macad_union(internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_numeric_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_numeric_compress(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_numeric_compress(internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_numeric_consistent(internal, numeric, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_numeric_consistent(internal, numeric, smallint, oid, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_numeric_consistent(internal, numeric, smallint, oid, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_numeric_penalty(internal, internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_numeric_penalty(internal, internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_numeric_penalty(internal, internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_numeric_picksplit(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_numeric_picksplit(internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_numeric_picksplit(internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_numeric_same(public.gbtreekey_var, public.gbtreekey_var, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_numeric_same(public.gbtreekey_var, public.gbtreekey_var, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_numeric_same(public.gbtreekey_var, public.gbtreekey_var, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_numeric_union(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_numeric_union(internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_numeric_union(internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_oid_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_oid_compress(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_oid_compress(internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_oid_consistent(internal, oid, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_oid_consistent(internal, oid, smallint, oid, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_oid_consistent(internal, oid, smallint, oid, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_oid_distance(internal, oid, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_oid_distance(internal, oid, smallint, oid, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_oid_distance(internal, oid, smallint, oid, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_oid_fetch(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_oid_fetch(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_oid_fetch(internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_oid_penalty(internal, internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_oid_penalty(internal, internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_oid_penalty(internal, internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_oid_picksplit(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_oid_picksplit(internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_oid_picksplit(internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_oid_same(public.gbtreekey8, public.gbtreekey8, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_oid_same(public.gbtreekey8, public.gbtreekey8, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_oid_same(public.gbtreekey8, public.gbtreekey8, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_oid_union(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_oid_union(internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_oid_union(internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_text_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_text_compress(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_text_compress(internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_text_consistent(internal, text, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_text_consistent(internal, text, smallint, oid, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_text_consistent(internal, text, smallint, oid, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_text_penalty(internal, internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_text_penalty(internal, internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_text_penalty(internal, internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_text_picksplit(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_text_picksplit(internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_text_picksplit(internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_text_same(public.gbtreekey_var, public.gbtreekey_var, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_text_same(public.gbtreekey_var, public.gbtreekey_var, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_text_same(public.gbtreekey_var, public.gbtreekey_var, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_text_union(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_text_union(internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_text_union(internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_time_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_time_compress(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_time_compress(internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_time_consistent(internal, time without time zone, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_time_consistent(internal, time without time zone, smallint, oid, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_time_consistent(internal, time without time zone, smallint, oid, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_time_distance(internal, time without time zone, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_time_distance(internal, time without time zone, smallint, oid, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_time_distance(internal, time without time zone, smallint, oid, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_time_fetch(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_time_fetch(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_time_fetch(internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_time_penalty(internal, internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_time_penalty(internal, internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_time_penalty(internal, internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_time_picksplit(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_time_picksplit(internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_time_picksplit(internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_time_same(public.gbtreekey16, public.gbtreekey16, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_time_same(public.gbtreekey16, public.gbtreekey16, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_time_same(public.gbtreekey16, public.gbtreekey16, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_time_union(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_time_union(internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_time_union(internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_timetz_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_timetz_compress(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_timetz_compress(internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_timetz_consistent(internal, time with time zone, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_timetz_consistent(internal, time with time zone, smallint, oid, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_timetz_consistent(internal, time with time zone, smallint, oid, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_ts_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_ts_compress(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_ts_compress(internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_ts_consistent(internal, timestamp without time zone, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_ts_consistent(internal, timestamp without time zone, smallint, oid, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_ts_consistent(internal, timestamp without time zone, smallint, oid, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_ts_distance(internal, timestamp without time zone, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_ts_distance(internal, timestamp without time zone, smallint, oid, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_ts_distance(internal, timestamp without time zone, smallint, oid, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_ts_fetch(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_ts_fetch(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_ts_fetch(internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_ts_penalty(internal, internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_ts_penalty(internal, internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_ts_penalty(internal, internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_ts_picksplit(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_ts_picksplit(internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_ts_picksplit(internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_ts_same(public.gbtreekey16, public.gbtreekey16, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_ts_same(public.gbtreekey16, public.gbtreekey16, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_ts_same(public.gbtreekey16, public.gbtreekey16, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_ts_union(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_ts_union(internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_ts_union(internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_tstz_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_tstz_compress(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_tstz_compress(internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_tstz_consistent(internal, timestamp with time zone, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_tstz_consistent(internal, timestamp with time zone, smallint, oid, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_tstz_consistent(internal, timestamp with time zone, smallint, oid, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_tstz_distance(internal, timestamp with time zone, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_tstz_distance(internal, timestamp with time zone, smallint, oid, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_tstz_distance(internal, timestamp with time zone, smallint, oid, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_uuid_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_uuid_compress(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_uuid_compress(internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_uuid_consistent(internal, uuid, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_uuid_consistent(internal, uuid, smallint, oid, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_uuid_consistent(internal, uuid, smallint, oid, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_uuid_fetch(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_uuid_fetch(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_uuid_fetch(internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_uuid_penalty(internal, internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_uuid_penalty(internal, internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_uuid_penalty(internal, internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_uuid_picksplit(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_uuid_picksplit(internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_uuid_picksplit(internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_uuid_same(public.gbtreekey32, public.gbtreekey32, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_uuid_same(public.gbtreekey32, public.gbtreekey32, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_uuid_same(public.gbtreekey32, public.gbtreekey32, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_uuid_union(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_uuid_union(internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_uuid_union(internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_var_decompress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_var_decompress(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_var_decompress(internal) TO podhub_worker;


--
-- Name: FUNCTION gbt_var_fetch(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gbt_var_fetch(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gbt_var_fetch(internal) TO podhub_worker;


--
-- Name: FUNCTION gen_random_bytes(integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gen_random_bytes(integer) TO podhub_app;
GRANT ALL ON FUNCTION public.gen_random_bytes(integer) TO podhub_worker;


--
-- Name: FUNCTION gen_random_uuid(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gen_random_uuid() TO podhub_app;
GRANT ALL ON FUNCTION public.gen_random_uuid() TO podhub_worker;


--
-- Name: FUNCTION gen_salt(text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gen_salt(text) TO podhub_app;
GRANT ALL ON FUNCTION public.gen_salt(text) TO podhub_worker;


--
-- Name: FUNCTION gen_salt(text, integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gen_salt(text, integer) TO podhub_app;
GRANT ALL ON FUNCTION public.gen_salt(text, integer) TO podhub_worker;


--
-- Name: FUNCTION gin_extract_query_trgm(text, internal, smallint, internal, internal, internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gin_extract_query_trgm(text, internal, smallint, internal, internal, internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gin_extract_query_trgm(text, internal, smallint, internal, internal, internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gin_extract_value_trgm(text, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gin_extract_value_trgm(text, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gin_extract_value_trgm(text, internal) TO podhub_worker;


--
-- Name: FUNCTION gin_trgm_consistent(internal, smallint, text, integer, internal, internal, internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gin_trgm_consistent(internal, smallint, text, integer, internal, internal, internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gin_trgm_consistent(internal, smallint, text, integer, internal, internal, internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gin_trgm_triconsistent(internal, smallint, text, integer, internal, internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gin_trgm_triconsistent(internal, smallint, text, integer, internal, internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gin_trgm_triconsistent(internal, smallint, text, integer, internal, internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gtrgm_compress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gtrgm_compress(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gtrgm_compress(internal) TO podhub_worker;


--
-- Name: FUNCTION gtrgm_consistent(internal, text, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gtrgm_consistent(internal, text, smallint, oid, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gtrgm_consistent(internal, text, smallint, oid, internal) TO podhub_worker;


--
-- Name: FUNCTION gtrgm_decompress(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gtrgm_decompress(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gtrgm_decompress(internal) TO podhub_worker;


--
-- Name: FUNCTION gtrgm_distance(internal, text, smallint, oid, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gtrgm_distance(internal, text, smallint, oid, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gtrgm_distance(internal, text, smallint, oid, internal) TO podhub_worker;


--
-- Name: FUNCTION gtrgm_options(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gtrgm_options(internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gtrgm_options(internal) TO podhub_worker;


--
-- Name: FUNCTION gtrgm_penalty(internal, internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gtrgm_penalty(internal, internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gtrgm_penalty(internal, internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gtrgm_picksplit(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gtrgm_picksplit(internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gtrgm_picksplit(internal, internal) TO podhub_worker;


--
-- Name: FUNCTION gtrgm_same(public.gtrgm, public.gtrgm, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gtrgm_same(public.gtrgm, public.gtrgm, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gtrgm_same(public.gtrgm, public.gtrgm, internal) TO podhub_worker;


--
-- Name: FUNCTION gtrgm_union(internal, internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gtrgm_union(internal, internal) TO podhub_app;
GRANT ALL ON FUNCTION public.gtrgm_union(internal, internal) TO podhub_worker;


--
-- Name: FUNCTION guard_media_lease_reference_identity(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.guard_media_lease_reference_identity() FROM PUBLIC;


--
-- Name: FUNCTION guard_media_lease_retirement(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.guard_media_lease_retirement() TO podhub_app;
GRANT ALL ON FUNCTION public.guard_media_lease_retirement() TO podhub_worker;


--
-- Name: FUNCTION guard_media_reference_write(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.guard_media_reference_write() FROM PUBLIC;


--
-- Name: FUNCTION guard_submission_offer(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.guard_submission_offer() TO podhub_app;
GRANT ALL ON FUNCTION public.guard_submission_offer() TO podhub_worker;


--
-- Name: FUNCTION hmac(bytea, bytea, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.hmac(bytea, bytea, text) TO podhub_app;
GRANT ALL ON FUNCTION public.hmac(bytea, bytea, text) TO podhub_worker;


--
-- Name: FUNCTION hmac(text, text, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.hmac(text, text, text) TO podhub_app;
GRANT ALL ON FUNCTION public.hmac(text, text, text) TO podhub_worker;


--
-- Name: FUNCTION int2_dist(smallint, smallint); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.int2_dist(smallint, smallint) TO podhub_app;
GRANT ALL ON FUNCTION public.int2_dist(smallint, smallint) TO podhub_worker;


--
-- Name: FUNCTION int4_dist(integer, integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.int4_dist(integer, integer) TO podhub_app;
GRANT ALL ON FUNCTION public.int4_dist(integer, integer) TO podhub_worker;


--
-- Name: FUNCTION int8_dist(bigint, bigint); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.int8_dist(bigint, bigint) TO podhub_app;
GRANT ALL ON FUNCTION public.int8_dist(bigint, bigint) TO podhub_worker;


--
-- Name: FUNCTION interval_dist(interval, interval); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.interval_dist(interval, interval) TO podhub_app;
GRANT ALL ON FUNCTION public.interval_dist(interval, interval) TO podhub_worker;


--
-- Name: FUNCTION is_media_gc_image_key(object_key text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.is_media_gc_image_key(object_key text) TO podhub_app;
GRANT ALL ON FUNCTION public.is_media_gc_image_key(object_key text) TO podhub_worker;


--
-- Name: FUNCTION lock_media_reference_identity(p_workspace uuid, p_digest text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.lock_media_reference_identity(p_workspace uuid, p_digest text) FROM PUBLIC;


--
-- Name: FUNCTION lock_storage_key_shared(p_bucket_identity text, p_object_key text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.lock_storage_key_shared(p_bucket_identity text, p_object_key text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.lock_storage_key_shared(p_bucket_identity text, p_object_key text) TO podhub_app;
GRANT ALL ON FUNCTION public.lock_storage_key_shared(p_bucket_identity text, p_object_key text) TO podhub_worker;


--
-- Name: FUNCTION media_gc_image_identity(object_key text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.media_gc_image_identity(object_key text) TO podhub_app;
GRANT ALL ON FUNCTION public.media_gc_image_identity(object_key text) TO podhub_worker;


--
-- Name: FUNCTION media_reference_candidates(reference_text text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.media_reference_candidates(reference_text text) TO podhub_app;
GRANT ALL ON FUNCTION public.media_reference_candidates(reference_text text) TO podhub_worker;


--
-- Name: FUNCTION notify_ozon_jobs_wake(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.notify_ozon_jobs_wake() TO podhub_app;
GRANT ALL ON FUNCTION public.notify_ozon_jobs_wake() TO podhub_worker;


--
-- Name: FUNCTION oid_dist(oid, oid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.oid_dist(oid, oid) TO podhub_app;
GRANT ALL ON FUNCTION public.oid_dist(oid, oid) TO podhub_worker;


--
-- Name: FUNCTION payment_order_agreement_immutable(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.payment_order_agreement_immutable() TO podhub_app;
GRANT ALL ON FUNCTION public.payment_order_agreement_immutable() TO podhub_worker;


--
-- Name: FUNCTION payment_order_subscription_immutable(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.payment_order_subscription_immutable() TO podhub_app;
GRANT ALL ON FUNCTION public.payment_order_subscription_immutable() TO podhub_worker;


--
-- Name: FUNCTION pg_stat_statements(showtext boolean, OUT userid oid, OUT dbid oid, OUT toplevel boolean, OUT queryid bigint, OUT query text, OUT plans bigint, OUT total_plan_time double precision, OUT min_plan_time double precision, OUT max_plan_time double precision, OUT mean_plan_time double precision, OUT stddev_plan_time double precision, OUT calls bigint, OUT total_exec_time double precision, OUT min_exec_time double precision, OUT max_exec_time double precision, OUT mean_exec_time double precision, OUT stddev_exec_time double precision, OUT rows bigint, OUT shared_blks_hit bigint, OUT shared_blks_read bigint, OUT shared_blks_dirtied bigint, OUT shared_blks_written bigint, OUT local_blks_hit bigint, OUT local_blks_read bigint, OUT local_blks_dirtied bigint, OUT local_blks_written bigint, OUT temp_blks_read bigint, OUT temp_blks_written bigint, OUT blk_read_time double precision, OUT blk_write_time double precision, OUT temp_blk_read_time double precision, OUT temp_blk_write_time double precision, OUT wal_records bigint, OUT wal_fpi bigint, OUT wal_bytes numeric, OUT jit_functions bigint, OUT jit_generation_time double precision, OUT jit_inlining_count bigint, OUT jit_inlining_time double precision, OUT jit_optimization_count bigint, OUT jit_optimization_time double precision, OUT jit_emission_count bigint, OUT jit_emission_time double precision); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.pg_stat_statements(showtext boolean, OUT userid oid, OUT dbid oid, OUT toplevel boolean, OUT queryid bigint, OUT query text, OUT plans bigint, OUT total_plan_time double precision, OUT min_plan_time double precision, OUT max_plan_time double precision, OUT mean_plan_time double precision, OUT stddev_plan_time double precision, OUT calls bigint, OUT total_exec_time double precision, OUT min_exec_time double precision, OUT max_exec_time double precision, OUT mean_exec_time double precision, OUT stddev_exec_time double precision, OUT rows bigint, OUT shared_blks_hit bigint, OUT shared_blks_read bigint, OUT shared_blks_dirtied bigint, OUT shared_blks_written bigint, OUT local_blks_hit bigint, OUT local_blks_read bigint, OUT local_blks_dirtied bigint, OUT local_blks_written bigint, OUT temp_blks_read bigint, OUT temp_blks_written bigint, OUT blk_read_time double precision, OUT blk_write_time double precision, OUT temp_blk_read_time double precision, OUT temp_blk_write_time double precision, OUT wal_records bigint, OUT wal_fpi bigint, OUT wal_bytes numeric, OUT jit_functions bigint, OUT jit_generation_time double precision, OUT jit_inlining_count bigint, OUT jit_inlining_time double precision, OUT jit_optimization_count bigint, OUT jit_optimization_time double precision, OUT jit_emission_count bigint, OUT jit_emission_time double precision) TO podhub_app;
GRANT ALL ON FUNCTION public.pg_stat_statements(showtext boolean, OUT userid oid, OUT dbid oid, OUT toplevel boolean, OUT queryid bigint, OUT query text, OUT plans bigint, OUT total_plan_time double precision, OUT min_plan_time double precision, OUT max_plan_time double precision, OUT mean_plan_time double precision, OUT stddev_plan_time double precision, OUT calls bigint, OUT total_exec_time double precision, OUT min_exec_time double precision, OUT max_exec_time double precision, OUT mean_exec_time double precision, OUT stddev_exec_time double precision, OUT rows bigint, OUT shared_blks_hit bigint, OUT shared_blks_read bigint, OUT shared_blks_dirtied bigint, OUT shared_blks_written bigint, OUT local_blks_hit bigint, OUT local_blks_read bigint, OUT local_blks_dirtied bigint, OUT local_blks_written bigint, OUT temp_blks_read bigint, OUT temp_blks_written bigint, OUT blk_read_time double precision, OUT blk_write_time double precision, OUT temp_blk_read_time double precision, OUT temp_blk_write_time double precision, OUT wal_records bigint, OUT wal_fpi bigint, OUT wal_bytes numeric, OUT jit_functions bigint, OUT jit_generation_time double precision, OUT jit_inlining_count bigint, OUT jit_inlining_time double precision, OUT jit_optimization_count bigint, OUT jit_optimization_time double precision, OUT jit_emission_count bigint, OUT jit_emission_time double precision) TO podhub_worker;


--
-- Name: FUNCTION pg_stat_statements_info(OUT dealloc bigint, OUT stats_reset timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.pg_stat_statements_info(OUT dealloc bigint, OUT stats_reset timestamp with time zone) TO podhub_app;
GRANT ALL ON FUNCTION public.pg_stat_statements_info(OUT dealloc bigint, OUT stats_reset timestamp with time zone) TO podhub_worker;


--
-- Name: FUNCTION pgp_armor_headers(text, OUT key text, OUT value text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.pgp_armor_headers(text, OUT key text, OUT value text) TO podhub_app;
GRANT ALL ON FUNCTION public.pgp_armor_headers(text, OUT key text, OUT value text) TO podhub_worker;


--
-- Name: FUNCTION pgp_key_id(bytea); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.pgp_key_id(bytea) TO podhub_app;
GRANT ALL ON FUNCTION public.pgp_key_id(bytea) TO podhub_worker;


--
-- Name: FUNCTION pgp_pub_decrypt(bytea, bytea); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.pgp_pub_decrypt(bytea, bytea) TO podhub_app;
GRANT ALL ON FUNCTION public.pgp_pub_decrypt(bytea, bytea) TO podhub_worker;


--
-- Name: FUNCTION pgp_pub_decrypt(bytea, bytea, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.pgp_pub_decrypt(bytea, bytea, text) TO podhub_app;
GRANT ALL ON FUNCTION public.pgp_pub_decrypt(bytea, bytea, text) TO podhub_worker;


--
-- Name: FUNCTION pgp_pub_decrypt(bytea, bytea, text, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.pgp_pub_decrypt(bytea, bytea, text, text) TO podhub_app;
GRANT ALL ON FUNCTION public.pgp_pub_decrypt(bytea, bytea, text, text) TO podhub_worker;


--
-- Name: FUNCTION pgp_pub_decrypt_bytea(bytea, bytea); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.pgp_pub_decrypt_bytea(bytea, bytea) TO podhub_app;
GRANT ALL ON FUNCTION public.pgp_pub_decrypt_bytea(bytea, bytea) TO podhub_worker;


--
-- Name: FUNCTION pgp_pub_decrypt_bytea(bytea, bytea, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.pgp_pub_decrypt_bytea(bytea, bytea, text) TO podhub_app;
GRANT ALL ON FUNCTION public.pgp_pub_decrypt_bytea(bytea, bytea, text) TO podhub_worker;


--
-- Name: FUNCTION pgp_pub_decrypt_bytea(bytea, bytea, text, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.pgp_pub_decrypt_bytea(bytea, bytea, text, text) TO podhub_app;
GRANT ALL ON FUNCTION public.pgp_pub_decrypt_bytea(bytea, bytea, text, text) TO podhub_worker;


--
-- Name: FUNCTION pgp_pub_encrypt(text, bytea); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.pgp_pub_encrypt(text, bytea) TO podhub_app;
GRANT ALL ON FUNCTION public.pgp_pub_encrypt(text, bytea) TO podhub_worker;


--
-- Name: FUNCTION pgp_pub_encrypt(text, bytea, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.pgp_pub_encrypt(text, bytea, text) TO podhub_app;
GRANT ALL ON FUNCTION public.pgp_pub_encrypt(text, bytea, text) TO podhub_worker;


--
-- Name: FUNCTION pgp_pub_encrypt_bytea(bytea, bytea); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.pgp_pub_encrypt_bytea(bytea, bytea) TO podhub_app;
GRANT ALL ON FUNCTION public.pgp_pub_encrypt_bytea(bytea, bytea) TO podhub_worker;


--
-- Name: FUNCTION pgp_pub_encrypt_bytea(bytea, bytea, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.pgp_pub_encrypt_bytea(bytea, bytea, text) TO podhub_app;
GRANT ALL ON FUNCTION public.pgp_pub_encrypt_bytea(bytea, bytea, text) TO podhub_worker;


--
-- Name: FUNCTION pgp_sym_decrypt(bytea, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.pgp_sym_decrypt(bytea, text) TO podhub_app;
GRANT ALL ON FUNCTION public.pgp_sym_decrypt(bytea, text) TO podhub_worker;


--
-- Name: FUNCTION pgp_sym_decrypt(bytea, text, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.pgp_sym_decrypt(bytea, text, text) TO podhub_app;
GRANT ALL ON FUNCTION public.pgp_sym_decrypt(bytea, text, text) TO podhub_worker;


--
-- Name: FUNCTION pgp_sym_decrypt_bytea(bytea, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.pgp_sym_decrypt_bytea(bytea, text) TO podhub_app;
GRANT ALL ON FUNCTION public.pgp_sym_decrypt_bytea(bytea, text) TO podhub_worker;


--
-- Name: FUNCTION pgp_sym_decrypt_bytea(bytea, text, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.pgp_sym_decrypt_bytea(bytea, text, text) TO podhub_app;
GRANT ALL ON FUNCTION public.pgp_sym_decrypt_bytea(bytea, text, text) TO podhub_worker;


--
-- Name: FUNCTION pgp_sym_encrypt(text, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.pgp_sym_encrypt(text, text) TO podhub_app;
GRANT ALL ON FUNCTION public.pgp_sym_encrypt(text, text) TO podhub_worker;


--
-- Name: FUNCTION pgp_sym_encrypt(text, text, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.pgp_sym_encrypt(text, text, text) TO podhub_app;
GRANT ALL ON FUNCTION public.pgp_sym_encrypt(text, text, text) TO podhub_worker;


--
-- Name: FUNCTION pgp_sym_encrypt_bytea(bytea, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.pgp_sym_encrypt_bytea(bytea, text) TO podhub_app;
GRANT ALL ON FUNCTION public.pgp_sym_encrypt_bytea(bytea, text) TO podhub_worker;


--
-- Name: FUNCTION pgp_sym_encrypt_bytea(bytea, text, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.pgp_sym_encrypt_bytea(bytea, text, text) TO podhub_app;
GRANT ALL ON FUNCTION public.pgp_sym_encrypt_bytea(bytea, text, text) TO podhub_worker;


--
-- Name: FUNCTION prompt_revisions_append_only(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.prompt_revisions_append_only() TO podhub_app;
GRANT ALL ON FUNCTION public.prompt_revisions_append_only() TO podhub_worker;


--
-- Name: FUNCTION prune_aged_inbox(older_seconds bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.prune_aged_inbox(older_seconds bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.prune_aged_inbox(older_seconds bigint) TO podhub_error_prune;


--
-- Name: FUNCTION reap_stale_execution_permits(p_limit bigint); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.reap_stale_execution_permits(p_limit bigint) TO podhub_app;
GRANT ALL ON FUNCTION public.reap_stale_execution_permits(p_limit bigint) TO podhub_worker;


--
-- Name: FUNCTION refresh_account_queue_head(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.refresh_account_queue_head() TO podhub_app;
GRANT ALL ON FUNCTION public.refresh_account_queue_head() TO podhub_worker;


--
-- Name: FUNCTION register_execution_demand(p_class text, p_user_id bigint); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.register_execution_demand(p_class text, p_user_id bigint) TO podhub_app;
GRANT ALL ON FUNCTION public.register_execution_demand(p_class text, p_user_id bigint) TO podhub_worker;


--
-- Name: FUNCTION release_execution_permit(p_holder_kind text, p_holder_id text, p_lease_epoch bigint); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.release_execution_permit(p_holder_kind text, p_holder_id text, p_lease_epoch bigint) TO podhub_app;
GRANT ALL ON FUNCTION public.release_execution_permit(p_holder_kind text, p_holder_id text, p_lease_epoch bigint) TO podhub_worker;


--
-- Name: FUNCTION resolve_listing_credential_issues(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.resolve_listing_credential_issues() TO podhub_app;
GRANT ALL ON FUNCTION public.resolve_listing_credential_issues() TO podhub_worker;


--
-- Name: FUNCTION sc_sources_manager_pin_flags(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.sc_sources_manager_pin_flags() TO podhub_app;
GRANT ALL ON FUNCTION public.sc_sources_manager_pin_flags() TO podhub_worker;


--
-- Name: FUNCTION seal_listing_row_events(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.seal_listing_row_events() TO podhub_app;
GRANT ALL ON FUNCTION public.seal_listing_row_events() TO podhub_worker;


--
-- Name: FUNCTION set_limit(real); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.set_limit(real) TO podhub_app;
GRANT ALL ON FUNCTION public.set_limit(real) TO podhub_worker;


--
-- Name: FUNCTION show_limit(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.show_limit() TO podhub_app;
GRANT ALL ON FUNCTION public.show_limit() TO podhub_worker;


--
-- Name: FUNCTION show_trgm(text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.show_trgm(text) TO podhub_app;
GRANT ALL ON FUNCTION public.show_trgm(text) TO podhub_worker;


--
-- Name: FUNCTION similarity(text, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.similarity(text, text) TO podhub_app;
GRANT ALL ON FUNCTION public.similarity(text, text) TO podhub_worker;


--
-- Name: FUNCTION similarity_dist(text, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.similarity_dist(text, text) TO podhub_app;
GRANT ALL ON FUNCTION public.similarity_dist(text, text) TO podhub_worker;


--
-- Name: FUNCTION similarity_op(text, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.similarity_op(text, text) TO podhub_app;
GRANT ALL ON FUNCTION public.similarity_op(text, text) TO podhub_worker;


--
-- Name: FUNCTION stage_listing_card_event(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.stage_listing_card_event() TO podhub_app;
GRANT ALL ON FUNCTION public.stage_listing_card_event() TO podhub_worker;


--
-- Name: FUNCTION stage_listing_row_event(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.stage_listing_row_event() TO podhub_app;
GRANT ALL ON FUNCTION public.stage_listing_row_event() TO podhub_worker;


--
-- Name: FUNCTION storage_key_fence(p_bucket_identity text, p_object_key text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.storage_key_fence(p_bucket_identity text, p_object_key text) TO podhub_app;
GRANT ALL ON FUNCTION public.storage_key_fence(p_bucket_identity text, p_object_key text) TO podhub_worker;


--
-- Name: FUNCTION storage_ref_candidates(p_row jsonb, p_paths text[]); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.storage_ref_candidates(p_row jsonb, p_paths text[]) FROM PUBLIC;


--
-- Name: FUNCTION strict_word_similarity(text, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.strict_word_similarity(text, text) TO podhub_app;
GRANT ALL ON FUNCTION public.strict_word_similarity(text, text) TO podhub_worker;


--
-- Name: FUNCTION strict_word_similarity_commutator_op(text, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.strict_word_similarity_commutator_op(text, text) TO podhub_app;
GRANT ALL ON FUNCTION public.strict_word_similarity_commutator_op(text, text) TO podhub_worker;


--
-- Name: FUNCTION strict_word_similarity_dist_commutator_op(text, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.strict_word_similarity_dist_commutator_op(text, text) TO podhub_app;
GRANT ALL ON FUNCTION public.strict_word_similarity_dist_commutator_op(text, text) TO podhub_worker;


--
-- Name: FUNCTION strict_word_similarity_dist_op(text, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.strict_word_similarity_dist_op(text, text) TO podhub_app;
GRANT ALL ON FUNCTION public.strict_word_similarity_dist_op(text, text) TO podhub_worker;


--
-- Name: FUNCTION strict_word_similarity_op(text, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.strict_word_similarity_op(text, text) TO podhub_app;
GRANT ALL ON FUNCTION public.strict_word_similarity_op(text, text) TO podhub_worker;


--
-- Name: FUNCTION subscription_capacity(workspace bigint, at_time timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.subscription_capacity(workspace bigint, at_time timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.subscription_capacity(workspace bigint, at_time timestamp with time zone) TO podhub_app;
GRANT ALL ON FUNCTION public.subscription_capacity(workspace bigint, at_time timestamp with time zone) TO podhub_worker;


--
-- Name: FUNCTION subscription_member_allowed(workspace bigint, member bigint, at_time timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.subscription_member_allowed(workspace bigint, member bigint, at_time timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.subscription_member_allowed(workspace bigint, member bigint, at_time timestamp with time zone) TO podhub_app;
GRANT ALL ON FUNCTION public.subscription_member_allowed(workspace bigint, member bigint, at_time timestamp with time zone) TO podhub_worker;


--
-- Name: FUNCTION subscription_store_allowed(workspace bigint, store uuid, at_time timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.subscription_store_allowed(workspace bigint, store uuid, at_time timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.subscription_store_allowed(workspace bigint, store uuid, at_time timestamp with time zone) TO podhub_app;
GRANT ALL ON FUNCTION public.subscription_store_allowed(workspace bigint, store uuid, at_time timestamp with time zone) TO podhub_worker;


--
-- Name: FUNCTION supplier_dispatch_quote(p_dispatch_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.supplier_dispatch_quote(p_dispatch_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.supplier_dispatch_quote(p_dispatch_id uuid) TO podhub_app;
GRANT ALL ON FUNCTION public.supplier_dispatch_quote(p_dispatch_id uuid) TO podhub_worker;


--
-- Name: FUNCTION supplier_fulfiller_sources(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.supplier_fulfiller_sources() FROM PUBLIC;
GRANT ALL ON FUNCTION public.supplier_fulfiller_sources() TO podhub_app;
GRANT ALL ON FUNCTION public.supplier_fulfiller_sources() TO podhub_worker;


--
-- Name: FUNCTION sync_account_side_tables(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.sync_account_side_tables() TO podhub_app;
GRANT ALL ON FUNCTION public.sync_account_side_tables() TO podhub_worker;


--
-- Name: FUNCTION sync_storage_object_refs(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.sync_storage_object_refs() FROM PUBLIC;


--
-- Name: FUNCTION time_dist(time without time zone, time without time zone); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.time_dist(time without time zone, time without time zone) TO podhub_app;
GRANT ALL ON FUNCTION public.time_dist(time without time zone, time without time zone) TO podhub_worker;


--
-- Name: FUNCTION touch_listing_intent_row(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.touch_listing_intent_row() TO podhub_app;
GRANT ALL ON FUNCTION public.touch_listing_intent_row() TO podhub_worker;


--
-- Name: FUNCTION try_grant_execution_permit(p_classes text[], p_org_id bigint, p_user_id bigint, p_holder_kind text, p_holder_id text, p_lease_epoch bigint, p_expires_at timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.try_grant_execution_permit(p_classes text[], p_org_id bigint, p_user_id bigint, p_holder_kind text, p_holder_id text, p_lease_epoch bigint, p_expires_at timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.try_grant_execution_permit(p_classes text[], p_org_id bigint, p_user_id bigint, p_holder_kind text, p_holder_id text, p_lease_epoch bigint, p_expires_at timestamp with time zone) TO podhub_app;
GRANT ALL ON FUNCTION public.try_grant_execution_permit(p_classes text[], p_org_id bigint, p_user_id bigint, p_holder_kind text, p_holder_id text, p_lease_epoch bigint, p_expires_at timestamp with time zone) TO podhub_worker;


--
-- Name: FUNCTION try_lock_storage_key_exclusive(p_bucket_identity text, p_object_key text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.try_lock_storage_key_exclusive(p_bucket_identity text, p_object_key text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.try_lock_storage_key_exclusive(p_bucket_identity text, p_object_key text) TO podhub_app;
GRANT ALL ON FUNCTION public.try_lock_storage_key_exclusive(p_bucket_identity text, p_object_key text) TO podhub_worker;


--
-- Name: FUNCTION ts_dist(timestamp without time zone, timestamp without time zone); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.ts_dist(timestamp without time zone, timestamp without time zone) TO podhub_app;
GRANT ALL ON FUNCTION public.ts_dist(timestamp without time zone, timestamp without time zone) TO podhub_worker;


--
-- Name: FUNCTION tstz_dist(timestamp with time zone, timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.tstz_dist(timestamp with time zone, timestamp with time zone) TO podhub_app;
GRANT ALL ON FUNCTION public.tstz_dist(timestamp with time zone, timestamp with time zone) TO podhub_worker;


--
-- Name: FUNCTION wallet_ledger_is_immutable(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.wallet_ledger_is_immutable() TO podhub_app;
GRANT ALL ON FUNCTION public.wallet_ledger_is_immutable() TO podhub_worker;


--
-- Name: FUNCTION word_similarity(text, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.word_similarity(text, text) TO podhub_app;
GRANT ALL ON FUNCTION public.word_similarity(text, text) TO podhub_worker;


--
-- Name: FUNCTION word_similarity_commutator_op(text, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.word_similarity_commutator_op(text, text) TO podhub_app;
GRANT ALL ON FUNCTION public.word_similarity_commutator_op(text, text) TO podhub_worker;


--
-- Name: FUNCTION word_similarity_dist_commutator_op(text, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.word_similarity_dist_commutator_op(text, text) TO podhub_app;
GRANT ALL ON FUNCTION public.word_similarity_dist_commutator_op(text, text) TO podhub_worker;


--
-- Name: FUNCTION word_similarity_dist_op(text, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.word_similarity_dist_op(text, text) TO podhub_app;
GRANT ALL ON FUNCTION public.word_similarity_dist_op(text, text) TO podhub_worker;


--
-- Name: FUNCTION word_similarity_op(text, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.word_similarity_op(text, text) TO podhub_app;
GRANT ALL ON FUNCTION public.word_similarity_op(text, text) TO podhub_worker;


--
-- Name: TABLE account_admin_totp; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.account_admin_totp TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.account_admin_totp TO podhub_worker;


--
-- Name: TABLE account_credentials; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.account_credentials TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.account_credentials TO podhub_worker;


--
-- Name: TABLE account_profiles; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.account_profiles TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.account_profiles TO podhub_worker;


--
-- Name: TABLE account_queue_cursor; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.account_queue_cursor TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.account_queue_cursor TO podhub_worker;


--
-- Name: TABLE account_queue_head; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.account_queue_head TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.account_queue_head TO podhub_worker;


--
-- Name: TABLE account_sessions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.account_sessions TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.account_sessions TO podhub_worker;


--
-- Name: TABLE account_users; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.account_users TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.account_users TO podhub_worker;


--
-- Name: SEQUENCE account_users_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.account_users_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.account_users_id_seq TO podhub_worker;


--
-- Name: TABLE agent_commission_ledger; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.agent_commission_ledger TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.agent_commission_ledger TO podhub_worker;


--
-- Name: SEQUENCE agent_commission_ledger_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.agent_commission_ledger_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.agent_commission_ledger_id_seq TO podhub_worker;


--
-- Name: TABLE agent_commission_wallets; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.agent_commission_wallets TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.agent_commission_wallets TO podhub_worker;


--
-- Name: TABLE agent_commissions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.agent_commissions TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.agent_commissions TO podhub_worker;


--
-- Name: SEQUENCE agent_commissions_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.agent_commissions_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.agent_commissions_id_seq TO podhub_worker;


--
-- Name: TABLE agent_rebate_policy; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.agent_rebate_policy TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.agent_rebate_policy TO podhub_worker;


--
-- Name: TABLE agent_withdrawals; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.agent_withdrawals TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.agent_withdrawals TO podhub_worker;


--
-- Name: SEQUENCE agent_withdrawals_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.agent_withdrawals_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.agent_withdrawals_id_seq TO podhub_worker;


--
-- Name: TABLE agents; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.agents TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.agents TO podhub_worker;


--
-- Name: TABLE ai_billing_ratio_documents; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.ai_billing_ratio_documents TO podhub_app;


--
-- Name: SEQUENCE ai_billing_ratio_documents_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.ai_billing_ratio_documents_id_seq TO podhub_app;


--
-- Name: TABLE ai_consume_logs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.ai_consume_logs TO podhub_app;


--
-- Name: SEQUENCE ai_consume_logs_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.ai_consume_logs_id_seq TO podhub_app;


--
-- Name: TABLE ai_image_set_items; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.ai_image_set_items TO podhub_app;


--
-- Name: TABLE ai_image_sets; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.ai_image_sets TO podhub_app;


--
-- Name: TABLE ai_price_schedules; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.ai_price_schedules TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.ai_price_schedules TO podhub_worker;


--
-- Name: SEQUENCE ai_price_schedules_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.ai_price_schedules_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.ai_price_schedules_id_seq TO podhub_worker;


--
-- Name: TABLE ai_requests; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.ai_requests TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.ai_requests TO podhub_worker;


--
-- Name: COLUMN ai_requests.id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(id) ON TABLE public.ai_requests TO podhub_maintenance;


--
-- Name: COLUMN ai_requests.public_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(public_id) ON TABLE public.ai_requests TO podhub_maintenance;


--
-- Name: COLUMN ai_requests.org_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(org_id) ON TABLE public.ai_requests TO podhub_maintenance;


--
-- Name: COLUMN ai_requests.status; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(status) ON TABLE public.ai_requests TO podhub_maintenance;


--
-- Name: COLUMN ai_requests.held_microfen; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(held_microfen) ON TABLE public.ai_requests TO podhub_maintenance;


--
-- Name: COLUMN ai_requests.response_body; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(response_body),UPDATE(response_body) ON TABLE public.ai_requests TO podhub_maintenance;


--
-- Name: COLUMN ai_requests.settled_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(settled_at) ON TABLE public.ai_requests TO podhub_maintenance;


--
-- Name: COLUMN ai_requests.updated_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(updated_at) ON TABLE public.ai_requests TO podhub_maintenance;


--
-- Name: SEQUENCE ai_requests_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.ai_requests_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.ai_requests_id_seq TO podhub_worker;


--
-- Name: TABLE audit_logs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.audit_logs TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.audit_logs TO podhub_worker;


--
-- Name: SEQUENCE audit_logs_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.audit_logs_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.audit_logs_id_seq TO podhub_worker;


--
-- Name: TABLE auth_email_tokens; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.auth_email_tokens TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.auth_email_tokens TO podhub_worker;


--
-- Name: TABLE auth_login_attempts; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.auth_login_attempts TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.auth_login_attempts TO podhub_worker;


--
-- Name: TABLE automation_asset_set_items; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.automation_asset_set_items TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.automation_asset_set_items TO podhub_worker;


--
-- Name: TABLE automation_asset_sets; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.automation_asset_sets TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.automation_asset_sets TO podhub_worker;


--
-- Name: TABLE automation_call_receipts; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE ON TABLE public.automation_call_receipts TO podhub_app;


--
-- Name: TABLE automation_executions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.automation_executions TO podhub_app;


--
-- Name: TABLE automation_grants; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.automation_grants TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.automation_grants TO podhub_worker;


--
-- Name: TABLE automation_runtimes; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.automation_runtimes TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.automation_runtimes TO podhub_worker;


--
-- Name: TABLE banned_tags; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.banned_tags TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.banned_tags TO podhub_worker;


--
-- Name: SEQUENCE banned_tags_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.banned_tags_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.banned_tags_id_seq TO podhub_worker;


--
-- Name: TABLE billable_usage_events; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.billable_usage_events TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.billable_usage_events TO podhub_worker;


--
-- Name: SEQUENCE billable_usage_events_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.billable_usage_events_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.billable_usage_events_id_seq TO podhub_worker;


--
-- Name: TABLE billable_usage_rollups; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.billable_usage_rollups TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.billable_usage_rollups TO podhub_worker;


--
-- Name: SEQUENCE billable_usage_rollups_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.billable_usage_rollups_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.billable_usage_rollups_id_seq TO podhub_worker;


--
-- Name: TABLE billing_operations; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.billing_operations TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.billing_operations TO podhub_worker;


--
-- Name: COLUMN billing_operations.id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(id) ON TABLE public.billing_operations TO podhub_maintenance;


--
-- Name: COLUMN billing_operations.org_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(org_id) ON TABLE public.billing_operations TO podhub_maintenance;


--
-- Name: COLUMN billing_operations.idempotency_key; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(idempotency_key) ON TABLE public.billing_operations TO podhub_maintenance;


--
-- Name: COLUMN billing_operations.expected_upper_bound_microfen; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(expected_upper_bound_microfen) ON TABLE public.billing_operations TO podhub_maintenance;


--
-- Name: COLUMN billing_operations.state; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(state),UPDATE(state) ON TABLE public.billing_operations TO podhub_maintenance;


--
-- Name: COLUMN billing_operations.updated_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(updated_at),UPDATE(updated_at) ON TABLE public.billing_operations TO podhub_maintenance;


--
-- Name: SEQUENCE billing_operations_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.billing_operations_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.billing_operations_id_seq TO podhub_worker;


--
-- Name: TABLE browser_commands; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.browser_commands TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.browser_commands TO podhub_worker;


--
-- Name: TABLE catalog_dictionary_search_material; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.catalog_dictionary_search_material TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.catalog_dictionary_search_material TO podhub_worker;


--
-- Name: TABLE category_prompts; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.category_prompts TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.category_prompts TO podhub_worker;


--
-- Name: SEQUENCE category_prompts_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.category_prompts_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.category_prompts_id_seq TO podhub_worker;


--
-- Name: TABLE category_videos; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.category_videos TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.category_videos TO podhub_worker;


--
-- Name: SEQUENCE category_videos_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.category_videos_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.category_videos_id_seq TO podhub_worker;


--
-- Name: TABLE client_listing_logs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.client_listing_logs TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.client_listing_logs TO podhub_worker;
GRANT DELETE ON TABLE public.client_listing_logs TO podhub_maintenance;


--
-- Name: COLUMN client_listing_logs.received_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(received_at) ON TABLE public.client_listing_logs TO podhub_maintenance;


--
-- Name: SEQUENCE client_listing_logs_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.client_listing_logs_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.client_listing_logs_id_seq TO podhub_worker;


--
-- Name: TABLE console_store_metrics; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.console_store_metrics TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.console_store_metrics TO podhub_worker;


--
-- Name: TABLE delegate_assets; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.delegate_assets TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.delegate_assets TO podhub_worker;


--
-- Name: TABLE delegate_bindings; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.delegate_bindings TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.delegate_bindings TO podhub_worker;


--
-- Name: TABLE delegate_dispatch_assets; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.delegate_dispatch_assets TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.delegate_dispatch_assets TO podhub_worker;


--
-- Name: TABLE delegate_dispatches; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.delegate_dispatches TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.delegate_dispatches TO podhub_worker;


--
-- Name: TABLE delegate_order_lines; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.delegate_order_lines TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.delegate_order_lines TO podhub_worker;


--
-- Name: TABLE delegate_orders; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.delegate_orders TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.delegate_orders TO podhub_worker;


--
-- Name: TABLE delegate_settlements; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.delegate_settlements TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.delegate_settlements TO podhub_worker;


--
-- Name: TABLE error_digest; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.error_digest TO podhub_app;
GRANT SELECT,INSERT,UPDATE ON TABLE public.error_digest TO podhub_digest_platform;


--
-- Name: SEQUENCE error_digest_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.error_digest_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.error_digest_id_seq TO podhub_digest_platform;


--
-- Name: TABLE event_inbox_events; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.event_inbox_events TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.event_inbox_events TO podhub_worker;


--
-- Name: COLUMN event_inbox_events.org_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(org_id) ON TABLE public.event_inbox_events TO podhub_digest_platform;


--
-- Name: COLUMN event_inbox_events.kind; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(kind) ON TABLE public.event_inbox_events TO podhub_digest_platform;


--
-- Name: COLUMN event_inbox_events.payload_json; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(payload_json) ON TABLE public.event_inbox_events TO podhub_digest_platform;


--
-- Name: COLUMN event_inbox_events.received_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(received_at) ON TABLE public.event_inbox_events TO podhub_digest_platform;


--
-- Name: TABLE execution_fairness; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.execution_fairness TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.execution_fairness TO podhub_worker;


--
-- Name: TABLE execution_fairness_cursor; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.execution_fairness_cursor TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.execution_fairness_cursor TO podhub_worker;


--
-- Name: TABLE execution_permits; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.execution_permits TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.execution_permits TO podhub_worker;


--
-- Name: TABLE execution_quota; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.execution_quota TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.execution_quota TO podhub_worker;


--
-- Name: TABLE jobs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.jobs TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.jobs TO podhub_worker;


--
-- Name: TABLE lease_budget; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.lease_budget TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.lease_budget TO podhub_worker;


--
-- Name: TABLE lease_slot; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.lease_slot TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.lease_slot TO podhub_worker;


--
-- Name: TABLE lease_window; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.lease_window TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.lease_window TO podhub_worker;


--
-- Name: TABLE listing_card_cursors; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.listing_card_cursors TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.listing_card_cursors TO podhub_worker;


--
-- Name: TABLE listing_cards; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.listing_cards TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.listing_cards TO podhub_worker;


--
-- Name: TABLE ozon_listing_field_templates; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.ozon_listing_field_templates TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.ozon_listing_field_templates TO podhub_worker;


--
-- Name: SEQUENCE listing_field_templates_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.listing_field_templates_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.listing_field_templates_id_seq TO podhub_worker;


--
-- Name: TABLE listing_row_events; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.listing_row_events TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.listing_row_events TO podhub_worker;


--
-- Name: TABLE listing_rows; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.listing_rows TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.listing_rows TO podhub_worker;


--
-- Name: TABLE listing_schema_revisions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.listing_schema_revisions TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.listing_schema_revisions TO podhub_worker;


--
-- Name: TABLE ozon_listing_schema_snapshots; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.ozon_listing_schema_snapshots TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.ozon_listing_schema_snapshots TO podhub_worker;


--
-- Name: SEQUENCE listing_schema_snapshots_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.listing_schema_snapshots_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.listing_schema_snapshots_id_seq TO podhub_worker;


--
-- Name: TABLE media_bindings; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.media_bindings TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.media_bindings TO podhub_worker;


--
-- Name: TABLE media_blobs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.media_blobs TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.media_blobs TO podhub_worker;


--
-- Name: TABLE media_lib_assets; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.media_lib_assets TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.media_lib_assets TO podhub_worker;


--
-- Name: TABLE media_object_leases; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.media_object_leases TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.media_object_leases TO podhub_worker;


--
-- Name: COLUMN media_object_leases.updated_at; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE public.media_object_leases TO podhub_app;
GRANT UPDATE(updated_at) ON TABLE public.media_object_leases TO podhub_worker;


--
-- Name: TABLE media_uploads; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.media_uploads TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.media_uploads TO podhub_worker;


--
-- Name: TABLE notifications; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.notifications TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.notifications TO podhub_worker;


--
-- Name: SEQUENCE notifications_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.notifications_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.notifications_id_seq TO podhub_worker;


--
-- Name: TABLE org_invitations; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.org_invitations TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.org_invitations TO podhub_worker;


--
-- Name: SEQUENCE org_invitations_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.org_invitations_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.org_invitations_id_seq TO podhub_worker;


--
-- Name: TABLE organization_members; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.organization_members TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.organization_members TO podhub_worker;


--
-- Name: COLUMN organization_members.id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(id) ON TABLE public.organization_members TO podhub_billing_lookup;


--
-- Name: COLUMN organization_members.org_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(org_id) ON TABLE public.organization_members TO podhub_billing_lookup;


--
-- Name: COLUMN organization_members.role; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(role) ON TABLE public.organization_members TO podhub_billing_lookup;


--
-- Name: COLUMN organization_members.status; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(status) ON TABLE public.organization_members TO podhub_billing_lookup;


--
-- Name: COLUMN organization_members.join_order; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(join_order) ON TABLE public.organization_members TO podhub_billing_lookup;


--
-- Name: COLUMN organization_members.manual_disabled; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(manual_disabled) ON TABLE public.organization_members TO podhub_billing_lookup;


--
-- Name: SEQUENCE organization_members_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.organization_members_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.organization_members_id_seq TO podhub_worker;


--
-- Name: TABLE organization_store_groups; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.organization_store_groups TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.organization_store_groups TO podhub_worker;


--
-- Name: SEQUENCE organization_store_groups_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.organization_store_groups_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.organization_store_groups_id_seq TO podhub_worker;


--
-- Name: TABLE organization_store_tags; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.organization_store_tags TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.organization_store_tags TO podhub_worker;


--
-- Name: SEQUENCE organization_store_tags_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.organization_store_tags_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.organization_store_tags_id_seq TO podhub_worker;


--
-- Name: TABLE organization_stores; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.organization_stores TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.organization_stores TO podhub_worker;


--
-- Name: COLUMN organization_stores.id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(id) ON TABLE public.organization_stores TO podhub_billing_lookup;


--
-- Name: COLUMN organization_stores.org_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(org_id) ON TABLE public.organization_stores TO podhub_billing_lookup;


--
-- Name: COLUMN organization_stores.uuid; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(uuid) ON TABLE public.organization_stores TO podhub_billing_lookup;


--
-- Name: COLUMN organization_stores.create_order; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(create_order) ON TABLE public.organization_stores TO podhub_billing_lookup;


--
-- Name: COLUMN organization_stores.name; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(name) ON TABLE public.organization_stores TO podhub_app;
GRANT UPDATE(name) ON TABLE public.organization_stores TO podhub_worker;


--
-- Name: COLUMN organization_stores.manual_disabled; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(manual_disabled) ON TABLE public.organization_stores TO podhub_billing_lookup;


--
-- Name: COLUMN organization_stores.deleted_at_ms; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(deleted_at_ms) ON TABLE public.organization_stores TO podhub_billing_lookup;


--
-- Name: COLUMN organization_stores.updated_at; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE public.organization_stores TO podhub_app;
GRANT UPDATE(updated_at) ON TABLE public.organization_stores TO podhub_worker;


--
-- Name: COLUMN organization_stores.company_short_name; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(company_short_name) ON TABLE public.organization_stores TO podhub_app;
GRANT UPDATE(company_short_name) ON TABLE public.organization_stores TO podhub_worker;


--
-- Name: COLUMN organization_stores.company_legal_name; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(company_legal_name) ON TABLE public.organization_stores TO podhub_app;
GRANT UPDATE(company_legal_name) ON TABLE public.organization_stores TO podhub_worker;


--
-- Name: COLUMN organization_stores.name_source; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(name_source) ON TABLE public.organization_stores TO podhub_app;
GRANT UPDATE(name_source) ON TABLE public.organization_stores TO podhub_worker;


--
-- Name: COLUMN organization_stores.company_currency; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(company_currency) ON TABLE public.organization_stores TO podhub_app;
GRANT UPDATE(company_currency) ON TABLE public.organization_stores TO podhub_worker;


--
-- Name: COLUMN organization_stores.company_country; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(company_country) ON TABLE public.organization_stores TO podhub_app;
GRANT UPDATE(company_country) ON TABLE public.organization_stores TO podhub_worker;


--
-- Name: COLUMN organization_stores.subscription_is_premium; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(subscription_is_premium) ON TABLE public.organization_stores TO podhub_app;
GRANT UPDATE(subscription_is_premium) ON TABLE public.organization_stores TO podhub_worker;


--
-- Name: COLUMN organization_stores.subscription_type; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(subscription_type) ON TABLE public.organization_stores TO podhub_app;
GRANT UPDATE(subscription_type) ON TABLE public.organization_stores TO podhub_worker;


--
-- Name: COLUMN organization_stores.seller_info_synced_at; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(seller_info_synced_at) ON TABLE public.organization_stores TO podhub_app;
GRANT UPDATE(seller_info_synced_at) ON TABLE public.organization_stores TO podhub_worker;


--
-- Name: COLUMN organization_stores.seller_key_status; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(seller_key_status) ON TABLE public.organization_stores TO podhub_app;
GRANT UPDATE(seller_key_status) ON TABLE public.organization_stores TO podhub_worker;


--
-- Name: COLUMN organization_stores.seller_key_reason; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(seller_key_reason) ON TABLE public.organization_stores TO podhub_app;
GRANT UPDATE(seller_key_reason) ON TABLE public.organization_stores TO podhub_worker;


--
-- Name: SEQUENCE organization_stores_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.organization_stores_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.organization_stores_id_seq TO podhub_worker;


--
-- Name: TABLE organizations; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.organizations TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.organizations TO podhub_worker;
GRANT SELECT ON TABLE public.organizations TO podhub_billing_lookup;


--
-- Name: COLUMN organizations.id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(id) ON TABLE public.organizations TO podhub_billing_lookup;


--
-- Name: COLUMN organizations.store_limit_override; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(store_limit_override) ON TABLE public.organizations TO podhub_billing_lookup;


--
-- Name: COLUMN organizations.member_seat_limit_override; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(member_seat_limit_override) ON TABLE public.organizations TO podhub_billing_lookup;


--
-- Name: SEQUENCE organizations_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.organizations_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.organizations_id_seq TO podhub_worker;


--
-- Name: TABLE ozon_catalog_schema_cache; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.ozon_catalog_schema_cache TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.ozon_catalog_schema_cache TO podhub_worker;


--
-- Name: TABLE ozon_catalog_tree_cache; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.ozon_catalog_tree_cache TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.ozon_catalog_tree_cache TO podhub_worker;


--
-- Name: TABLE ozon_category_current; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.ozon_category_current TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.ozon_category_current TO podhub_worker;


--
-- Name: COLUMN ozon_category_current.updated_at; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE public.ozon_category_current TO podhub_app;
GRANT UPDATE(updated_at) ON TABLE public.ozon_category_current TO podhub_worker;


--
-- Name: TABLE ozon_delivery_methods; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.ozon_delivery_methods TO podhub_app;


--
-- Name: TABLE ozon_dictionary_current; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.ozon_dictionary_current TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.ozon_dictionary_current TO podhub_worker;


--
-- Name: TABLE ozon_error_catalog; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.ozon_error_catalog TO podhub_app;
GRANT SELECT,INSERT,UPDATE ON TABLE public.ozon_error_catalog TO podhub_ozon_catalog;


--
-- Name: COLUMN ozon_error_catalog.source; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(source) ON TABLE public.ozon_error_catalog TO podhub_ozon_sample_prune;


--
-- Name: COLUMN ozon_error_catalog.sample_description; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(sample_description),UPDATE(sample_description) ON TABLE public.ozon_error_catalog TO podhub_ozon_sample_prune;


--
-- Name: COLUMN ozon_error_catalog.last_seen_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(last_seen_at) ON TABLE public.ozon_error_catalog TO podhub_ozon_sample_prune;


--
-- Name: TABLE ozon_error_observation; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.ozon_error_observation TO podhub_app;


--
-- Name: COLUMN ozon_error_observation.sample_description; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(sample_description),UPDATE(sample_description) ON TABLE public.ozon_error_observation TO podhub_ozon_sample_prune;


--
-- Name: COLUMN ozon_error_observation.last_seen_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(last_seen_at) ON TABLE public.ozon_error_observation TO podhub_ozon_sample_prune;


--
-- Name: TABLE ozon_error_sighting; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.ozon_error_sighting TO podhub_app;


--
-- Name: TABLE ozon_field_packs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.ozon_field_packs TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.ozon_field_packs TO podhub_worker;


--
-- Name: TABLE ozon_product_status; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.ozon_product_status TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.ozon_product_status TO podhub_worker;


--
-- Name: SEQUENCE ozon_product_status_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.ozon_product_status_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.ozon_product_status_id_seq TO podhub_worker;


--
-- Name: TABLE ozon_warehouse_fences; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.ozon_warehouse_fences TO podhub_app;


--
-- Name: TABLE ozon_warehouse_intents; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.ozon_warehouse_intents TO podhub_app;


--
-- Name: TABLE ozon_warehouse_sync; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.ozon_warehouse_sync TO podhub_app;


--
-- Name: TABLE ozon_warehouses; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.ozon_warehouses TO podhub_app;


--
-- Name: TABLE payment_callback_ledger; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.payment_callback_ledger TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.payment_callback_ledger TO podhub_worker;
GRANT SELECT ON TABLE public.payment_callback_ledger TO podhub_billing_lookup;


--
-- Name: TABLE payment_orders; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.payment_orders TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.payment_orders TO podhub_worker;
GRANT SELECT,UPDATE ON TABLE public.payment_orders TO podhub_billing_lookup;


--
-- Name: SEQUENCE payment_orders_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.payment_orders_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.payment_orders_id_seq TO podhub_worker;


--
-- Name: TABLE plans; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.plans TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.plans TO podhub_worker;


--
-- Name: TABLE platform_catalog_fetch_config; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.platform_catalog_fetch_config TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.platform_catalog_fetch_config TO podhub_worker;


--
-- Name: TABLE platform_catalog_fetch_keys; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.platform_catalog_fetch_keys TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.platform_catalog_fetch_keys TO podhub_worker;


--
-- Name: SEQUENCE platform_catalog_fetch_keys_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.platform_catalog_fetch_keys_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.platform_catalog_fetch_keys_id_seq TO podhub_worker;


--
-- Name: TABLE platform_initialization; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.platform_initialization TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.platform_initialization TO podhub_worker;


--
-- Name: TABLE platform_integration_config; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.platform_integration_config TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.platform_integration_config TO podhub_worker;


--
-- Name: TABLE product_variant_previews; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.product_variant_previews TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.product_variant_previews TO podhub_worker;


--
-- Name: TABLE prompt_revisions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.prompt_revisions TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.prompt_revisions TO podhub_worker;


--
-- Name: SEQUENCE prompt_revisions_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.prompt_revisions_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.prompt_revisions_id_seq TO podhub_worker;


--
-- Name: TABLE redeem_codes; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.redeem_codes TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.redeem_codes TO podhub_worker;
GRANT SELECT,UPDATE ON TABLE public.redeem_codes TO podhub_billing_lookup;


--
-- Name: SEQUENCE redeem_codes_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.redeem_codes_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.redeem_codes_id_seq TO podhub_worker;


--
-- Name: TABLE sc_catalog_managers; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sc_catalog_managers TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sc_catalog_managers TO podhub_worker;


--
-- Name: TABLE sc_listing_bindings; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sc_listing_bindings TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sc_listing_bindings TO podhub_worker;


--
-- Name: SEQUENCE sc_listing_bindings_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.sc_listing_bindings_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.sc_listing_bindings_id_seq TO podhub_worker;


--
-- Name: TABLE sc_order_lines; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sc_order_lines TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sc_order_lines TO podhub_worker;


--
-- Name: SEQUENCE sc_order_lines_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.sc_order_lines_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.sc_order_lines_id_seq TO podhub_worker;


--
-- Name: TABLE sc_order_quotes; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sc_order_quotes TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sc_order_quotes TO podhub_worker;


--
-- Name: SEQUENCE sc_order_quotes_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.sc_order_quotes_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.sc_order_quotes_id_seq TO podhub_worker;


--
-- Name: TABLE sc_orders; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sc_orders TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sc_orders TO podhub_worker;


--
-- Name: SEQUENCE sc_orders_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.sc_orders_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.sc_orders_id_seq TO podhub_worker;


--
-- Name: TABLE sc_price_versions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sc_price_versions TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sc_price_versions TO podhub_worker;


--
-- Name: SEQUENCE sc_price_versions_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.sc_price_versions_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.sc_price_versions_id_seq TO podhub_worker;


--
-- Name: TABLE sc_procurements; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sc_procurements TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sc_procurements TO podhub_worker;


--
-- Name: SEQUENCE sc_procurements_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.sc_procurements_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.sc_procurements_id_seq TO podhub_worker;


--
-- Name: TABLE sc_products; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sc_products TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sc_products TO podhub_worker;


--
-- Name: SEQUENCE sc_products_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.sc_products_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.sc_products_id_seq TO podhub_worker;


--
-- Name: TABLE sc_skus; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sc_skus TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sc_skus TO podhub_worker;


--
-- Name: SEQUENCE sc_skus_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.sc_skus_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.sc_skus_id_seq TO podhub_worker;


--
-- Name: TABLE sc_source_fulfillers; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sc_source_fulfillers TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sc_source_fulfillers TO podhub_worker;


--
-- Name: TABLE sc_source_members; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sc_source_members TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sc_source_members TO podhub_worker;


--
-- Name: TABLE sc_source_offers; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sc_source_offers TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sc_source_offers TO podhub_worker;


--
-- Name: SEQUENCE sc_source_offers_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.sc_source_offers_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.sc_source_offers_id_seq TO podhub_worker;


--
-- Name: TABLE sc_source_prop_defs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sc_source_prop_defs TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sc_source_prop_defs TO podhub_worker;


--
-- Name: TABLE sc_sources; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sc_sources TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sc_sources TO podhub_worker;


--
-- Name: TABLE seller_read_incidents; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.seller_read_incidents TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.seller_read_incidents TO podhub_worker;


--
-- Name: SEQUENCE seller_read_incidents_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.seller_read_incidents_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.seller_read_incidents_id_seq TO podhub_worker;


--
-- Name: TABLE seller_resource_occupancies; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.seller_resource_occupancies TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.seller_resource_occupancies TO podhub_worker;


--
-- Name: TABLE seller_upstream_writes; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.seller_upstream_writes TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.seller_upstream_writes TO podhub_worker;


--
-- Name: TABLE shipping_inject_operations; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.shipping_inject_operations TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.shipping_inject_operations TO podhub_worker;


--
-- Name: SEQUENCE shipping_inject_operations_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.shipping_inject_operations_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.shipping_inject_operations_id_seq TO podhub_worker;


--
-- Name: TABLE shipping_preset_versions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.shipping_preset_versions TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.shipping_preset_versions TO podhub_worker;


--
-- Name: SEQUENCE shipping_preset_versions_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.shipping_preset_versions_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.shipping_preset_versions_id_seq TO podhub_worker;


--
-- Name: TABLE shipping_presets; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.shipping_presets TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.shipping_presets TO podhub_worker;


--
-- Name: SEQUENCE shipping_presets_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.shipping_presets_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.shipping_presets_id_seq TO podhub_worker;


--
-- Name: TABLE shipping_shop_injections; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.shipping_shop_injections TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.shipping_shop_injections TO podhub_worker;


--
-- Name: SEQUENCE shipping_shop_injections_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.shipping_shop_injections_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.shipping_shop_injections_id_seq TO podhub_worker;


--
-- Name: TABLE shipping_sku_bindings; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.shipping_sku_bindings TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.shipping_sku_bindings TO podhub_worker;


--
-- Name: SEQUENCE shipping_sku_bindings_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.shipping_sku_bindings_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.shipping_sku_bindings_id_seq TO podhub_worker;


--
-- Name: TABLE slice_r2_cleanup_runs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.slice_r2_cleanup_runs TO podhub_app;


--
-- Name: TABLE storage_object_refs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.storage_object_refs TO podhub_app;
GRANT SELECT ON TABLE public.storage_object_refs TO podhub_worker;


--
-- Name: TABLE storage_objects; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.storage_objects TO podhub_app;
GRANT SELECT ON TABLE public.storage_objects TO podhub_worker;


--
-- Name: TABLE storage_uploads; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.storage_uploads TO podhub_app;
GRANT SELECT,INSERT,UPDATE ON TABLE public.storage_uploads TO podhub_worker;


--
-- Name: TABLE store_credential_verifications; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.store_credential_verifications TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.store_credential_verifications TO podhub_worker;


--
-- Name: TABLE store_product_metrics; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.store_product_metrics TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.store_product_metrics TO podhub_worker;


--
-- Name: TABLE store_product_pass_pages; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.store_product_pass_pages TO podhub_worker;


--
-- Name: TABLE store_product_sync; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.store_product_sync TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.store_product_sync TO podhub_worker;


--
-- Name: TABLE store_products; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.store_products TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.store_products TO podhub_worker;


--
-- Name: TABLE store_rating_history; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.store_rating_history TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.store_rating_history TO podhub_worker;


--
-- Name: SEQUENCE store_rating_history_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.store_rating_history_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.store_rating_history_id_seq TO podhub_worker;


--
-- Name: TABLE store_rating_snapshots; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.store_rating_snapshots TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.store_rating_snapshots TO podhub_worker;


--
-- Name: TABLE store_rating_sync; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.store_rating_sync TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.store_rating_sync TO podhub_worker;


--
-- Name: TABLE store_seller_credentials; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.store_seller_credentials TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.store_seller_credentials TO podhub_worker;


--
-- Name: TABLE store_tag_links; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.store_tag_links TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.store_tag_links TO podhub_worker;


--
-- Name: TABLE store_tombstone_consumptions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.store_tombstone_consumptions TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.store_tombstone_consumptions TO podhub_worker;


--
-- Name: TABLE submission_intents; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.submission_intents TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.submission_intents TO podhub_worker;


--
-- Name: TABLE subscription_events; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.subscription_events TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.subscription_events TO podhub_worker;
GRANT SELECT,INSERT ON TABLE public.subscription_events TO podhub_billing_lookup;


--
-- Name: SEQUENCE subscription_events_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.subscription_events_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.subscription_events_id_seq TO podhub_worker;


--
-- Name: TABLE subscription_periods; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.subscription_periods TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.subscription_periods TO podhub_worker;
GRANT SELECT ON TABLE public.subscription_periods TO podhub_billing_lookup;


--
-- Name: SEQUENCE subscription_periods_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.subscription_periods_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.subscription_periods_id_seq TO podhub_worker;


--
-- Name: TABLE subscription_quotes; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.subscription_quotes TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.subscription_quotes TO podhub_worker;
GRANT SELECT,INSERT,UPDATE ON TABLE public.subscription_quotes TO podhub_billing_lookup;


--
-- Name: TABLE subscriptions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.subscriptions TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.subscriptions TO podhub_worker;
GRANT SELECT,UPDATE ON TABLE public.subscriptions TO podhub_billing_lookup;


--
-- Name: TABLE supplier_media_objects; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.supplier_media_objects TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.supplier_media_objects TO podhub_worker;


--
-- Name: TABLE supplier_ozon_configs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.supplier_ozon_configs TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.supplier_ozon_configs TO podhub_worker;


--
-- Name: TABLE supplier_wallet_ledger; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.supplier_wallet_ledger TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.supplier_wallet_ledger TO podhub_worker;


--
-- Name: TABLE supplier_wallets; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.supplier_wallets TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.supplier_wallets TO podhub_worker;


--
-- Name: TABLE supplier_withdrawals; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.supplier_withdrawals TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.supplier_withdrawals TO podhub_worker;


--
-- Name: TABLE support_grants; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.support_grants TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.support_grants TO podhub_worker;


--
-- Name: SEQUENCE support_grants_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.support_grants_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.support_grants_id_seq TO podhub_worker;


--
-- Name: TABLE transit_clear_runs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.transit_clear_runs TO podhub_app;


--
-- Name: TABLE user_wallets; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.user_wallets TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.user_wallets TO podhub_worker;


--
-- Name: TABLE wallet_ledger; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.wallet_ledger TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.wallet_ledger TO podhub_worker;


--
-- Name: SEQUENCE wallet_ledger_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.wallet_ledger_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.wallet_ledger_id_seq TO podhub_worker;


--
-- Name: TABLE wb_category_current; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.wb_category_current TO podhub_app;
GRANT SELECT ON TABLE public.wb_category_current TO podhub_worker;


--
-- Name: COLUMN wb_category_current.fetched_at_ms; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(fetched_at_ms) ON TABLE public.wb_category_current TO podhub_app;


--
-- Name: TABLE wb_category_field_defaults; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.wb_category_field_defaults TO podhub_app;
GRANT SELECT ON TABLE public.wb_category_field_defaults TO podhub_worker;


--
-- Name: TABLE workspace_psd_templates; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.workspace_psd_templates TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.workspace_psd_templates TO podhub_worker;


--
-- Name: TABLE writer_lease_events; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.writer_lease_events TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.writer_lease_events TO podhub_worker;


--
-- Name: SEQUENCE writer_lease_events_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.writer_lease_events_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.writer_lease_events_id_seq TO podhub_worker;


--
-- Name: SEQUENCE writer_lease_fence_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.writer_lease_fence_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.writer_lease_fence_seq TO podhub_worker;


--
-- Name: TABLE writer_leases; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.writer_leases TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.writer_leases TO podhub_worker;


--
-- Name: SEQUENCE writer_leases_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.writer_leases_id_seq TO podhub_app;
GRANT SELECT,USAGE ON SEQUENCE public.writer_leases_id_seq TO podhub_worker;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,USAGE ON SEQUENCES TO podhub_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,USAGE ON SEQUENCES TO podhub_worker;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO podhub_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO podhub_worker;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES TO podhub_app;

--
-- Name: billing lookup function ownership
--
-- These SECURITY DEFINER functions read cross-tenant payment and
-- subscription state. They are owned by podhub_billing_lookup, which is not a
-- login and is granted to nothing but the migration role, so EXECUTE is the
-- only way in.

ALTER FUNCTION public.billing_consume_redeem_code(bigint, bigint, bigint, bigint) OWNER TO podhub_billing_lookup;
ALTER FUNCTION public.billing_due_drains(bigint, timestamp with time zone, integer) OWNER TO podhub_billing_lookup;
ALTER FUNCTION public.billing_due_subscriptions(timestamp with time zone, integer) OWNER TO podhub_billing_lookup;
ALTER FUNCTION public.billing_lock_payment_order(text) OWNER TO podhub_billing_lookup;
ALTER FUNCTION public.billing_lock_redeem_code(text) OWNER TO podhub_billing_lookup;
ALTER FUNCTION public.billing_owner_paid_orders(bigint) OWNER TO podhub_billing_lookup;
ALTER FUNCTION public.billing_payment_order_brief(bigint) OWNER TO podhub_billing_lookup;
ALTER FUNCTION public.billing_payment_order_org(text) OWNER TO podhub_billing_lookup;
ALTER FUNCTION public.billing_reap_subscription_orders(timestamp with time zone) OWNER TO podhub_billing_lookup;
ALTER FUNCTION public.billing_replay_candidates(bigint) OWNER TO podhub_billing_lookup;
ALTER FUNCTION public.subscription_capacity(bigint, timestamp with time zone) OWNER TO podhub_billing_lookup;
ALTER FUNCTION public.subscription_member_allowed(bigint, bigint, timestamp with time zone) OWNER TO podhub_billing_lookup;
ALTER FUNCTION public.subscription_store_allowed(bigint, uuid, timestamp with time zone) OWNER TO podhub_billing_lookup;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES TO podhub_worker;


--
--
-- pg_dump pins an empty search_path so no object resolves implicitly. goose
-- records the applied version with an unqualified INSERT, so the session
-- default is restored before the statement block ends.
RESET ALL;
SET search_path TO public;
-- +goose StatementEnd
-- +goose Down
-- The schema baseline cannot be rolled back without destroying data.
SELECT 1;
