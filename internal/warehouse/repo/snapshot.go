package warehouserepo

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/warehouse/contract"
)

func (r Repo) SaveSnapshot(ctx context.Context, orgID int64, storeID string, snap contract.Snapshot) error {
	return r.inTx(ctx, orgID, func(tx pgx.Tx) error {
		if _, err := r.findStore(ctx, tx, orgID, storeID); err != nil {
			return err
		}
		if snap.WriteWarehouses {
			if err := replaceWarehouses(ctx, tx, orgID, storeID, snap.Warehouses, snap.At); err != nil {
				return err
			}
		}
		if snap.WriteMethods {
			if err := replaceMethods(ctx, tx, orgID, storeID, snap.Methods, snap.At); err != nil {
				return err
			}
		}
		var wh, methods *time.Time
		if snap.WriteWarehouses {
			at := snap.At
			wh = &at
		}
		if snap.WriteMethods {
			at := snap.At
			methods = &at
		}
		return stamp(ctx, tx, orgID, storeID, wh, methods)
	})
}

func replaceWarehouses(ctx context.Context, tx pgx.Tx, orgID int64, storeID string, rows []contract.Warehouse, at time.Time) error {
	ids := make([]int64, 0, len(rows))
	for _, row := range rows {
		if row.WarehouseID <= 0 || row.Name == "" {
			continue
		}
		ids = append(ids, row.WarehouseID)
		_, err := tx.Exec(ctx, `
			INSERT INTO public.ozon_warehouses (
				org_id, store_id, warehouse_id, name, ozon_status, is_rfbs, synced_at
			) VALUES ($1, $2::uuid, $3, $4, $5, $6, $7)
			ON CONFLICT (org_id, store_id, warehouse_id) DO UPDATE SET
				name = EXCLUDED.name,
				ozon_status = EXCLUDED.ozon_status,
				is_rfbs = EXCLUDED.is_rfbs,
				synced_at = EXCLUDED.synced_at`,
			orgID, storeID, row.WarehouseID, row.Name, row.Status, row.IsRFBS, at)
		if err != nil {
			return mapDB(err)
		}
	}
	var err error
	if len(ids) == 0 {
		_, err = tx.Exec(ctx, `DELETE FROM public.ozon_warehouses WHERE org_id = $1 AND store_id = $2::uuid`, orgID, storeID)
	} else {
		_, err = tx.Exec(ctx, `
			DELETE FROM public.ozon_warehouses
			 WHERE org_id = $1 AND store_id = $2::uuid AND NOT (warehouse_id = ANY($3::bigint[]))`,
			orgID, storeID, ids)
	}
	return mapDB(err)
}

