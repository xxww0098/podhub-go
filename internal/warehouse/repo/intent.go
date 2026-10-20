package warehouserepo

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/warehouse/contract"
	"github.com/xxww0098/podhub-go/internal/warehouse/domain"
)

const (
	msgGrant  = "已发放仓库写操作"
	msgRefuse = "Ozon 写入已停止"
	msgReport = "已记录仓库写操作报回"
)

type intentRow struct {
	ID        string
	State     string
	ClientOp  string
	Kind      string
	Fence     int64
	Warehouse *int64
	Granted   *time.Time
	StoreID   string
}

func (r Repo) PrepareGrant(ctx context.Context, in contract.GrantWrite) (contract.PreparedGrant, error) {
	id := uuid.NewString()
	err := r.inTx(ctx, in.OrgID, func(tx pgx.Tx) error {
		shop, err := r.findStore(ctx, tx, in.OrgID, in.StoreID)
		if err != nil {
			return err
		}
		fence := int64(0)
		var warehouseID int64
		if in.Kind != contract.KindCreate {
			if in.WarehouseID == nil || *in.WarehouseID <= 0 {
				return domain.CheckWrite(in.Kind, in.Confirm, 0, nil, false)
			}
			warehouseID = *in.WarehouseID
			fence = warehouseID
		}
		if err := lockFence(ctx, tx, in.OrgID, in.StoreID, fence); err != nil {
			return err
		}
		existing, ok, err := intentByClient(ctx, tx, in.OrgID, in.StoreID, in.ClientOperationID)
		if err != nil {
			return err
		}
		if ok {
			return replay(existing, in.Now)
		}
		held, ok, err := inflight(ctx, tx, in.OrgID, in.StoreID, fence)
		if err != nil {
			return err
		}
		if ok {
			if held.State == domain.StateGranted && held.Granted != nil && domain.Expired(*held.Granted, in.Now) {
				if err := rejectIntent(ctx, tx, held.ID, "grant_expired"); err != nil {
					return err
				}
			} else {
				return contract.Busy()
			}
		}
		if err := r.precheck(ctx, tx, in, warehouseID); err != nil {
			return err
		}
		var wh any
		if in.Kind != contract.KindCreate {
			wh = warehouseID
		}
		_, err = tx.Exec(ctx, `
		INSERT INTO public.ozon_warehouse_intents (
			id, org_id, store_id, user_id, client_operation_id, kind,
			warehouse_id, fence_warehouse_id, confirm, state, request_hash,
			credential_granted_at, created_at, updated_at
		) VALUES (
			$1::uuid, $2, $3::uuid, $4, $5, $6,
			$7, $8, $9, 'granted', $10,
			$11, $11, $11
		)`, id, in.OrgID, in.StoreID, in.UserID, in.ClientOperationID, in.Kind,
			wh, fence, in.Confirm, in.RequestHash, in.Now)
		if err != nil {
			return mapDB(err)
		}
		return r.audit(ctx, tx, in.OrgID, in.UserID, shop, "warehouse_grant", "/api/seller/warehouses/grant", "granted", msgGrant, id)
	})
	if err != nil {
		return contract.PreparedGrant{}, err
	}
	return contract.PreparedGrant{IntentID: id, State: domain.StateGranted}, nil
}

func (r Repo) precheck(ctx context.Context, tx pgx.Tx, in contract.GrantWrite, warehouseID int64) error {
	if in.Kind == contract.KindCreate {
		id := int64(0)
		if in.WarehouseID != nil {
			id = *in.WarehouseID
		}
		return domain.CheckWrite(in.Kind, in.Confirm, id, nil, false)
	}
	row, err := warehouseIn(ctx, tx, in.OrgID, in.StoreID, warehouseID)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.CheckWrite(in.Kind, in.Confirm, warehouseID, nil, false)
	}
	if err != nil {
		return mapDB(err)
	}
	return domain.CheckWrite(in.Kind, in.Confirm, warehouseID, &row, true)
}

func replay(row intentRow, now time.Time) error {
	switch row.State {
	case domain.StateGranted:
		if row.Granted != nil && domain.Expired(*row.Granted, now) {
			return contract.GrantExpired()
		}
		return contract.InFlight()
	case domain.StateUnknown:
		return contract.InFlight()
	default:
		return contract.IntentClosed()
	}
}

func (r Repo) AuditRefused(ctx context.Context, orgID, userID int64, storeID, kind string) error {
	if orgID <= 0 {
		return nil
	}
	return r.inTx(ctx, orgID, func(tx pgx.Tx) error {
		entity := storeID
		if entity == "" {
			entity = "refused"
		}
		if len(entity) > 128 {
			entity = entity[:128]
		}
		if kind == "" {
			kind = "write"
		}
		return r.audit(ctx, tx, orgID, userID, 0, "warehouse_grant_refused", "/api/seller/warehouses/grant", "refused", msgRefuse, entity)
	})
}

