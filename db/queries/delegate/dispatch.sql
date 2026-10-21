-- name: AcceptDispatch :one
SELECT delegate_supplier_accept(
    sqlc.arg(dispatch_id)::uuid,
    sqlc.arg(supplier_user_id)::bigint,
    sqlc.arg(fulfiller_id)::uuid
)::text AS state;

-- name: RejectDispatch :one
SELECT delegate_supplier_reject(
    sqlc.arg(dispatch_id)::uuid,
    sqlc.arg(supplier_user_id)::bigint,
    sqlc.arg(reason)::text,
    sqlc.arg(fulfiller_id)::uuid
)::text AS state;

-- name: ShipDispatch :one
SELECT delegate_supplier_ship(
    sqlc.arg(dispatch_id)::uuid,
    sqlc.arg(supplier_user_id)::bigint,
    sqlc.arg(tracking_no)::text,
    sqlc.arg(note)::text,
    sqlc.arg(now_ms)::bigint,
    sqlc.arg(fulfiller_id)::uuid
)::text AS state;

-- name: ListDispatchStates :many
SELECT dispatch_id::text AS dispatch_id, state
FROM delegate_dispatches
ORDER BY dispatch_id;
