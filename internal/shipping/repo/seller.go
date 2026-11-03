package repo

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/shipping/contract"
	"github.com/xxww0098/podhub-go/internal/shipping/domain"
)

// SellerReadiness reads one SKU binding and injection row. The store must
// belong to orgID; the binding itself is global.
func (r Repo) SellerReadiness(ctx context.Context, orgID int64, storeUUID, sku string) (contract.SellerReadiness, error) {
	var bind *contract.SellerBinding
	var preset domain.Preset
	var inject *contract.SellerInjection
	if r.Pool == nil {
		return contract.SellerReadiness{}, contract.Internal("")
	}
	err := db.InTx(ctx, r.Pool, db.Staff(), func(tx pgx.Tx) error {
		var presetID, name string
		var version int64
		var payload []byte
		err := tx.QueryRow(ctx, `
			SELECT b.preset_id, p.name, p.current_version, v.payload
			FROM shipping_sku_bindings b
			JOIN shipping_presets p ON p.preset_id = b.preset_id
			JOIN shipping_preset_versions v ON v.preset_id = p.preset_id AND v.version = p.current_version
			WHERE b.sku_id = $1`, sku).Scan(&presetID, &name, &version, &payload)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		parsed, err := domain.DecodePreset(payload)
		if err != nil {
			return err
		}
		preset = parsed
		bind = &contract.SellerBinding{SKUID: sku, PresetID: presetID, PresetName: name, RequiredVersion: version}
		return nil
	})
	if err != nil {
		return contract.SellerReadiness{}, mapDB(err)
	}
	err = db.InTx(ctx, r.Pool, db.App(orgID), func(tx pgx.Tx) error {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM organization_stores WHERE org_id = $1 AND uuid = $2::uuid AND deleted_at_ms IS NULL)`, orgID, storeUUID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return contract.NotFound("店铺不存在")
		}
		if bind == nil {
			return nil
		}
		var pinned int64
		var status string
		var warehouse, delivery *int64
		var deliveryStatus *string
		err := tx.QueryRow(ctx, `
			SELECT pinned_version, status, warehouse_id, delivery_method_id, delivery_method_status
			FROM shipping_shop_injections
			WHERE store_uuid = $1::uuid AND preset_id = $2`, storeUUID, bind.PresetID).Scan(
			&pinned, &status, &warehouse, &delivery, &deliveryStatus)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		inject = &contract.SellerInjection{PinnedVersion: &pinned, Status: status, WarehouseID: warehouse, DeliveryID: delivery, DeliveryStatus: deliveryStatus}
		return nil
	})
	if err != nil {
		return contract.SellerReadiness{}, mapDB(err)
	}
	return domain.EvaluateSellerReadiness(sku, bind, &preset, inject), nil
}

// EnsureInjection creates the injection row when it does not exist yet. It
// never changes an existing row.
func (r Repo) EnsureInjection(ctx context.Context, orgID int64, storeUUID, presetID string, now int64) error {
	if r.Pool == nil {
		return contract.Internal("")
	}
	return db.InTx(ctx, r.Pool, db.App(orgID), func(tx pgx.Tx) error {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM organization_stores WHERE org_id = $1 AND uuid = $2::uuid AND deleted_at_ms IS NULL)`, orgID, storeUUID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return contract.NotFound("店铺不存在")
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO shipping_shop_injections
				(org_id, store_uuid, preset_id, pinned_version, status, warehouse_mutate_count, created_at_ms, updated_at_ms)
			SELECT s.org_id, s.uuid, p.preset_id, p.current_version, 'unknown', 0, $3, $3
			FROM organization_stores s
			JOIN shipping_presets p ON p.preset_id = $2
			WHERE s.org_id = $1 AND s.uuid = $4::uuid AND s.deleted_at_ms IS NULL
			ON CONFLICT (store_uuid, preset_id) DO NOTHING`, orgID, presetID, now, storeUUID)
		return err
	})
}
