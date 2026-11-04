package catalogrepo

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/suppliercatalog/contract"
)

// writer is the write seam. It is a function so the service can be built
// without a pool in tests, and so the writer-lease refusal has one home.
type writer func(ctx context.Context, userID int64, fn func(pgx.Tx) error) error

// WithWriter replaces the default db.CatalogManager session with a writer
// that can refuse (e.g. a writer lease). Nil keeps the default.
func (r Repo) WithWriter(w writer) Repo {
	if w == nil {
		return r
	}
	r.write = w
	return r
}

func (r Repo) writeIn(ctx context.Context, userID int64, fn func(pgx.Tx) error) error {
	if r.write != nil {
		return r.write(ctx, userID, fn)
	}
	return db.InTx(ctx, r.Pool, db.CatalogManager(userID), fn)
}

// publicID reads the caller's stable external id, used as
// created_by_account_uuid. A catalog manager always has a platform account,
// so this cannot be empty in practice; the empty fallback keeps the column
// NOT NULL without inventing a value.
func publicID(ctx context.Context, tx pgx.Tx, userID int64) (string, error) {
	var pid string
	err := tx.QueryRow(ctx, `SELECT public_id FROM public.account_users WHERE id = $1`, userID).Scan(&pid)
	if err != nil {
		return "", constraint(err)
	}
	return pid, nil
}

// CreateRow is POST /api/supplier-catalog/sources/{source_id}/rows.
func (r Repo) CreateRow(ctx context.Context, userID int64, sourceID string, in contract.RowInput, now int64) (contract.CatalogRow, error) {
	var out contract.CatalogRow
	err := r.writeIn(ctx, userID, func(tx pgx.Tx) error {
		if err := r.requireManaged(ctx, tx, userID, sourceID); err != nil {
			return err
		}
		if strings.TrimSpace(in.PlatformCode) == "" {
			return contract.Validation("请填写平台货号")
		}
		if in.CostCents == nil {
			// A row with no offer shows the seller a NULL shipping cost, which
			// the portal renders as CNY 0.00. Refusing here is what keeps that
			// from happening; the cost can be filled in a later PUT, but the
			// row must not be creatable without it.
			return contract.Validation("请填写供货成本")
		}
		pid, err := publicID(ctx, tx, userID)
		if err != nil {
			return err
		}
		slug := rowSlug(sourceID, in.PlatformCode)
		productID := "prod_" + slug
		skuID := "sku_" + slug
		if err := insertProduct(ctx, tx, in, productID, sourceID, pid, now); err != nil {
			return err
		}
		skuTitle := in.Size
		if strings.TrimSpace(skuTitle) == "" {
			skuTitle = in.Title
		}
		if err := insertSKU(ctx, tx, skuID, productID, in.PlatformCode, skuTitle, in, pid, now); err != nil {
			return err
		}
		if err := upsertOffer(ctx, tx, sourceID, skuID, in.CostCents, in.ShippingCents, now); err != nil {
			return err
		}
		row, err := loadRow(ctx, tx, sourceID, productID)
		if err != nil {
			return err
		}
		out = row
		return nil
	})
	return out, err
}

