package shippingrepo

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	corecontract "github.com/xxww0098/podhub-go/internal/admin/core/contract"
	corerepo "github.com/xxww0098/podhub-go/internal/admin/core/repo"
	shipcontract "github.com/xxww0098/podhub-go/internal/admin/shipping/contract"
	"github.com/xxww0098/podhub-go/internal/platform/writer"
)

// ShippingRepo stores presets, binds, and injection diagnostics.
type ShippingRepo struct {
	Pool *pgxpool.Pool
}

const presetFrom = `public.shipping_presets p
INNER JOIN public.shipping_preset_versions v
  ON v.preset_id = p.preset_id AND v.version = p.current_version`

const presetCols = `p.preset_id, p.name, p.current_version, v.payload, p.created_at_ms, p.updated_at_ms`

const bindingFrom = `public.shipping_sku_bindings b
INNER JOIN public.sc_skus s ON s.sku_id = b.sku_id
INNER JOIN public.shipping_presets p ON p.preset_id = b.preset_id`

const bindingCols = `b.sku_id, s.product_id, b.preset_id, p.name AS preset_name, p.current_version AS required_version, b.created_at_ms, b.updated_at_ms`

const diagnosticSQL = `
SELECT lower(i.store_uuid::text) AS store_uuid,
       i.preset_id,
       p.name AS preset_name,
       p.current_version AS desired_version,
       i.pinned_version,
       i.status,
       i.warehouse_id,
       i.delivery_method_id,
       i.last_ozon_operation_id,
       i.remote_absent_at_ms,
       o.phase,
       o.idempotency_key AS request_fingerprint,
       poll.updated_at_ms AS last_polled_at_ms,
       CASE WHEN i.status = 'waiting'
            THEN COALESCE(w.created_at_ms, i.created_at_ms)
       END AS waiting_since_ms
  FROM public.shipping_shop_injections i
  JOIN public.shipping_presets p ON p.preset_id = i.preset_id
  LEFT JOIN LATERAL (
        SELECT phase, idempotency_key
          FROM public.shipping_inject_operations
         WHERE store_uuid = i.store_uuid AND preset_id = i.preset_id
         ORDER BY created_at_ms DESC
         LIMIT 1
  ) o ON true
  LEFT JOIN LATERAL (
        SELECT updated_at_ms
          FROM public.shipping_inject_operations
         WHERE store_uuid = i.store_uuid AND preset_id = i.preset_id
           AND phase = 'poll'
         ORDER BY updated_at_ms DESC
         LIMIT 1
  ) poll ON true
  LEFT JOIN LATERAL (
        SELECT created_at_ms
          FROM public.shipping_inject_operations
         WHERE store_uuid = i.store_uuid AND preset_id = i.preset_id
           AND status = 'waiting'
         ORDER BY created_at_ms ASC
         LIMIT 1
  ) w ON true
`

func (r ShippingRepo) read(ctx context.Context, code string, fn func(pgx.Tx) error) error {
	if r.Pool == nil {
		return corecontract.Fail(500, code, "服务暂不可用")
	}
	tx, err := corerepo.BeginAdmin(ctx, r.Pool)
	if err != nil {
		return corerepo.MapAdmin(err, code)
	}
	defer tx.Rollback(ctx)
	defer corerepo.EndLease(tx)
	if err := fn(tx); err != nil {
		return corerepo.MapAdmin(err, code)
	}
	return corerepo.MapAdmin(tx.Commit(ctx), code)
}

func (r ShippingRepo) write(ctx context.Context, fn func(pgx.Tx) error) error {
	if r.Pool == nil {
		return corecontract.Fail(500, "INTERNAL", "服务暂不可用")
	}
	tx, err := corerepo.BeginAdmin(ctx, r.Pool)
	if err != nil {
		return corerepo.MapAdmin(err, "INTERNAL")
	}
	defer tx.Rollback(ctx)
	defer corerepo.EndLease(tx)
	defer writer.Forget(tx)
	if err := corerepo.AssertWriteLease(ctx, tx, "物流预设写入未启用"); err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		return corerepo.MapAdmin(err, "INTERNAL")
	}
	return corerepo.MapAdmin(tx.Commit(ctx), "INTERNAL")
}