func (r Repo) ApplyReport(ctx context.Context, in contract.ReportWrite) (contract.ReportDone, error) {
	var next, code string
	err := r.inTx(ctx, in.OrgID, func(tx pgx.Tx) error {
		row, err := lockIntent(ctx, tx, in.OrgID, in.IntentID)
		if err != nil {
			return err
		}
		if row.State != domain.StateGranted {
			return contract.ReportState()
		}
		next, code = domain.ClassifyReport(in.HTTPStatus, in.OperationID)
		if !domain.Allows(row.State, next) {
			return contract.Unavailable()
		}
		var status any
		if in.HTTPStatus != nil && *in.HTTPStatus > 0 {
			status = *in.HTTPStatus
		}
		var op any
		if in.OperationID != "" {
			op = in.OperationID
		}
		var errCode any
		if code != "" {
			errCode = code
		}
		tag, err := tx.Exec(ctx, `
		UPDATE public.ozon_warehouse_intents
		   SET state = $3, ozon_operation_id = $4, http_status = $5, error_code = $6, updated_at = $7
		 WHERE id = $1::uuid AND org_id = $2 AND state = 'granted'`,
			in.IntentID, in.OrgID, next, op, status, errCode, in.Now)
		if err != nil {
			return mapDB(err)
		}
		if tag.RowsAffected() != 1 {
			return contract.ReportState()
		}
		if next == domain.StateAccepted && row.Warehouse != nil {
			switch row.Kind {
			case contract.KindArchive:
				if _, err := tx.Exec(ctx, `
				UPDATE public.ozon_warehouses
				   SET archived_at = $4
				 WHERE org_id = $1 AND store_id = $2::uuid AND warehouse_id = $3 AND archived_at IS NULL`,
					in.OrgID, row.StoreID, *row.Warehouse, in.Now); err != nil {
					return mapDB(err)
				}
			case contract.KindUnarchive:
				if _, err := tx.Exec(ctx, `
				UPDATE public.ozon_warehouses
				   SET archived_at = NULL
				 WHERE org_id = $1 AND store_id = $2::uuid AND warehouse_id = $3`,
					in.OrgID, row.StoreID, *row.Warehouse); err != nil {
					return mapDB(err)
				}
			}
		}
		shop, _ := r.findStore(ctx, tx, in.OrgID, row.StoreID)
		return r.audit(ctx, tx, in.OrgID, in.UserID, shop, "warehouse_report", "/api/seller/warehouses/report", next, msgReport, in.IntentID)
	})
	if err != nil {
		return contract.ReportDone{}, err
	}
	return contract.ReportDone{IntentID: in.IntentID, State: next, OperationID: in.OperationID, ErrorCode: code}, nil
}

func (r Repo) FindOperation(ctx context.Context, orgID int64, storeID, operationID string) (contract.Operation, error) {
	var out contract.Operation
	err := r.inTx(ctx, orgID, func(tx pgx.Tx) error {
		if _, err := r.findStore(ctx, tx, orgID, storeID); err != nil {
			return err
		}
		err := tx.QueryRow(ctx, `
		SELECT id::text, store_id::text, ozon_operation_id
		  FROM public.ozon_warehouse_intents
		 WHERE org_id = $1 AND store_id = $2::uuid AND ozon_operation_id = $3
		 ORDER BY updated_at DESC
		 LIMIT 1`, orgID, storeID, operationID).Scan(&out.IntentID, &out.StoreID, &out.OperationID)
		if errors.Is(err, pgx.ErrNoRows) {
			return contract.NotFound()
		}
		if err != nil {
			return mapDB(err)
		}
		return nil
	})
	if err != nil {
		return contract.Operation{}, err
	}
	return out, nil
}

func intentByClient(ctx context.Context, tx pgx.Tx, orgID int64, storeID, clientOp string) (intentRow, bool, error) {
	var row intentRow
	err := tx.QueryRow(ctx, `
		SELECT id::text, state, client_operation_id, credential_granted_at
		  FROM public.ozon_warehouse_intents
		 WHERE org_id = $1 AND store_id = $2::uuid AND client_operation_id = $3`,
		orgID, storeID, clientOp).Scan(&row.ID, &row.State, &row.ClientOp, &row.Granted)
	if errors.Is(err, pgx.ErrNoRows) {
		return intentRow{}, false, nil
	}
	if err != nil {
		return intentRow{}, false, mapDB(err)
	}
	return row, true, nil
}

func inflight(ctx context.Context, tx pgx.Tx, orgID int64, storeID string, fence int64) (intentRow, bool, error) {
	var row intentRow
	err := tx.QueryRow(ctx, `
		SELECT id::text, state, client_operation_id, credential_granted_at
		  FROM public.ozon_warehouse_intents
		 WHERE org_id = $1 AND store_id = $2::uuid AND fence_warehouse_id = $3
		   AND state IN ('granted', 'unknown')
		 LIMIT 1`, orgID, storeID, fence).Scan(&row.ID, &row.State, &row.ClientOp, &row.Granted)
	if errors.Is(err, pgx.ErrNoRows) {
		return intentRow{}, false, nil
	}
	if err != nil {
		return intentRow{}, false, mapDB(err)
	}
	return row, true, nil
}

func rejectIntent(ctx context.Context, tx pgx.Tx, id, code string) error {
	_, err := tx.Exec(ctx, `
		UPDATE public.ozon_warehouse_intents
		   SET state = 'rejected', error_code = $2, revoked_at = clock_timestamp(), updated_at = clock_timestamp()
		 WHERE id = $1::uuid AND state = 'granted'`, id, code)
	return mapDB(err)
}

func lockIntent(ctx context.Context, tx pgx.Tx, orgID int64, id string) (intentRow, error) {
	var row intentRow
	err := tx.QueryRow(ctx, `
		SELECT id::text, state, kind, warehouse_id, store_id::text
		  FROM public.ozon_warehouse_intents
		 WHERE id = $1::uuid AND org_id = $2
		 FOR UPDATE`, id, orgID).Scan(&row.ID, &row.State, &row.Kind, &row.Warehouse, &row.StoreID)
	if errors.Is(err, pgx.ErrNoRows) {
		return intentRow{}, contract.NotFound()
	}
	if err != nil {
		return intentRow{}, mapDB(err)
	}
	return row, nil
}
