package repo

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/platform/seal"
	"github.com/xxww0098/podhub-go/internal/shipping/contract"
	"github.com/xxww0098/podhub-go/internal/shipping/domain"
)

// Repo is the injection SQL. Ozon is supplied per call so tests can script it.
type Repo struct {
	Pool     *pgxpool.Pool
	Ring     seal.Ring
	KeyReady bool
}

// Reconcile lists warehouses and records absence or the matched id.
// Neither switch is consulted. A list failure does not prove absence.
func (r Repo) Reconcile(ctx context.Context, storeUUID, presetID string, now int64, ozon domain.Ozon) (json.RawMessage, error) {
	row, payload, err := r.load(ctx, storeUUID, presetID)
	if err != nil {
		return nil, err
	}
	secret, err := r.openCred(ctx, row.OrgID, row.Store, now)
	if err != nil {
		return nil, err
	}
	if ozon == nil {
		return nil, contract.Gateway("")
	}
	preset, err := domain.DecodePreset(payload)
	if err != nil {
		return nil, contract.Validation("物流预设无法映射为 rFBS Express 请求")
	}
	names, listErr := listWarehouses(ctx, ozon, secret)
	if listErr != nil {
		if err := r.persist(ctx, row, "unknown", max(row.Mutate, 1), nil, nil, false, now, "reconcile"); err != nil {
			return nil, err
		}
		return r.diagnostic(ctx, storeUUID, presetID, now)
	}
	found := matchWarehouse(names, preset.WarehouseName)
	if found == nil {
		if err := r.persist(ctx, row, "unknown", max(row.Mutate, 1), nil, nil, true, now, "reconcile"); err != nil {
			return nil, err
		}
		return r.diagnostic(ctx, storeUUID, presetID, now)
	}
	return r.verify(ctx, row, preset, secret, ozon, &found.WarehouseID, row.DeliveryID, max(row.Mutate, 1), "waiting", now, "")
}

// SafeContinue creates a warehouse only after a fresh absence proof.
// The kill switch is checked after the credential opens and before claim.
func (r Repo) SafeContinue(ctx context.Context, storeUUID, presetID, actor string, now int64, ozon domain.Ozon) (json.RawMessage, error) {
	row, payload, err := r.load(ctx, storeUUID, presetID)
	if err != nil {
		return nil, err
	}
	secret, err := r.openCred(ctx, row.OrgID, row.Store, now)
	if err != nil {
		return nil, err
	}
	if err := writeBlocked(ozon); err != nil {
		return nil, err
	}
	if ozon == nil {
		return nil, contract.Gateway("")
	}
	preset, err := domain.DecodePreset(payload)
	if err != nil {
		return nil, contract.Validation("物流预设无法映射为 rFBS Express 请求")
	}
	if preset.Mode == "non_integrated" {
		return nil, contract.Validation("非聚合模式不支持一键注入")
	}
	key := domain.SafeContinueKey(strings.ToLower(storeUUID), presetID, row.Version, now)
	opID := "sho_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if err := r.claim(ctx, row, actor, key, opID, now); err != nil {
		return nil, err
	}
	body, err := domain.MapAggregatorCreate(preset)
	if err != nil {
		return nil, contract.Validation("物流预设无法映射为 rFBS Express 请求")
	}
	status, resp, callErr := post(ctx, ozon, secret, "/v1/warehouse/erfbs/aggregator/create", body, true)
	if stopped := killSwitch(callErr); stopped != nil {
		return nil, stopped
	}
	outcome, ozonOp := classify(status, resp, callErr)
	switch outcome {
	case domain.Accepted:
		if err := r.finish(ctx, row, "waiting", 1, ozonOp, opID, "create_warehouse", now); err != nil {
			return nil, err
		}
		if err := r.poll(ctx, row, preset, secret, ozon, ozonOp, opID, now); err != nil {
			return nil, err
		}
	case domain.LostAfterSend:
		if err := r.finish(ctx, row, "unknown", 1, "", opID, "create_warehouse", now); err != nil {
			return nil, err
		}
		return r.Reconcile(ctx, storeUUID, presetID, now, ozon)
	default:
		if err := r.finish(ctx, row, "failed", 0, "", opID, "create_warehouse", now); err != nil {
			return nil, err
		}
	}
	return r.diagnostic(ctx, storeUUID, presetID, now)
}