// UpdateRow is PUT /api/supplier-catalog/sources/{source_id}/rows/{product_id}.
func (r Repo) UpdateRow(ctx context.Context, userID int64, sourceID, productID string, in contract.RowInput, now int64) (contract.CatalogRow, error) {
	var out contract.CatalogRow
	err := r.writeIn(ctx, userID, func(tx pgx.Tx) error {
		if err := r.requireManaged(ctx, tx, userID, sourceID); err != nil {
			return err
		}
		if err := requireRevision(in); err != nil {
			return err
		}
		var skuID string
		var published bool
		if err := tx.QueryRow(ctx, `SELECT s.sku_id, p.published FROM public.sc_skus s
			JOIN public.sc_products p ON p.product_id=s.product_id
			WHERE p.product_id=$1 AND p.source_id=$2 FOR UPDATE OF p`, productID, sourceID).Scan(&skuID, &published); err != nil {
			return constraint(err)
		}
		if published && !in.Archived && len(itemsGallery(in.Gallery)) == 0 {
			return contract.ValidationMissing("已发布规格需保留图集图片，请先停用再清空", []string{"gallery"})
		}
		if published && in.Archived {
			if err := requireSuperAdmin(ctx, tx, userID); err != nil {
				return err
			}
		}
		tag, err := tx.Exec(ctx, `
			UPDATE public.sc_products
			   SET title = $4, variant_group = $5, description = $6,
			       description_category_id = $7, type_id = $8, internal_note = $9,
			       props = $10, size = $11, material = $12, craft = $13,
			       gross_weight_g = $14, brand = $15, pack_width_mm = $16,
			       pack_height_mm = $17, pack_depth_mm = $18, pack_weight_g = $19,
			       contents = $20, gallery = $21, psd = $22, product_videos = $23,
			       archived = $24, published = published AND NOT $24,
			       revision = revision + 1, updated_at_ms = $25
			 WHERE product_id = $1 AND source_id = $2 AND revision = $3`,
			productID, sourceID, *in.ExpectedRevision, in.Title, in.VariantGroup,
			in.Description, in.DescriptionCategoryID, in.TypeID, in.InternalNote,
			rawOr(in.Props, `{}`), in.Size, in.Material, in.Craft,
			in.GrossWeightG, in.Brand, in.PackWidthMM, in.PackHeightMM,
			in.PackDepthMM, in.PackWeightG, in.Contents,
			rawOr(in.Gallery, `[]`), rawOr(in.PSD, `[]`), rawOr(in.Videos, `[]`),
			in.Archived, now)
		if err != nil {
			return constraint(err)
		}
		if tag.RowsAffected() == 0 {
			// Either the row is outside this manager's set (RLS filtered it) or
			// the revision moved. Distinguishing the two would leak existence,
			// so both answer NotFound / Conflict the same way the staff surface
			// does: re-read to decide.
			if _, err := loadRow(ctx, tx, sourceID, productID); err != nil {
				return err
			}
			return contract.Conflict("商品已被其他操作更新，请刷新后重试")
		}
		skuTitle := in.Size
		if strings.TrimSpace(skuTitle) == "" {
			skuTitle = in.Title
		}
		if _, err := tx.Exec(ctx, `
			UPDATE public.sc_skus
			   SET platform_code = $3, lead_time = $4, title = $9,
			       suggested_retail_cents = $5, suggested_old_price_cents = $6,
			       published = published AND NOT $8,
			       revision = revision + 1, updated_at_ms = $7
			 WHERE sku_id = $1 AND product_id = $2`,
			skuID, productID, in.PlatformCode, in.LeadTime, in.SuggestedRetail,
			in.SuggestedOld, now, in.Archived, skuTitle); err != nil {
			return constraint(err)
		}
		if err := upsertOffer(ctx, tx, sourceID, skuID, in.CostCents, in.ShippingCents, now); err != nil {
			return err
		}
		row, err := loadRow(ctx, tx, sourceID, productID)
		if err != nil {
			return err
		}
		out = row
		return nil
	})
	return out, err
}

