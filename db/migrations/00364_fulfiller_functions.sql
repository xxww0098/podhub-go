-- +goose Up
-- 00364 fulfiller functions: the three packet actions become person-gated.
--
-- These functions are SECURITY DEFINER, so they run as the owner and RLS does
-- not apply to them. The policy in 00363 is therefore irrelevant here: if the
-- gate inside the function is wrong, a supplier can act on someone else's
-- packet no matter what the policy says. The gate has to be re-derived here,
-- against the same grain the policy uses.
--
-- 00259 established the shape that must be kept: read the row, check identity,
-- lock the order, re-read the packet FOR UPDATE, check identity again.
-- The re-check is not redundant. Between the first read and the lock, a rebind
-- can move the packet to another fulfiller; without the second check the
-- function would act on a packet that is no longer the caller's.
-- +goose StatementBegin

-- ---------------------------------------------------------------------
-- Drop the old signatures FIRST.
--
-- CREATE OR REPLACE with a new parameter list is not a replace: it is a
-- different function, so the old 2- and 5-argument versions would survive as
-- overloads and remain callable. A stale caller would then hit the old
-- source-wide gate and keep working, which is exactly the bypass this
-- migration must close. Dropping them is what makes the new gate real.
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.delegate_supplier_accept(uuid, bigint);
DROP FUNCTION IF EXISTS public.delegate_supplier_reject(uuid, bigint, text);
DROP FUNCTION IF EXISTS public.delegate_supplier_ship(uuid, bigint, text, text, bigint);

-- ---------------------------------------------------------------------
-- accept
-- ---------------------------------------------------------------------
CREATE FUNCTION public.delegate_supplier_accept(
    p_dispatch_id uuid,
    p_supplier_user_id bigint,
    p_fulfiller_id uuid
)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
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

-- ---------------------------------------------------------------------
-- reject
-- ---------------------------------------------------------------------
CREATE FUNCTION public.delegate_supplier_reject(
    p_dispatch_id uuid,
    p_supplier_user_id bigint,
    p_reason text,
    p_fulfiller_id uuid
)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
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

-- ---------------------------------------------------------------------
-- ship
-- ---------------------------------------------------------------------
CREATE FUNCTION public.delegate_supplier_ship(
    p_dispatch_id uuid,
    p_supplier_user_id bigint,
    p_tracking_no text,
    p_note text,
    p_now_ms bigint,
    p_fulfiller_id uuid
)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
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

-- ---------------------------------------------------------------------
-- Per-function ACL. 00191 grants EXECUTE on new functions to PUBLIC, so a
-- REVOKE is mandatory for each one; without it every role in the database
-- can call these, including podhub_worker and the catalog writer role.
-- ---------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.delegate_supplier_accept(uuid, bigint, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.delegate_supplier_reject(uuid, bigint, text, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.delegate_supplier_ship(uuid, bigint, text, text, bigint, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.delegate_supplier_accept(uuid, bigint, uuid)
    TO podhub_app, podhub_worker;
GRANT EXECUTE ON FUNCTION public.delegate_supplier_reject(uuid, bigint, text, uuid)
    TO podhub_app, podhub_worker;
GRANT EXECUTE ON FUNCTION public.delegate_supplier_ship(uuid, bigint, text, text, bigint, uuid)
    TO podhub_app, podhub_worker;

-- ---------------------------------------------------------------------
-- delegate_source_active_fulfiller_count
--
-- Replaces the member count the seller-side 'nobody can take this' warning
-- used. SECURITY DEFINER because sc_source_fulfillers has RLS: the seller
-- reading this number has no grant on that table, and the function must
-- return a count without exposing the rows. It leaks a number, no identity.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.delegate_source_active_fulfiller_count(p_source_id text)
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT count(*)::bigint FROM public.sc_source_fulfillers
    WHERE source_id = p_source_id AND status = 'active';
$$;

REVOKE EXECUTE ON FUNCTION public.delegate_source_active_fulfiller_count(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delegate_source_active_fulfiller_count(text)
    TO podhub_app, podhub_worker;

-- ---------------------------------------------------------------------
-- The dispatcher also needs the recipient id, from a seller session.
--
-- sc_source_fulfillers is ENABLE + FORCE ROW LEVEL SECURITY (00361), and a
-- seller transaction (db.App) sets neither app.staff_access nor
-- app.current_supplier_user_id, so a bare subquery in dispatchReady or in
-- admin.go's writePackets returns zero rows and every order would be
-- written dispatch_blocked_reason = 'no_fulfiller'. FORCE means the table
-- owner is filtered too, so there is no SQL-level workaround: the read has
-- to happen inside a definer function, exactly like the count above.
--
-- It returns the oldest active fulfiller, the same ORDER BY the Go code
-- used inline. With ux_sc_source_fulfillers_one_active (00361:36-37) there
-- is at most one active row, so the ordering only makes the result
-- deterministic for the ambiguous case the plan keeps as a guard (O11).
-- Returns NULL when the source has no active fulfiller.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.delegate_source_active_fulfiller_id(p_source_id text)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT f.fulfiller_id FROM public.sc_source_fulfillers f
    WHERE f.source_id = p_source_id AND f.status = 'active'
    ORDER BY f.created_at_ms, f.fulfiller_id
    LIMIT 1;
$$;

REVOKE EXECUTE ON FUNCTION public.delegate_source_active_fulfiller_id(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delegate_source_active_fulfiller_id(text)
    TO podhub_app, podhub_worker;

-- The old count function is retired in 00363 (its PUBLIC grant is revoked).
-- Nothing should still call it; this is the loud failure if something does.

-- ---------------------------------------------------------------------
-- F2 (00363) dropped supplier_source_isolation from the three supplier
-- money tables, which is the point: a supplier session must not read or
-- write them. But Ship still credits the factory wallet, and Ship runs in
-- a supplier session (supplier/repo/write.go:65 -> act -> settleDispatch
-- -> creditDispatch -> moveCash). With the source arm gone, FORCE RLS
-- leaves only the staff arm, so every Ship raised 42501 / "厂家钱包不可写"
-- and rolled the whole transaction back: the packet stayed 'accepted'
-- forever and the factory was never paid.
--
-- The money still has to move (plan 9.3) and it has to move in the same
-- transaction as the ship. A definer function is how this codebase does
-- privileged work inside a caller's transaction. It takes only the
-- dispatch id -- source and amount come from the settlement row, so a
-- caller cannot invent an amount -- and it re-checks the caller against
-- the packet's pinned fulfiller, so it is not a standalone money faucet.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.delegate_credit_fulfiller_wallet(p_dispatch_id uuid, p_now_ms bigint)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
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

REVOKE EXECUTE ON FUNCTION public.delegate_credit_fulfiller_wallet(uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delegate_credit_fulfiller_wallet(uuid, bigint)
    TO podhub_app, podhub_worker;

-- +goose StatementEnd

-- +goose Down
-- Rust down() refuses a destructive rollback.
-- +goose StatementBegin
SELECT 1;
-- +goose StatementEnd