func classify(status int, body []byte, err error) (domain.Outcome, string) {
	k := domain.MutateKind{Status: status}
	if err != nil {
		var ce *domain.CallError
		if errors.As(err, &ce) {
			k.Connect = ce.Connect
			k.Transport = ce.Transport || ce.Connect
			k.Decode = ce.Decode
		} else if ne, ok := err.(net.Error); ok && ne.Timeout() {
			k.Transport = true
		} else {
			k.Transport = true
			k.Connect = true
		}
	} else if status >= 200 && status < 300 {
		var parsed struct {
			OperationID string `json:"operation_id"`
		}
		if json.Unmarshal(body, &parsed) != nil {
			k.Decode = true
			k.Status = 0
		} else {
			k.OperationID = parsed.OperationID
		}
	}
	out, id := domain.ClassifyMutate(k)
	return out, id
}

type row struct {
	OrgID        int64
	Store        string
	Preset       string
	Version      int64
	Status       string
	WarehouseID  *int64
	DeliveryID   *int64
	Mutate       int32
	OzonOp       *string
	RemoteAbsent *int64
}

func (r Repo) load(ctx context.Context, storeUUID, presetID string) (row, []byte, error) {
	if r.Pool == nil {
		return row{}, nil, contract.Internal("")
	}
	var out row
	var payload []byte
	err := r.Pool.QueryRow(ctx, `
		SELECT i.org_id, lower(i.store_uuid::text), i.preset_id, p.current_version, i.status,
		       i.warehouse_id, i.delivery_method_id, i.warehouse_mutate_count,
		       i.last_ozon_operation_id, i.remote_absent_at_ms, v.payload
		FROM shipping_shop_injections i
		JOIN shipping_presets p ON p.preset_id = i.preset_id
		JOIN shipping_preset_versions v ON v.preset_id = p.preset_id AND v.version = p.current_version
		WHERE i.store_uuid = $1::uuid AND i.preset_id = $2`, storeUUID, presetID).Scan(
		&out.OrgID, &out.Store, &out.Preset, &out.Version, &out.Status,
		&out.WarehouseID, &out.DeliveryID, &out.Mutate, &out.OzonOp, &out.RemoteAbsent, &payload)
	if errors.Is(err, pgx.ErrNoRows) {
		return row{}, nil, contract.NotFound("记录不存在")
	}
	if err != nil {
		return row{}, nil, mapDB(err)
	}
	return out, payload, nil
}

func (r Repo) claim(ctx context.Context, row row, actor, key, opID string, now int64) error {
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return mapDB(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(842003, hashtext($1 || ':' || $2))`, row.Store, row.Preset); err != nil {
		return mapDB(err)
	}
	var status string
	var absent, warehouse *int64
	var lockedMutate int32
	err = tx.QueryRow(ctx, `
		SELECT status, remote_absent_at_ms, warehouse_id, warehouse_mutate_count
		FROM shipping_shop_injections
		WHERE store_uuid = $1::uuid AND preset_id = $2
		FOR UPDATE`, row.Store, row.Preset).Scan(&status, &absent, &warehouse, &lockedMutate)
	if errors.Is(err, pgx.ErrNoRows) {
		_ = tx.Commit(ctx)
		return contract.Validation("没有注入事实")
	}
	if err != nil {
		return mapDB(err)
	}
	if err := domain.SafeContinueGuard(status, absent, warehouse, now); err != nil {
		if commitErr := tx.Commit(ctx); commitErr != nil {
			return mapDB(commitErr)
		}
		return contract.Validation(domain.GuardMessage(err))
	}
	mutate := lockedMutate
	if mutate < 1 {
		mutate = 1
	}
	if _, err := tx.Exec(ctx, `
		UPDATE shipping_shop_injections
		SET status = 'submitting', warehouse_mutate_count = GREATEST(warehouse_mutate_count, $3),
		    warehouse_id = NULL, delivery_method_id = NULL, remote_absent_at_ms = NULL,
		    pinned_version = $4, updated_at_ms = $5
		WHERE store_uuid = $1::uuid AND preset_id = $2`, row.Store, row.Preset, mutate, row.Version, now); err != nil {
		return mapDB(err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO shipping_inject_operations
		    (operation_id, org_id, store_uuid, preset_id, pinned_version, phase, status,
		     idempotency_key, warehouse_mutate_count, created_at_ms, updated_at_ms, created_by_account_uuid)
		VALUES ($1, $2, $3::uuid, $4, $5, 'create_warehouse', 'submitting', $6, $7, $8, $8, $9)`,
		opID, row.OrgID, row.Store, row.Preset, row.Version, key, mutate, now, actor); err != nil {
		return mapDB(err)
	}
	return mapDB(tx.Commit(ctx))
}

