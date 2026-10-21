package catalogrepo

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/xxww0098/podhub-go/internal/suppliercatalog/contract"
)

// constraint maps a unique violation to the catalogue's 409 vocabulary.
func constraint(err error) error {
	if err == nil {
		return nil
	}
	var pe *pgconn.PgError
	if errors.As(err, &pe) {
		switch pe.Code {
		case "23505":
			switch pe.ConstraintName {
			case "ux_sc_skus_platform_code":
				return contract.Conflict("平台货号已被占用")
			case "ux_sc_products_variant_group_size":
				return contract.Conflict("同款尺寸已存在")
			case "ux_sc_source_offers_source_sku":
				return contract.Conflict("供货成本记录冲突")
			}
			return contract.Conflict("记录冲突")
		case "23514":
			// ck_sc_source_offers_cost: the factory cost must be positive.
			if pe.ConstraintName == "ck_sc_source_offers_cost" {
				return contract.Validation("供货成本必须大于 0")
			}
			return contract.Validation("字段取值不合法")
		case "23502":
			return contract.Validation("缺少必填字段")
		case "42501":
			// RLS refused the row. For a catalog manager that means the source
			// is not one it maintains, or the write touched a column it does
			// not own. Both are a 403, never a 500.
			return contract.Forbidden()
		case "55P03":
			return contract.Unavailable()
		}
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return contract.NotFound()
	}
	return contract.Internal()
}

// insertProduct writes the product half of a new row.
func insertProduct(ctx context.Context, tx pgx.Tx, in contract.RowInput, productID, sourceID, publicID string, now int64) error {
	if strings.TrimSpace(in.VariantGroup) != "" && strings.TrimSpace(in.Size) == "" {
		return contract.Validation("同款分组需要填写尺寸")
	}
	if strings.TrimSpace(in.Title) == "" {
		return contract.Validation("请填写商品标题")
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO public.sc_products
		    (product_id, source_id, title, variant_group, description, published, revision,
		     product_videos, gallery, psd, description_category_id, type_id, internal_note,
		     props, archived, size, material, craft, gross_weight_g, brand,
		     pack_width_mm, pack_height_mm, pack_depth_mm, pack_weight_g, contents,
		     created_at_ms, updated_at_ms, created_by_account_uuid)
		VALUES ($1, $2, $3, $4, $5, false, 1, $6, $7, $8, $9, $10, $11, $12, false,
		        $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $23, $24)`,
		productID, sourceID, in.Title, in.VariantGroup, in.Description,
		rawOr(in.Videos, `[]`), rawOr(in.Gallery, `[]`), rawOr(in.PSD, `[]`),
		in.DescriptionCategoryID, in.TypeID, in.InternalNote, rawOr(in.Props, `{}`),
		in.Size, in.Material, in.Craft, in.GrossWeightG, in.Brand,
		in.PackWidthMM, in.PackHeightMM, in.PackDepthMM, in.PackWeightG, in.Contents,
		now, publicID)
	return constraint(err)
}

// insertSKU writes the sku half. sc_skus_product_unique allows exactly one sku
// per product, which is why every read joins on product_id and asserts a
// single sku.
func insertSKU(ctx context.Context, tx pgx.Tx, skuID, productID, code, title string, in contract.RowInput, publicID string, now int64) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO public.sc_skus
		    (sku_id, product_id, platform_code, title, lead_time, published, revision,
		     suggested_retail_cents, suggested_old_price_cents, created_at_ms,
		     updated_at_ms, created_by_account_uuid)
		VALUES ($1, $2, $3, $4, $5, false, 1, $6, $7, $8, $8, $9)`,
		skuID, productID, code, title, in.LeadTime, in.SuggestedRetail, in.SuggestedOld, now, publicID)
	return constraint(err)
}

// upsertOffer sets the supply cost for one sku.
//
// This must be INSERT ... ON CONFLICT, NOT the DELETE-then-INSERT shape x1
// uses. The catalog-manager arm on sc_source_offers is SELECT + INSERT +
// UPDATE with no DELETE, so a manager's DELETE would silently match zero rows
// (RLS filters rather than erroring) and the following INSERT would then
// collide with ux_sc_source_offers_source_sku.
func upsertOffer(ctx context.Context, tx pgx.Tx, sourceID, skuID string, cost, shipping *int64, now int64) error {
	if cost == nil && shipping == nil {
		// Nothing to write. Do NOT delete: the manager has no DELETE arm, and
		// clearing a cost is a platform action, not a catalogue edit.
		return nil
	}
	if cost == nil {
		// cost_cents is NOT NULL. An UPDATE can leave it alone, but an INSERT
		// needs a value, so a first-time offer without a cost is refused rather
		// than defaulted: a zero would fail ck_sc_source_offers_cost and a
		// default would invent a price.
		return contract.Validation("请填写供货成本")
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO public.sc_source_offers
		    (source_id, sku_id, cost_cents, shipping_cost_cents, created_at_ms, updated_at_ms)
		VALUES ($1, $2, $3, $4, $5, $5)
		ON CONFLICT (source_id, sku_id)
		DO UPDATE SET cost_cents = EXCLUDED.cost_cents,
		              shipping_cost_cents = EXCLUDED.shipping_cost_cents,
		              updated_at_ms = EXCLUDED.updated_at_ms`,
		sourceID, skuID, cost, shipping, now)
	return constraint(err)
}

func rawOr(b []byte, fallback string) []byte {
	if len(b) == 0 {
		return []byte(fallback)
	}
	return b
}
