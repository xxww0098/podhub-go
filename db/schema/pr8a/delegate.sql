-- sqlc schema only. Runtime objects come from goose migrations.
CREATE TABLE delegate_dispatches (
    dispatch_id uuid PRIMARY KEY,
    state text NOT NULL
);

CREATE FUNCTION delegate_supplier_accept(dispatch_id uuid, supplier_user_id bigint)
RETURNS text LANGUAGE sql AS $$ SELECT ''::text $$;

CREATE FUNCTION delegate_supplier_reject(dispatch_id uuid, supplier_user_id bigint, reason text)
RETURNS text LANGUAGE sql AS $$ SELECT ''::text $$;

CREATE FUNCTION delegate_supplier_ship(
    dispatch_id uuid,
    supplier_user_id bigint,
    tracking_no text,
    note text,
    now_ms bigint
) RETURNS text LANGUAGE sql AS $$ SELECT ''::text $$;