func (r Repo) finish(ctx context.Context, row row, status string, mutate int32, ozonOp, opID, phase string, now int64) error {
	var op *string
	if ozonOp != "" {
		op = &ozonOp
	}
	if _, err := r.Pool.Exec(ctx, `
		UPDATE shipping_shop_injections
		SET status = $3, warehouse_mutate_count = $4, last_ozon_operation_id = $5,
		    remote_absent_at_ms = NULL, updated_at_ms = $6
		WHERE store_uuid = $1::uuid AND preset_id = $2`, row.Store, row.Preset, status, mutate, op, now); err != nil {
		return mapDB(err)
	}
	_, err := r.Pool.Exec(ctx, `
		UPDATE shipping_inject_operations
		SET phase = $2, status = $3, ozon_operation_id = COALESCE($4, ozon_operation_id),
		    warehouse_mutate_count = GREATEST(warehouse_mutate_count, $5), updated_at_ms = $6
		WHERE operation_id = $1`, opID, phase, status, op, mutate, now)
	return mapDB(err)
}

func (r Repo) persist(ctx context.Context, row row, status string, mutate int32, warehouse, delivery *int64, absent bool, now int64, phase string) error {
	var proof *int64
	proof = domain.RemoteAbsentAt(status, warehouse, absent, now)
	if _, err := r.Pool.Exec(ctx, `
		UPDATE shipping_shop_injections
		SET status = $3, warehouse_mutate_count = GREATEST(warehouse_mutate_count, $4),
		    warehouse_id = $5, delivery_method_id = $6, remote_absent_at_ms = $7, updated_at_ms = $8
		WHERE store_uuid = $1::uuid AND preset_id = $2`,
		row.Store, row.Preset, status, mutate, warehouse, delivery, proof, now); err != nil {
		return mapDB(err)
	}
	_ = phase
	return nil
}

func (r Repo) diagnostic(ctx context.Context, storeUUID, presetID string, now int64) (json.RawMessage, error) {
	var d struct {
		Store, Preset, Name, Status string
		Desired, Applied            int64
		Warehouse, Delivery         *int64
		OzonOp, Phase, Finger       *string
		Remote                      *int64
		Polled, Waiting             *int64
	}
	err := r.Pool.QueryRow(ctx, `
		SELECT lower(i.store_uuid::text), i.preset_id, p.name, p.current_version, i.pinned_version, i.status,
		       i.warehouse_id, i.delivery_method_id, i.last_ozon_operation_id, i.remote_absent_at_ms,
		       o.phase, o.idempotency_key, poll.updated_at_ms,
		       CASE WHEN i.status = 'waiting' THEN COALESCE(w.created_at_ms, i.created_at_ms) END
		FROM shipping_shop_injections i
		JOIN shipping_presets p ON p.preset_id = i.preset_id
		LEFT JOIN LATERAL (
		    SELECT phase, idempotency_key FROM shipping_inject_operations
		    WHERE store_uuid = i.store_uuid AND preset_id = i.preset_id
		    ORDER BY created_at_ms DESC LIMIT 1) o ON true
		LEFT JOIN LATERAL (
		    SELECT updated_at_ms FROM shipping_inject_operations
		    WHERE store_uuid = i.store_uuid AND preset_id = i.preset_id AND phase = 'poll'
		    ORDER BY updated_at_ms DESC LIMIT 1) poll ON true
		LEFT JOIN LATERAL (
		    SELECT created_at_ms FROM shipping_inject_operations
		    WHERE store_uuid = i.store_uuid AND preset_id = i.preset_id AND phase = 'create_warehouse' AND status = 'waiting'
		    ORDER BY created_at_ms DESC LIMIT 1) w ON true
		WHERE i.store_uuid = $1::uuid AND i.preset_id = $2`, storeUUID, presetID).Scan(
		&d.Store, &d.Preset, &d.Name, &d.Desired, &d.Applied, &d.Status,
		&d.Warehouse, &d.Delivery, &d.OzonOp, &d.Remote, &d.Phase, &d.Finger, &d.Polled, &d.Waiting)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, contract.NotFound("记录不存在")
	}
	if err != nil {
		return nil, mapDB(err)
	}
	view := map[string]any{
		"storeUuid": d.Store, "presetId": d.Preset, "presetName": d.Name,
		"desiredVersion": d.Desired, "appliedVersion": d.Applied, "injectStatus": d.Status,
		"canReconcile": true, "canSafeContinue": domain.CanSafeContinue(d.Status, d.Remote, d.Warehouse),
	}
	if d.Warehouse != nil {
		view["warehouseId"] = *d.Warehouse
	}
	if d.Delivery != nil {
		view["deliveryMethodId"] = *d.Delivery
	}
	if d.Phase != nil && *d.Phase != "" {
		view["phase"] = *d.Phase
	}
	if d.OzonOp != nil && *d.OzonOp != "" {
		view["ozonOperationId"] = *d.OzonOp
	}
	if d.Finger != nil && *d.Finger != "" {
		view["requestFingerprint"] = *d.Finger
	}
	if d.Polled != nil {
		view["lastPolledAtMs"] = *d.Polled
	}
	if d.Waiting != nil {
		wait := now - *d.Waiting
		if wait < 0 {
			wait = 0
		}
		view["waitingDurationMs"] = wait
	}
	if msg := domain.SafeError(d.Status, d.Remote); msg != "" {
		view["safeError"] = msg
	}
	raw, err := json.Marshal(map[string]any{"data": map[string]any{"injection": view}})
	if err != nil {
		return nil, contract.Internal("")
	}
	return raw, nil
}

