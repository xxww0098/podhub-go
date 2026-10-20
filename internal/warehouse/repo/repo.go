// Package warehouserepo stores warehouse snapshots and write intents.
package warehouserepo

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/platform/writer"
	"github.com/xxww0098/podhub-go/internal/warehouse/contract"
	"github.com/xxww0098/podhub-go/internal/warehouse/gen"
)

// Repo runs tenant transactions. A nil pool fails closed.
type Repo struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) Repo { return Repo{pool: pool} }

// inTx runs fn in an app session for orgID. Errors from fn are returned
// as-is. A missing org, a failed open, a missing tenant GUC, and a failed
// commit all read as Unavailable.
func (r Repo) inTx(ctx context.Context, orgID int64, fn func(pgx.Tx) error) error {
	if r.pool == nil {
		return contract.Unavailable()
	}
	var fnErr error
	err := db.InTx(ctx, r.pool, db.App(orgID), func(tx pgx.Tx) error {
		if err := tenantx.RequireOrg(ctx, tx); err != nil {
			return err
		}
		fnErr = fn(tx)
		return fnErr
	})
	if err == nil || fnErr != nil {
		return err
	}
	return contract.Unavailable()
}

func (r Repo) findStore(ctx context.Context, tx pgx.Tx, orgID int64, storeID string) (int64, error) {
	var id int64
	err := tx.QueryRow(ctx, `
		SELECT id FROM public.organization_stores
		 WHERE org_id = $1 AND uuid = $2::uuid AND deleted_at_ms IS NULL`,
		orgID, storeID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, contract.NotFound()
	}
	if err != nil {
		return 0, mapDB(err)
	}
	return id, nil
}

func mapDB(err error) error {
	if err == nil {
		return nil
	}
	var fail *contract.Fail
	if errors.As(err, &fail) {
		return err
	}
	var pe *pgconn.PgError
	if errors.As(err, &pe) {
		switch pe.Code {
		case "23505":
			switch pe.ConstraintName {
			case "ozon_warehouse_intents_inflight":
				return contract.Busy()
			case "ozon_warehouse_intents_client_op":
				return contract.InFlight()
			}
		case "22P02":
			return contract.BadRequest("标识无效")
		case "40P01":
			return err
		}
	}
	return contract.Unavailable()
}

func lockFence(ctx context.Context, tx pgx.Tx, orgID int64, storeID string, warehouseID int64) error {
	var store pgtype.UUID
	if err := store.Scan(storeID); err != nil {
		return contract.BadRequest("storeId 无效")
	}
	_, err := sqlcgen.New(tx).LockFence(ctx, sqlcgen.LockFenceParams{
		OrgID: orgID, StoreID: store, WarehouseID: warehouseID,
	})
	return mapDB(err)
}

func (r Repo) audit(ctx context.Context, tx pgx.Tx, orgID, userID, shop int64, action, path, result, message, entity string) error {
	leaseID, fence := writer.AuditArgs(tx)
	var shopArg any
	if shop > 0 {
		shopArg = shop
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO audit_logs (
			org_id, user_id, module, entity_type, entity_id, api_method, api_path,
			action, status, result, message, shop_id, created_at_ms, created_at,
			actor_kind, support_grant_id, writer_lease_id, writer_fence_token
		) VALUES (
			$1, $2, 'warehouse', 'ozon_warehouse_intent', $3, 'POST', $4,
			$5, 'success', $6, $7, $8,
			(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint,
			clock_timestamp(), 'user', NULL, $9, $10
		)`, orgID, userID, entity, path, action, result, message, shopArg, leaseID, fence)
	return mapDB(err)
}

func stamp(ctx context.Context, tx pgx.Tx, orgID int64, storeID string, warehouses, methods *time.Time) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO public.ozon_warehouse_sync (org_id, store_id, warehouses_synced_at, methods_synced_at)
		VALUES ($1, $2::uuid, $3, $4)
		ON CONFLICT (org_id, store_id) DO UPDATE SET
			warehouses_synced_at = COALESCE(EXCLUDED.warehouses_synced_at, ozon_warehouse_sync.warehouses_synced_at),
			methods_synced_at = COALESCE(EXCLUDED.methods_synced_at, ozon_warehouse_sync.methods_synced_at)`,
		orgID, storeID, warehouses, methods)
	return mapDB(err)
}
