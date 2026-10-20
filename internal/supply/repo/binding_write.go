package supplyrepo

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/supply/contract"
	"github.com/xxww0098/podhub-go/internal/supply/domain"
)

func (r Repo) BindingView(ctx context.Context, orgID int64, listingRowID string) (contract.BindingData, error) {
	var out contract.BindingData
	err := r.tx(ctx, orgID, func(tx pgx.Tx) error {
		row, err := loadBinding(ctx, tx, orgID, listingRowID)
		if err != nil {
			return err
		}
		out = row
		return nil
	})
	return out, err
}

func (r Repo) PutBinding(ctx context.Context, orgID, userID int64, listingRowID string, files []domain.ProductionFile, sku string, quantity, nowMs int64) (contract.BindingData, error) {
	var out contract.BindingData
	err := r.tx(ctx, orgID, func(tx pgx.Tx) error {
		var storeID string
		var storeNull *string
		var design int64
		err := tx.QueryRow(ctx, `
			SELECT id::text, store_id::text, revision
			FROM public.listing_rows
			WHERE org_id = $1 AND id = $2::uuid`, orgID, listingRowID).Scan(&out.ListingRowID, &storeNull, &design)
		if errors.Is(err, pgx.ErrNoRows) {
			return fail(404, "NOT_FOUND", "记录不存在或未上架")
		}
		if err != nil {
			return mapDB(err)
		}
		if storeNull != nil {
			storeID = strings.TrimSpace(*storeNull)
		}
		if storeID == "" {
			return fail(400, "VALIDATION", "商品行尚未指定目标店铺")
		}
		var one int
		err = tx.QueryRow(ctx, `
			SELECT 1 FROM public.organization_stores
			WHERE org_id = $1 AND uuid = $2::uuid`, orgID, storeID).Scan(&one)
		if errors.Is(err, pgx.ErrNoRows) {
			return fail(404, "NOT_FOUND", "记录不存在或未上架")
		}
		if err != nil {
			return mapDB(err)
		}
		var spec int64
		var skuPublished, productPublished bool
		err = tx.QueryRow(ctx, `
			SELECT s.sku_id, s.revision, s.published, p.published
			FROM public.sc_skus s
			JOIN public.sc_products p ON p.product_id = s.product_id
			WHERE s.sku_id = $1`, sku).Scan(&sku, &spec, &skuPublished, &productPublished)
		if errors.Is(err, pgx.ErrNoRows) {
			return fail(404, "NOT_FOUND", "记录不存在或未上架")
		}
		if err != nil {
			return mapDB(err)
		}
		if !skuPublished || !productPublished {
			return fail(400, "VALIDATION", "未上架的平台 SKU 不能绑定")
		}
		actor, err := accountPublicID(ctx, tx, userID)
		if err != nil {
			return err
		}
		raw, err := writeSnapshot(sku, spec, design, files, quantity)
		if err != nil {
			return fail(500, "INTERNAL", "服务暂不可用")
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO public.sc_listing_bindings (
			    org_id, store_id, listing_row_id, platform_sku_id,
			    spec_version, design_revision, production_snapshot,
			    created_at_ms, updated_at_ms, created_by_account_uuid
			) VALUES (
			    $1, $2::uuid, $3::uuid, $4, $5, $6, $7::jsonb, $8, $8, $9
			)
			ON CONFLICT (org_id, listing_row_id) DO UPDATE SET
			    store_id = EXCLUDED.store_id,
			    platform_sku_id = EXCLUDED.platform_sku_id,
			    spec_version = EXCLUDED.spec_version,
			    design_revision = EXCLUDED.design_revision,
			    production_snapshot = EXCLUDED.production_snapshot,
			    updated_at_ms = EXCLUDED.updated_at_ms`,
			orgID, storeID, listingRowID, sku, spec, design, string(raw), nowMs, actor); err != nil {
			return mapDB(err)
		}
		out, err = loadBinding(ctx, tx, orgID, listingRowID)
		return err
	})
	return out, err
}

func (r Repo) DeleteBinding(ctx context.Context, orgID int64, listingRowID string) error {
	return r.tx(ctx, orgID, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `
			DELETE FROM public.sc_listing_bindings
			WHERE org_id = $1 AND listing_row_id = $2::uuid`, orgID, listingRowID)
		if err != nil {
			return mapDB(err)
		}
		if tag.RowsAffected() == 0 {
			return fail(404, "NOT_FOUND", "记录不存在或未上架")
		}
		return nil
	})
}

func loadBinding(ctx context.Context, tx pgx.Tx, orgID int64, listingRowID string) (contract.BindingData, error) {
	var row contract.BindingData
	var snap []byte
	var sku string
	var spec, design int64
	err := tx.QueryRow(ctx, `
		SELECT listing_row_id::text, store_id::text, platform_sku_id,
		       spec_version, design_revision, production_snapshot,
		       created_at_ms, updated_at_ms
		FROM public.sc_listing_bindings
		WHERE org_id = $1 AND listing_row_id = $2::uuid`, orgID, listingRowID).Scan(
		&row.ListingRowID, &row.StoreID, &sku, &spec, &design, &snap, &row.CreatedAtMs, &row.UpdatedAtMs)
	if errors.Is(err, pgx.ErrNoRows) {
		return contract.BindingData{}, fail(404, "NOT_FOUND", "记录不存在或未上架")
	}
	if err != nil {
		return contract.BindingData{}, mapDB(err)
	}
	row.PlatformSKUID, row.SpecVersion, row.DesignRevision, row.ProductionFiles, row.QuantityPlaceholder = readSnapshot(snap, sku, spec, design)
	if row.ProductionFiles == nil {
		row.ProductionFiles = []contract.ProductionFile{}
	}
	return row, nil
}

func accountPublicID(ctx context.Context, tx pgx.Tx, userID int64) (string, error) {
	var id string
	err := tx.QueryRow(ctx, `SELECT public_id FROM public.account_users WHERE id = $1`, userID).Scan(&id)
	if err != nil {
		return "", mapDB(err)
	}
	return id, nil
}