func replaceMethods(ctx context.Context, tx pgx.Tx, orgID int64, storeID string, rows []contract.Method, at time.Time) error {
	if _, err := tx.Exec(ctx, `DELETE FROM public.ozon_delivery_methods WHERE org_id = $1 AND store_id = $2::uuid`, orgID, storeID); err != nil {
		return mapDB(err)
	}
	for _, row := range rows {
		if row.MethodID <= 0 || row.WarehouseID <= 0 || row.Name == "" {
			continue
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO public.ozon_delivery_methods (
				org_id, store_id, method_id, warehouse_id, name, provider_id, template_id,
				cutoff, sla_cut_in, status, created_at, updated_at, synced_at
			) VALUES (
				$1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
			)`, orgID, storeID, row.MethodID, row.WarehouseID, row.Name, row.ProviderID, row.TemplateID,
			row.Cutoff, row.SLACutIn, row.Status, row.CreatedAt, row.UpdatedAt, at)
		if err != nil {
			return mapDB(err)
		}
	}
	return nil
}

func (r Repo) ListWarehouses(ctx context.Context, orgID int64, storeID string) ([]contract.Warehouse, contract.SyncStamp, error) {
	var rows []contract.Warehouse
	var stamp contract.SyncStamp
	err := r.inTx(ctx, orgID, func(tx pgx.Tx) error {
		if _, err := r.findStore(ctx, tx, orgID, storeID); err != nil {
			return err
		}
		var err error
		if rows, err = queryWarehouses(ctx, tx, orgID, storeID, 0); err != nil {
			return err
		}
		stamp, err = queryStamp(ctx, tx, orgID, storeID)
		return err
	})
	if err != nil {
		return nil, contract.SyncStamp{}, err
	}
	return rows, stamp, nil
}

func (r Repo) GetWarehouse(ctx context.Context, orgID int64, storeID string, warehouseID int64) (contract.Warehouse, error) {
	var row contract.Warehouse
	err := r.inTx(ctx, orgID, func(tx pgx.Tx) error {
		if _, err := r.findStore(ctx, tx, orgID, storeID); err != nil {
			return err
		}
		var err error
		row, err = warehouseIn(ctx, tx, orgID, storeID, warehouseID)
		if errors.Is(err, pgx.ErrNoRows) {
			return contract.NotFound()
		}
		if err != nil {
			return mapDB(err)
		}
		return nil
	})
	if err != nil {
		return contract.Warehouse{}, err
	}
	return row, nil
}

func (r Repo) ListRFBS(ctx context.Context, orgID int64, storeID string) ([]contract.Warehouse, error) {
	var rows []contract.Warehouse
	err := r.inTx(ctx, orgID, func(tx pgx.Tx) error {
		if _, err := r.findStore(ctx, tx, orgID, storeID); err != nil {
			return err
		}
		var err error
		rows, err = queryWarehouses(ctx, tx, orgID, storeID, 0)
		return err
	})
	if err != nil {
		return nil, err
	}
	var out []contract.Warehouse
	for _, row := range rows {
		if row.IsRFBS {
			out = append(out, row)
		}
	}
	return out, nil
}

func (r Repo) ListMethods(ctx context.Context, orgID int64, storeID string, warehouseID int64) ([]contract.Method, error) {
	var out []contract.Method
	err := r.inTx(ctx, orgID, func(tx pgx.Tx) error {
		if _, err := r.findStore(ctx, tx, orgID, storeID); err != nil {
			return err
		}
		var err error
		out, err = queryMethods(ctx, tx, orgID, storeID, warehouseID, 0)
		return err
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

func (r Repo) GetMethod(ctx context.Context, orgID int64, storeID string, methodID int64) (contract.Method, error) {
	var rows []contract.Method
	err := r.inTx(ctx, orgID, func(tx pgx.Tx) error {
		if _, err := r.findStore(ctx, tx, orgID, storeID); err != nil {
			return err
		}
		var err error
		rows, err = queryMethods(ctx, tx, orgID, storeID, 0, methodID)
		return err
	})
	if err != nil {
		return contract.Method{}, err
	}
	if len(rows) == 0 {
		return contract.Method{}, contract.NotFound()
	}
	return rows[0], nil
}

func queryWarehouses(ctx context.Context, tx pgx.Tx, orgID int64, storeID string, only int64) ([]contract.Warehouse, error) {
	q := `
		SELECT warehouse_id, name, ozon_status, is_rfbs, archived_at IS NOT NULL, synced_at
		  FROM public.ozon_warehouses
		 WHERE org_id = $1 AND store_id = $2::uuid`
	args := []any{orgID, storeID}
	if only > 0 {
		q += ` AND warehouse_id = $3`
		args = append(args, only)
	}
	q += ` ORDER BY warehouse_id`
	rows, err := tx.Query(ctx, q, args...)
	if err != nil {
		return nil, mapDB(err)
	}
	defer rows.Close()
	var out []contract.Warehouse
	for rows.Next() {
		var row contract.Warehouse
		if err := rows.Scan(&row.WarehouseID, &row.Name, &row.Status, &row.IsRFBS, &row.Archived, &row.SyncedAt); err != nil {
			return nil, mapDB(err)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, mapDB(err)
	}
	if out == nil {
		out = []contract.Warehouse{}
	}
	return out, nil
}

func warehouseIn(ctx context.Context, tx pgx.Tx, orgID int64, storeID string, warehouseID int64) (contract.Warehouse, error) {
	var row contract.Warehouse
	err := tx.QueryRow(ctx, `
		SELECT warehouse_id, name, ozon_status, is_rfbs, archived_at IS NOT NULL, synced_at
		  FROM public.ozon_warehouses
		 WHERE org_id = $1 AND store_id = $2::uuid AND warehouse_id = $3`,
		orgID, storeID, warehouseID).Scan(&row.WarehouseID, &row.Name, &row.Status, &row.IsRFBS, &row.Archived, &row.SyncedAt)
	return row, err
}

func queryMethods(ctx context.Context, tx pgx.Tx, orgID int64, storeID string, warehouseID, methodID int64) ([]contract.Method, error) {
	q := `
		SELECT method_id, warehouse_id, name, provider_id, template_id, cutoff, sla_cut_in,
		       status, created_at, updated_at, synced_at
		  FROM public.ozon_delivery_methods
		 WHERE org_id = $1 AND store_id = $2::uuid`
	args := []any{orgID, storeID}
	if warehouseID > 0 {
		args = append(args, warehouseID)
		q += ` AND warehouse_id = $` + itoa(len(args))
	}
	if methodID > 0 {
		args = append(args, methodID)
		q += ` AND method_id = $` + itoa(len(args))
	}
	q += ` ORDER BY method_id`
	rows, err := tx.Query(ctx, q, args...)
	if err != nil {
		return nil, mapDB(err)
	}
	defer rows.Close()
	var out []contract.Method
	for rows.Next() {
		var row contract.Method
		if err := rows.Scan(&row.MethodID, &row.WarehouseID, &row.Name, &row.ProviderID, &row.TemplateID,
			&row.Cutoff, &row.SLACutIn, &row.Status, &row.CreatedAt, &row.UpdatedAt, &row.SyncedAt); err != nil {
			return nil, mapDB(err)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, mapDB(err)
	}
	if out == nil {
		out = []contract.Method{}
	}
	return out, nil
}

func queryStamp(ctx context.Context, tx pgx.Tx, orgID int64, storeID string) (contract.SyncStamp, error) {
	var stamp contract.SyncStamp
	var wh, methods *time.Time
	err := tx.QueryRow(ctx, `
		SELECT warehouses_synced_at, methods_synced_at
		  FROM public.ozon_warehouse_sync
		 WHERE org_id = $1 AND store_id = $2::uuid`, orgID, storeID).Scan(&wh, &methods)
	if errors.Is(err, pgx.ErrNoRows) {
		return contract.SyncStamp{}, nil
	}
	if err != nil {
		return contract.SyncStamp{}, mapDB(err)
	}
	if wh != nil {
		stamp.Warehouses = *wh
		stamp.HasWh = true
	}
	if methods != nil {
		stamp.Methods = *methods
		stamp.HasMethods = true
	}
	return stamp, nil
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [4]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}
