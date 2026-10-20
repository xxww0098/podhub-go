-- name: LockFence :one
INSERT INTO ozon_warehouse_fences (org_id, store_id, warehouse_id)
VALUES (sqlc.arg(org_id), sqlc.arg(store_id)::uuid, sqlc.arg(warehouse_id))
ON CONFLICT (org_id, store_id, warehouse_id)
DO UPDATE SET warehouse_id = ozon_warehouse_fences.warehouse_id
RETURNING org_id, store_id, warehouse_id;
