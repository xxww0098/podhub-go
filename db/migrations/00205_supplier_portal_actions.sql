-- +goose Up
-- declaration 205 SupplierPortalActions m20260922_120000_supplier_portal_actions
-- source: migration/src/supplier_portal_actions.rs @ a03d735
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION public.delegate_supplier_recompute_order_state(
    p_order_id uuid,
    p_now_ms bigint
)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
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

REVOKE EXECUTE ON FUNCTION
    public.delegate_supplier_recompute_order_state(uuid, bigint)
FROM PUBLIC;

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
BEGIN
    SELECT d.source_id, d.state, d.order_id
    INTO v_source, v_state, v_order
    FROM public.delegate_dispatches d
    WHERE d.dispatch_id = p_dispatch_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'DELEGATE_NOT_FOUND';
    END IF;
    -- 成员身份自校验：停用（disabled）即刻失效，不信任调用方。
    IF NOT EXISTS (
        SELECT 1 FROM public.sc_source_members m
        WHERE m.source_id = v_source
          AND m.user_id = p_supplier_user_id
          AND m.status = 'active'
    ) THEN
        RAISE EXCEPTION 'DELEGATE_FORBIDDEN';
    END IF;
    IF v_state = 'accepted' THEN
        -- 幂等回放：重复 accept 返回现态（spec §D.18）。
        RETURN 'accepted';
    END IF;
    IF v_state <> 'dispatched' THEN
        RAISE EXCEPTION 'DELEGATE_TERMINAL';
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.delegate_orders o
        WHERE o.order_id = v_order AND o.state IN ('cancelled', 'done')
    ) THEN
        RAISE EXCEPTION 'DELEGATE_TERMINAL';
    END IF;
    UPDATE public.delegate_dispatches
    SET state = 'accepted',
        updated_at_ms = (extract(epoch from clock_timestamp()) * 1000)::bigint
    WHERE dispatch_id = p_dispatch_id;
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
BEGIN
    SELECT d.source_id, d.state, d.order_id
    INTO v_source, v_state, v_order
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
    IF v_state <> 'dispatched' THEN
        RAISE EXCEPTION 'DELEGATE_TERMINAL';
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.delegate_orders o
        WHERE o.order_id = v_order AND o.state IN ('cancelled', 'done')
    ) THEN
        RAISE EXCEPTION 'DELEGATE_TERMINAL';
    END IF;
    UPDATE public.delegate_dispatches
    SET state = 'rejected',
        receipt = jsonb_build_object('reason', COALESCE(p_reason, ''), 'at_ms',
            (extract(epoch from clock_timestamp()) * 1000)::bigint),
        updated_at_ms = (extract(epoch from clock_timestamp()) * 1000)::bigint
    WHERE dispatch_id = p_dispatch_id;
    -- 拒单 latch（spec §D.16）：只 latch 本包 payload 冻结的行。
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
BEGIN
    SELECT d.source_id, d.state, d.order_id
    INTO v_source, v_state, v_order
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
    IF v_state <> 'accepted' THEN
        RAISE EXCEPTION 'DELEGATE_TERMINAL';
    END IF;
    -- 单已 cancelled/done（含 ship 撞 cancel）：取消胜，终态不复活。
    IF EXISTS (
        SELECT 1 FROM public.delegate_orders o
        WHERE o.order_id = v_order AND o.state IN ('cancelled', 'done')
    ) THEN
        RAISE EXCEPTION 'DELEGATE_TERMINAL';
    END IF;
    UPDATE public.delegate_dispatches
    SET state = 'shipped',
        receipt = jsonb_build_object(
            'tracking_no', COALESCE(p_tracking_no, ''),
            'note', COALESCE(p_note, ''),
            'at_ms', p_now_ms),
        updated_at_ms = p_now_ms
    WHERE dispatch_id = p_dispatch_id;
    PERFORM public.delegate_supplier_recompute_order_state(v_order, p_now_ms);
    RETURN 'shipped';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.delegate_supplier_accept(uuid, bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.delegate_supplier_reject(uuid, bigint, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION
    public.delegate_supplier_ship(uuid, bigint, text, text, bigint)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.delegate_supplier_accept(uuid, bigint)
TO podhub_app, podhub_worker;
GRANT EXECUTE ON FUNCTION public.delegate_supplier_reject(uuid, bigint, text)
TO podhub_app, podhub_worker;
GRANT EXECUTE ON FUNCTION
    public.delegate_supplier_ship(uuid, bigint, text, text, bigint)
TO podhub_app, podhub_worker;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