func listWarehouses(ctx context.Context, ozon domain.Ozon, secret shopSecret) ([]domain.WarehouseName, error) {
	if ozon == nil {
		return nil, contract.Gateway("")
	}
	var all []domain.WarehouseName
	cursor := ""
	for page := 0; page < 50; page++ {
		req := map[string]any{"limit": 200, "warehouse_ids": []any{}}
		if cursor != "" {
			req["cursor"] = cursor
		}
		body, _ := json.Marshal(req)
		status, resp, err := post(ctx, ozon, secret, "/v2/warehouse/list", body, false)
		if err != nil || status < 200 || status >= 300 {
			if page == 0 && len(all) == 0 {
				status, resp, err = post(ctx, ozon, secret, "/v1/warehouse/list", []byte(`{}`), false)
				if err != nil || status < 200 || status >= 300 {
					return nil, contract.Gateway("")
				}
				return parseWarehouses(resp), nil
			}
			return all, nil
		}
		names, next, has := parsePage(resp)
		all = append(all, names...)
		if !has || strings.TrimSpace(next) == "" || next == cursor {
			return all, nil
		}
		cursor = next
	}
	return all, nil
}

func parsePage(raw []byte) ([]domain.WarehouseName, string, bool) {
	var body struct {
		Cursor     string `json:"cursor"`
		HasNext    bool   `json:"has_next"`
		Warehouses []struct {
			Name        string `json:"name"`
			WarehouseID int64  `json:"warehouse_id"`
		} `json:"warehouses"`
	}
	if json.Unmarshal(raw, &body) != nil {
		return nil, "", false
	}
	var out []domain.WarehouseName
	for _, w := range body.Warehouses {
		out = append(out, domain.WarehouseName{Name: w.Name, WarehouseID: w.WarehouseID, WarehouseName: w.Name})
	}
	return out, body.Cursor, body.HasNext
}

func parseWarehouses(raw []byte) []domain.WarehouseName {
	names, _, _ := parsePage(raw)
	if len(names) > 0 {
		return names
	}
	var rows []struct {
		Name        string `json:"name"`
		WarehouseID int64  `json:"warehouse_id"`
	}
	if json.Unmarshal(raw, &rows) == nil {
		var out []domain.WarehouseName
		for _, w := range rows {
			out = append(out, domain.WarehouseName{Name: w.Name, WarehouseID: w.WarehouseID, WarehouseName: w.Name})
		}
		return out
	}
	return nil
}

func mapDB(err error) error {
	if err == nil {
		return nil
	}
	if _, ok := err.(*contract.Fail); ok {
		return err
	}
	var pe *pgconn.PgError
	if errors.As(err, &pe) {
		switch pe.Code {
		case "55P03":
			return contract.Locked()
		case "P0M01":
			return contract.MediaGone()
		case "22P02":
			return contract.Internal("")
		}
	}
	return contract.Internal("")
}

func max(a, b int32) int32 {
	if a > b {
		return a
	}
	return b
}

// The repository is the store. The service does not import this package.
var _ domain.Store = Repo{}