// SetPublished is POST .../rows/{product_id}/publish and /unpublish.
func (r Repo) SetPublished(ctx context.Context, userID int64, sourceID, productID string, on bool, now int64) (contract.CatalogRow, error) {
	var out contract.CatalogRow
	err := r.writeIn(ctx, userID, func(tx pgx.Tx) error {
		if err := r.requireManaged(ctx, tx, userID, sourceID); err != nil {
			return err
		}
		if err := requireSuperAdmin(ctx, tx, userID); err != nil {
			return err
		}
		// Match the staff publication path's source-before-product lock order.
		var lockedSource string
		if err := tx.QueryRow(ctx, `SELECT source_id FROM public.sc_sources
			WHERE source_id = $1 FOR UPDATE`, sourceID).Scan(&lockedSource); err != nil {
			return constraint(err)
		}
		// Serialize readiness checks with row edits and archival, then read the
		// current state after any preceding mutation has committed.
		var lockedProduct string
		if err := tx.QueryRow(ctx, `SELECT product_id FROM public.sc_products
			WHERE product_id = $1 AND source_id = $2 FOR UPDATE`, productID, sourceID).Scan(&lockedProduct); err != nil {
			return constraint(err)
		}
		cur, err := loadRow(ctx, tx, sourceID, productID)
		if err != nil {
			return err
		}
		if on {
			if cur.Archived {
				return contract.Validation("归档商品不能上架")
			}
			missing := contract.MissingKeys(cur.Readiness)
			if len(cur.Gallery) == 0 {
				missing = append(missing, "gallery")
			}
			if len(missing) > 0 {
				return contract.ValidationMissing("商品尚未满足上架条件", missing)
			}
		}
		var skuID string
		if err := tx.QueryRow(ctx, `SELECT sku_id FROM public.sc_skus WHERE product_id = $1`, productID).Scan(&skuID); err != nil {
			return constraint(err)
		}
		if _, err := tx.Exec(ctx, `
			UPDATE public.sc_products SET published = $3, revision = revision + 1, updated_at_ms = $4
			 WHERE product_id = $1 AND source_id = $2`, productID, sourceID, on, now); err != nil {
			return constraint(err)
		}
		if _, err := tx.Exec(ctx, `
			UPDATE public.sc_skus SET published = $2, revision = revision + 1, updated_at_ms = $3
			 WHERE sku_id = $1`, skuID, on, now); err != nil {
			return constraint(err)
		}
		if on {
			// Only the verified super administrator may change source visibility.
			var priorStaff string
			if err := tx.QueryRow(ctx, `SELECT COALESCE(current_setting('app.staff_access', true), '')`).Scan(&priorStaff); err != nil {
				return constraint(err)
			}
			if _, err := tx.Exec(ctx, `SELECT set_config('app.staff_access', '1', true)`); err != nil {
				return constraint(err)
			}
			if _, err := tx.Exec(ctx, `
				UPDATE public.sc_sources SET listed = true, revision = revision + 1, updated_at_ms = $2
				WHERE source_id = $1 AND NOT listed`, sourceID, now); err != nil {
				return constraint(err)
			}
			if _, err := tx.Exec(ctx, `SELECT set_config('app.staff_access', $1, true)`, priorStaff); err != nil {
				return constraint(err)
			}
		}
		row, err := loadRow(ctx, tx, sourceID, productID)
		if err != nil {
			return err
		}
		out = row
		return nil
	})
	return out, err
}

// DeleteRow is DELETE .../rows/{product_id}.
//
// Soft delete only. A hard DELETE would need a delete arm on sc_source_offers
// (the manager has none) and would hit sc_skus_product_id ON DELETE RESTRICT,
// so archiving is the only shape that actually works for this role.
func (r Repo) DeleteRow(ctx context.Context, userID int64, sourceID, productID string, now int64) error {
	return r.writeIn(ctx, userID, func(tx pgx.Tx) error {
		if err := r.requireManaged(ctx, tx, userID, sourceID); err != nil {
			return err
		}
		var skuID string
		var published bool
		if err := tx.QueryRow(ctx, `SELECT s.sku_id, p.published FROM public.sc_skus s
			JOIN public.sc_products p ON p.product_id = s.product_id
			WHERE p.product_id = $1 AND p.source_id = $2 FOR UPDATE OF p`, productID, sourceID).Scan(&skuID, &published); err != nil {
			return constraint(err)
		}
		if published {
			if err := requireSuperAdmin(ctx, tx, userID); err != nil {
				return err
			}
		}
		// A delete does not take a revision: the caller may not have a fresh
		// one, and archiving an unchanged row is still the correct answer. The
		// NOT archived predicate makes a repeat DELETE a no-op instead of an
		// error, which is what a retried request needs.
		if _, err := tx.Exec(ctx, `
			UPDATE public.sc_products
			   SET archived = true, published = false, revision = revision + 1, updated_at_ms = $3
			 WHERE product_id = $1 AND source_id = $2 AND NOT archived`,
			productID, sourceID, now); err != nil {
			return constraint(err)
		}
		if _, err := tx.Exec(ctx, `
			UPDATE public.sc_skus SET published = false, revision = revision + 1, updated_at_ms = $2
			 WHERE sku_id = $1`, skuID, now); err != nil {
			return constraint(err)
		}
		return nil
	})
}

var _ = pgxpool.Pool{}