func (r ShippingRepo) ListPresets(ctx context.Context) ([]shipcontract.Preset, error) {
	var out []shipcontract.Preset
	err := r.read(ctx, "INTERNAL", func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT `+presetCols+` FROM `+presetFrom+` ORDER BY p.created_at_ms, p.preset_id`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			p, err := scanPreset(rows)
			if err != nil {
				return err
			}
			out = append(out, p)
		}
		return rows.Err()
	})
	if out == nil {
		out = []shipcontract.Preset{}
	}
	return out, err
}

func (r ShippingRepo) GetPreset(ctx context.Context, id string) (shipcontract.PresetView, error) {
	var view shipcontract.PresetView
	err := r.read(ctx, "INTERNAL", func(tx pgx.Tx) error {
		p, err := loadPreset(ctx, tx, id)
		if err != nil {
			return err
		}
		if p == nil {
			return corecontract.Fail(404, "NOT_FOUND", "记录不存在")
		}
		view.Preset = *p
		rows, err := tx.Query(ctx, `SELECT version, payload, created_at_ms FROM public.shipping_preset_versions WHERE preset_id = $1 ORDER BY version`, id)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var version, created int64
			var raw []byte
			if err := rows.Scan(&version, &raw, &created); err != nil {
				return err
			}
			view.Versions = append(view.Versions, shipcontract.Version{Version: version, Payload: shipcontract.DecodeStoredPayload(raw), CreatedAtMs: created})
		}
		return rows.Err()
	})
	if view.Versions == nil {
		view.Versions = []shipcontract.Version{}
	}
	return view, err
}

func (r ShippingRepo) CreatePreset(ctx context.Context, actor corecontract.Actor, id, name string, payload shipcontract.PresetPayload, now int64) (shipcontract.Preset, error) {
	var row shipcontract.Preset
	err := r.write(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `INSERT INTO public.shipping_presets
			(preset_id, name, current_version, created_at_ms, updated_at_ms, created_by_account_uuid)
			VALUES ($1, $2, 1, $3, $3, $4)`, id, name, now, actor.PublicID); err != nil {
			return err
		}
		if err := insertVersion(ctx, tx, id, 1, payload, now, actor.PublicID); err != nil {
			return err
		}
		loaded, err := loadPreset(ctx, tx, id)
		if err != nil {
			return err
		}
		if loaded == nil {
			return corecontract.Fail(500, "INTERNAL", "服务暂不可用")
		}
		row = *loaded
		return corerepo.InsertAudit(ctx, tx, presetAudit(actor, row, "POST", "/api/admin/shipping-presets", "shipping_preset_created"))
	})
	return row, err
}

func (r ShippingRepo) UpdatePreset(ctx context.Context, actor corecontract.Actor, id string, expected int64, name string, payload shipcontract.PresetPayload, now int64) (shipcontract.Preset, error) {
	var row shipcontract.Preset
	err := r.write(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `UPDATE public.shipping_presets
			SET name = $3, current_version = $4, updated_at_ms = $5
			WHERE preset_id = $1 AND current_version = $2`, id, expected, name, expected+1, now)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return casMiss(ctx, tx, id)
		}
		if err := insertVersion(ctx, tx, id, expected+1, payload, now, actor.PublicID); err != nil {
			return err
		}
		loaded, err := loadPreset(ctx, tx, id)
		if err != nil {
			return err
		}
		if loaded == nil {
			return corecontract.Fail(404, "NOT_FOUND", "记录不存在")
		}
		row = *loaded
		return corerepo.InsertAudit(ctx, tx, presetAudit(actor, row, "PUT", "/api/admin/shipping-presets/{preset_id}", "shipping_preset_version_published"))
	})
	return row, err
}

func (r ShippingRepo) DeletePreset(ctx context.Context, actor corecontract.Actor, id string) error {
	return r.write(ctx, func(tx pgx.Tx) error {
		loaded, err := loadPreset(ctx, tx, id)
		if err != nil {
			return err
		}
		if loaded == nil {
			return corecontract.Fail(404, "NOT_FOUND", "记录不存在")
		}
		var one int
		err = tx.QueryRow(ctx, `SELECT 1 FROM public.shipping_sku_bindings WHERE preset_id = $1
			UNION ALL
			SELECT 1 FROM public.shipping_shop_injections WHERE preset_id = $1
			UNION ALL
			SELECT 1 FROM public.shipping_inject_operations WHERE preset_id = $1
			LIMIT 1`, id).Scan(&one)
		if err == nil {
			return corecontract.Fail(409, "CONFLICT", "仍有平台 SKU 绑定或店铺注入使用该预设")
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM public.shipping_preset_versions WHERE preset_id = $1`, id); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM public.shipping_presets WHERE preset_id = $1`, id); err != nil {
			return err
		}
		return corerepo.InsertAudit(ctx, tx, presetAudit(actor, *loaded, "DELETE", "/api/admin/shipping-presets/{preset_id}", "shipping_preset_deleted"))
	})
}

func (r ShippingRepo) Bind(ctx context.Context, actor corecontract.Actor, sku, preset string, now int64) (shipcontract.Binding, error) {
	var row shipcontract.Binding
	err := r.write(ctx, func(tx pgx.Tx) error {
		b, err := upsertBinding(ctx, tx, actor, sku, preset, now)
		if err != nil {
			return err
		}
		row = b
		return nil
	})
	return row, err
}

func (r ShippingRepo) Unbind(ctx context.Context, actor corecontract.Actor, sku string) error {
	return r.write(ctx, func(tx pgx.Tx) error {
		row, err := loadBinding(ctx, tx, sku)
		if err != nil {
			return err
		}
		if row == nil {
			return corecontract.Fail(404, "NOT_FOUND", "记录不存在")
		}
		if _, err := tx.Exec(ctx, `DELETE FROM public.shipping_sku_bindings WHERE sku_id = $1`, sku); err != nil {
			return err
		}
		return corerepo.InsertAudit(ctx, tx, bindingAudit(actor, *row, "DELETE", "/api/admin/shipping-sku-bindings/{sku_id}", "shipping_sku_unbound"))
	})
}

func (r ShippingRepo) Apply(ctx context.Context, actor corecontract.Actor, product, preset string, now int64) ([]shipcontract.Binding, error) {
	var rowsOut []shipcontract.Binding
	err := r.write(ctx, func(tx pgx.Tx) error {
		if err := ensurePreset(ctx, tx, preset); err != nil {
			return err
		}
		skus, err := tx.Query(ctx, `SELECT sku_id FROM public.sc_skus WHERE product_id = $1 ORDER BY created_at_ms, sku_id`, product)
		if err != nil {
			return err
		}
		var ids []string
		for skus.Next() {
			var id string
			if err := skus.Scan(&id); err != nil {
				skus.Close()
				return err
			}
			ids = append(ids, id)
		}
		skus.Close()
		if err := skus.Err(); err != nil {
			return err
		}
		if len(ids) == 0 {
			var one int
			err := tx.QueryRow(ctx, `SELECT 1 FROM public.sc_products WHERE product_id = $1`, product).Scan(&one)
			if err == nil {
				return corecontract.Fail(400, "VALIDATION", "平台商品没有 SKU")
			}
			if errors.Is(err, pgx.ErrNoRows) {
				return corecontract.Fail(400, "VALIDATION", "平台商品不存在")
			}
			return err
		}
		rowsOut, err = bindSKUs(ctx, tx, actor, ids, preset, now)
		return err
	})
	return rowsOut, err
}

func (r ShippingRepo) Readiness(ctx context.Context, sku, store string) (*shipcontract.BindingRef, *shipcontract.PresetPayload, *shipcontract.InjectionFact, error) {
	var bind *shipcontract.BindingRef
	var payload *shipcontract.PresetPayload
	var inject *shipcontract.InjectionFact
	err := r.read(ctx, "INTERNAL", func(tx pgx.Tx) error {
		row, err := loadBinding(ctx, tx, sku)
		if err != nil {
			return err
		}
		if row == nil {
			return nil
		}
		bind = &shipcontract.BindingRef{PresetID: row.PresetID, RequiredVersion: row.RequiredVersion}
		if store == "" {
			return nil
		}
		var fact shipcontract.InjectionFact
		var status string
		err = tx.QueryRow(ctx, `SELECT pinned_version, status, warehouse_id, delivery_method_id, delivery_method_status
			FROM public.shipping_shop_injections WHERE store_uuid = $1::uuid AND preset_id = $2`, store, row.PresetID).
			Scan(&fact.PinnedVersion, &status, &fact.WarehouseID, &fact.DeliveryMethodID, &fact.DeliveryMethodStatus)
		if err == nil {
			fact.Status = status
			inject = &fact
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		var raw []byte
		err = tx.QueryRow(ctx, `SELECT payload FROM public.shipping_preset_versions WHERE preset_id = $1 AND version = $2`, row.PresetID, row.RequiredVersion).Scan(&raw)
		if err == nil {
			p := shipcontract.DecodeStoredPayload(raw)
			payload = &p
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		return nil
	})
	return bind, payload, inject, err
}

func (r ShippingRepo) ListDiagnostics(ctx context.Context) ([]shipcontract.Diagnostic, error) {
	var out []shipcontract.Diagnostic
	err := r.read(ctx, "INTERNAL", func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, diagnosticSQL+` ORDER BY i.updated_at_ms DESC`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			d, err := scanDiagnostic(rows)
			if err != nil {
				return err
			}
			out = append(out, d)
		}
		return rows.Err()
	})
	if out == nil {
		out = []shipcontract.Diagnostic{}
	}
	return out, err
}

func (r ShippingRepo) LoadDiagnostic(ctx context.Context, store, preset string) (shipcontract.Diagnostic, error) {
	var d shipcontract.Diagnostic
	err := r.read(ctx, "INTERNAL", func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, diagnosticSQL+` WHERE i.store_uuid = $1::uuid AND i.preset_id = $2`, store, preset)
		if err != nil {
			return err
		}
		defer rows.Close()
		if !rows.Next() {
			if err := rows.Err(); err != nil {
				return err
			}
			return corecontract.Fail(404, "NOT_FOUND", "记录不存在")
		}
		d, err = scanDiagnostic(rows)
		return err
	})
	return d, err
}

func (r ShippingRepo) LoadSafe(ctx context.Context, store, preset string) (shipcontract.SafeFact, error) {
	var f shipcontract.SafeFact
	err := r.read(ctx, "INTERNAL", func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `SELECT status, warehouse_id, remote_absent_at_ms
			FROM public.shipping_shop_injections WHERE store_uuid = $1::uuid AND preset_id = $2`, store, preset).
			Scan(&f.Status, &f.WarehouseID, &f.RemoteAbsentAtMs)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		f.Found = true
		var version int64
		err = tx.QueryRow(ctx, `SELECT current_version FROM public.shipping_presets WHERE preset_id = $1`, preset).Scan(&version)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		f.PresetFound = true
		var raw []byte
		err = tx.QueryRow(ctx, `SELECT payload FROM public.shipping_preset_versions WHERE preset_id = $1 AND version = $2`, preset, version).Scan(&raw)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		f.VersionFound = true
		f.Mode = string(shipcontract.DecodeStoredPayload(raw).Mode)
		return nil
	})
	return f, err
}

// bindSKUs checks every sku, upserts them in one statement, then loads and
// audits in the caller's sku order. A missing sku returns before the upsert
// so the surrounding transaction rolls the batch back.
func bindSKUs(ctx context.Context, tx pgx.Tx, actor corecontract.Actor, ids []string, preset string, now int64) ([]shipcontract.Binding, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	found := map[string]struct{}{}
	rows, err := tx.Query(ctx, `SELECT sku_id FROM public.sc_skus WHERE sku_id = ANY($1::text[])`, ids)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		found[id] = struct{}{}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	for _, sku := range ids {
		if _, ok := found[sku]; !ok {
			return nil, corecontract.Fail(400, "VALIDATION", "平台 SKU 不存在")
		}
	}
	_, err = tx.Exec(ctx, `INSERT INTO public.shipping_sku_bindings
		(sku_id, preset_id, created_at_ms, updated_at_ms, created_by_account_uuid)
		SELECT sku_id, $2, $3, $3, $4
		  FROM unnest($1::text[]) AS sku_id
		ON CONFLICT (sku_id) DO UPDATE
		  SET preset_id = EXCLUDED.preset_id,
		      updated_at_ms = EXCLUDED.updated_at_ms,
		      created_by_account_uuid = EXCLUDED.created_by_account_uuid`, ids, preset, now, actor.PublicID)
	if err != nil {
		var pg *pgconn.PgError
		if errors.As(err, &pg) && pg.Code == "23503" {
			return nil, corecontract.Fail(400, "VALIDATION", "平台 SKU 不存在")
		}
		return nil, err
	}
	out := make([]shipcontract.Binding, 0, len(ids))
	for _, sku := range ids {
		row, err := loadBinding(ctx, tx, sku)
		if err != nil {
			return nil, err
		}
		if row == nil {
			return nil, corecontract.Fail(500, "INTERNAL", "服务暂不可用")
		}
		if err := corerepo.InsertAudit(ctx, tx, bindingAudit(actor, *row, "POST", "/api/admin/shipping-sku-bindings", "shipping_sku_bound")); err != nil {
			return nil, err
		}
		out = append(out, *row)
	}
	return out, nil
}

func upsertBinding(ctx context.Context, tx pgx.Tx, actor corecontract.Actor, sku, preset string, now int64) (shipcontract.Binding, error) {
	if err := ensurePreset(ctx, tx, preset); err != nil {
		return shipcontract.Binding{}, err
	}
	var one int
	err := tx.QueryRow(ctx, `SELECT 1 FROM public.sc_skus WHERE sku_id = $1`, sku).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return shipcontract.Binding{}, corecontract.Fail(400, "VALIDATION", "平台 SKU 不存在")
	}
	if err != nil {
		return shipcontract.Binding{}, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO public.shipping_sku_bindings
		(sku_id, preset_id, created_at_ms, updated_at_ms, created_by_account_uuid)
		VALUES ($1, $2, $3, $3, $4)
		ON CONFLICT (sku_id) DO UPDATE
		  SET preset_id = EXCLUDED.preset_id,
		      updated_at_ms = EXCLUDED.updated_at_ms,
		      created_by_account_uuid = EXCLUDED.created_by_account_uuid`, sku, preset, now, actor.PublicID)
	if err != nil {
		var pg *pgconn.PgError
		if errors.As(err, &pg) && pg.Code == "23503" {
			return shipcontract.Binding{}, corecontract.Fail(400, "VALIDATION", "平台 SKU 不存在")
		}
		return shipcontract.Binding{}, err
	}
	row, err := loadBinding(ctx, tx, sku)
	if err != nil {
		return shipcontract.Binding{}, err
	}
	if row == nil {
		return shipcontract.Binding{}, corecontract.Fail(500, "INTERNAL", "服务暂不可用")
	}
	if err := corerepo.InsertAudit(ctx, tx, bindingAudit(actor, *row, "POST", "/api/admin/shipping-sku-bindings", "shipping_sku_bound")); err != nil {
		return shipcontract.Binding{}, err
	}
	return *row, nil
}

