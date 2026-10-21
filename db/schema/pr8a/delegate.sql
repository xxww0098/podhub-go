-- sqlc schema only. Runtime objects come from goose migrations.
CREATE TABLE delegate_dispatches (
    dispatch_id uuid PRIMARY KEY,
    state text NOT NULL
);

-- Signatures must match db/migrations/00364_fulfiller_functions.sql. The three
-- packet actions are fulfiller-gated: p_fulfiller_id is the packet's pinned
-- recipient, and the body rejects a caller who is not that person.
CREATE FUNCTION delegate_supplier_accept(
    p_dispatch_id uuid,
    p_supplier_user_id bigint,
    p_fulfiller_id uuid
) RETURNS text LANGUAGE sql AS $$ SELECT ''::text $$;

CREATE FUNCTION delegate_supplier_reject(
    p_dispatch_id uuid,
    p_supplier_user_id bigint,
    p_reason text,
    p_fulfiller_id uuid
) RETURNS text LANGUAGE sql AS $$ SELECT ''::text $$;

CREATE FUNCTION delegate_supplier_ship(
    p_dispatch_id uuid,
    p_supplier_user_id bigint,
    p_tracking_no text,
    p_note text,
    p_now_ms bigint,
    p_fulfiller_id uuid
) RETURNS text LANGUAGE sql AS $$ SELECT ''::text $$;
