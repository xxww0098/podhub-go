-- +goose Up
-- declaration 259 DelegateActionLocks m20260930_000442_delegate_action_locks
-- source: migration/src/delegate_action_locks.rs @ a03d735
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION public.delegate_supplier_accept(
    p_dispatch_id uuid,
    p_supplier_user_id bigint
)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_source text;
    v_state text;
    v_order uuid;
    v_order_state text;
BEGIN
    SELECT d.order_id, d.source_id
    INTO v_order, v_source
    FROM public.delegate_dispatches d
    WHERE d.dispatch_id = p_dispatch_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'DELEGATE_NOT_FOUND';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.sc_source_members m
        WHERE m.source_id = v_source
          AND m.user_id = p_supplier_user_id
          AND m.status = 'active'
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
    SELECT d.source_id, d.state INTO v_source, v_state
    FROM public.delegate_dispatches d
    WHERE d.dispatch_id = p_dispatch_id
    FOR UPDATE;
    IF NOT EXISTS (
        SELECT 1 FROM public.sc_source_members m
        WHERE m.source_id = v_source
          AND m.user_id = p_supplier_user_id
          AND m.status = 'active'
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

CREATE OR REPLACE FUNCTION public.delegate_supplier_reject(
    p_dispatch_id uuid,
    p_supplier_user_id bigint,
    p_reason text
)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_source text;
    v_state text;
    v_order uuid;
    v_order_state text;
BEGIN
    SELECT d.order_id, d.source_id
    INTO v_order, v_source
    FROM public.delegate_dispatches d
    WHERE d.dispatch_id = p_dispatch_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'DELEGATE_NOT_FOUND';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.sc_source_members m
        WHERE m.source_id = v_source
          AND m.user_id = p_supplier_user_id
          AND m.status = 'active'
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
    SELECT d.source_id, d.state INTO v_source, v_state
    FROM public.delegate_dispatches d
    WHERE d.dispatch_id = p_dispatch_id
    FOR UPDATE;
    IF NOT EXISTS (
        SELECT 1 FROM public.sc_source_members m
        WHERE m.source_id = v_source
          AND m.user_id = p_supplier_user_id
          AND m.status = 'active'
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
    UPDATE public.delegate_order_lines l
    SET last_rejected_source_id = v_source
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

CREATE OR REPLACE FUNCTION public.delegate_supplier_ship(
    p_dispatch_id uuid,
    p_supplier_user_id bigint,
    p_tracking_no text,
    p_note text,
    p_now_ms bigint
)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_source text;
    v_state text;
    v_order uuid;
    v_order_state text;
BEGIN
    SELECT d.order_id, d.source_id
    INTO v_order, v_source
    FROM public.delegate_dispatches d
    WHERE d.dispatch_id = p_dispatch_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'DELEGATE_NOT_FOUND';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.sc_source_members m
        WHERE m.source_id = v_source
          AND m.user_id = p_supplier_user_id
          AND m.status = 'active'
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
    SELECT d.source_id, d.state INTO v_source, v_state
    FROM public.delegate_dispatches d
    WHERE d.dispatch_id = p_dispatch_id
    FOR UPDATE;
    IF NOT EXISTS (
        SELECT 1 FROM public.sc_source_members m
        WHERE m.source_id = v_source
          AND m.user_id = p_supplier_user_id
          AND m.status = 'active'
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
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