func ensurePreset(ctx context.Context, tx pgx.Tx, id string) error {
	p, err := loadPreset(ctx, tx, id)
	if err != nil {
		return err
	}
	if p == nil {
		return corecontract.Fail(404, "NOT_FOUND", "记录不存在")
	}
	return nil
}

func casMiss(ctx context.Context, tx pgx.Tx, id string) error {
	p, err := loadPreset(ctx, tx, id)
	if err != nil {
		return err
	}
	if p == nil {
		return corecontract.Fail(404, "NOT_FOUND", "记录不存在")
	}
	return corecontract.Fail(409, "CONFLICT", "预设已被更新，请刷新后重试")
}

func insertVersion(ctx context.Context, tx pgx.Tx, id string, version int64, payload shipcontract.PresetPayload, now int64, actor string) error {
	raw, err := corecontract.Marshal(payload)
	if err != nil {
		return corecontract.Fail(500, "INTERNAL", "服务暂不可用")
	}
	_, err = tx.Exec(ctx, `INSERT INTO public.shipping_preset_versions
		(preset_id, version, payload, created_at_ms, created_by_account_uuid)
		VALUES ($1, $2, $3::jsonb, $4, $5)`, id, version, string(raw), now, actor)
	return err
}

func loadPreset(ctx context.Context, tx pgx.Tx, id string) (*shipcontract.Preset, error) {
	row := tx.QueryRow(ctx, `SELECT `+presetCols+` FROM `+presetFrom+` WHERE p.preset_id = $1`, id)
	p, err := scanPreset(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &p, nil
}

func loadBinding(ctx context.Context, tx pgx.Tx, sku string) (*shipcontract.Binding, error) {
	var b shipcontract.Binding
	err := tx.QueryRow(ctx, `SELECT `+bindingCols+` FROM `+bindingFrom+` WHERE b.sku_id = $1`, sku).
		Scan(&b.SKUID, &b.ProductID, &b.PresetID, &b.PresetName, &b.RequiredVersion, &b.CreatedAtMs, &b.UpdatedAtMs)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &b, nil
}

type scannable interface {
	Scan(dest ...any) error
}

func scanPreset(row scannable) (shipcontract.Preset, error) {
	var id, name string
	var version, created, updated int64
	var raw []byte
	if err := row.Scan(&id, &name, &version, &raw, &created, &updated); err != nil {
		return shipcontract.Preset{}, err
	}
	return shipcontract.NewPreset(id, name, version, created, updated, shipcontract.DecodeStoredPayload(raw)), nil
}

func scanDiagnostic(row scannable) (shipcontract.Diagnostic, error) {
	var d shipcontract.Diagnostic
	err := row.Scan(&d.StoreUUID, &d.PresetID, &d.PresetName, &d.DesiredVersion, &d.PinnedVersion, &d.Status,
		&d.WarehouseID, &d.DeliveryMethodID, &d.LastOzonOperationID, &d.RemoteAbsentAtMs,
		&d.Phase, &d.RequestFingerprint, &d.LastPolledAtMs, &d.WaitingSinceMs)
	return d, err
}

func presetAudit(actor corecontract.Actor, row shipcontract.Preset, method, path, action string) corerepo.AuditRow {
	msg, _ := corecontract.Marshal(struct {
		Summary         string `json:"summary"`
		CurrentVersion  int64  `json:"currentVersion"`
		RequiredVersion int64  `json:"requiredVersion"`
	}{Summary: row.Name, CurrentVersion: row.CurrentVersion, RequiredVersion: row.CurrentVersion})
	return corerepo.AuditRow{
		OrgID: actor.OrgID, UserID: actor.UserID, Module: "admin", EntityType: "shipping_preset",
		EntityID: row.PresetID, Method: method, Path: path, Action: action, Message: string(msg),
	}
}

func bindingAudit(actor corecontract.Actor, row shipcontract.Binding, method, path, action string) corerepo.AuditRow {
	msg, _ := corecontract.Marshal(struct {
		PresetID        string `json:"presetId"`
		PresetName      string `json:"presetName"`
		RequiredVersion int64  `json:"requiredVersion"`
	}{PresetID: row.PresetID, PresetName: row.PresetName, RequiredVersion: row.RequiredVersion})
	return corerepo.AuditRow{
		OrgID: actor.OrgID, UserID: actor.UserID, Module: "admin", EntityType: "shipping_sku_binding",
		EntityID: row.SKUID, Method: method, Path: path, Action: action, Message: string(msg),
	}
}
