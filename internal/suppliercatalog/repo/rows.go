package catalogrepo

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/suppliercatalog/contract"
)

// rowFrom is the join every row read shares. sc_source_offers is LEFT JOINed
// on purpose: a row with no offer is a legitimate state (a manager may create
// the product before the cost is known) and must read back as a row with a
// nil platformPrice rather than disappear.
//
// Note what is NOT selected: o.cost_cents and o.shipping_cost_cents. The
// manager writes them through RowInput but never sees them again (doc 8.3),
// so they are absent from the SELECT list, from CatalogRow, and therefore
// from every JSON response.
const rowSelect = `
SELECT p.product_id, p.source_id, p.title, p.description, p.variant_group,
       p.published, p.revision, p.description_category_id, p.type_id,
       p.internal_note, p.props, p.archived, p.size, p.material, p.craft,
       p.gross_weight_g, p.brand, p.pack_width_mm, p.pack_height_mm,
       p.pack_depth_mm, p.pack_weight_g, p.contents,
       p.gallery, p.psd, p.product_videos, p.created_at_ms, p.updated_at_ms,
       s.sku_id, s.platform_code, s.lead_time, s.published,
       s.suggested_retail_cents, s.suggested_old_price_cents,
       v.price_cents,
       COALESCE(p.prompt_name, ''), COALESCE(p.prompt_file_name, ''),
       (SELECT COUNT(*) FROM public.prompt_revisions r WHERE r.product_id = p.product_id) > 0,
       EXISTS (SELECT 1 FROM public.supplier_ozon_configs c
                WHERE c.product_id = p.product_id),
       EXISTS (SELECT 1 FROM public.supplier_ozon_configs c2
                WHERE c2.product_id = p.product_id AND c2.description_category_id IS NOT NULL
                  AND c2.type_id IS NOT NULL)
  FROM public.sc_products p
  JOIN public.sc_skus s ON s.product_id = p.product_id
  LEFT JOIN LATERAL (
      SELECT price_cents FROM public.sc_price_versions pv
       WHERE pv.sku_id = s.sku_id ORDER BY pv.id DESC LIMIT 1
  ) v ON TRUE`

type rower interface{ Scan(dest ...any) error }

// scanRow reads one rowSelect row into a CatalogRow.
func scanRow(rows rower) (contract.CatalogRow, error) {
	var row contract.CatalogRow
	var productPub, skuPub bool
	var gallery, psd, videos, props []byte
	var promptName, promptFileName string
	var hasPrompt, hasConfig, hasCategory bool
	if err := rows.Scan(
		&row.ProductID, &row.SourceID, &row.Title, &row.Description, &row.VariantGroup,
		&productPub, &row.Revision, &row.DescriptionCategoryID, &row.TypeID,
		&row.InternalNote, &props, &row.Archived, &row.Size, &row.Material, &row.Craft,
		&row.GrossWeightG, &row.Brand, &row.PackWidthMM, &row.PackHeightMM,
		&row.PackDepthMM, &row.PackWeightG, &row.Contents,
		&gallery, &psd, &videos, &row.CreatedAtMS, &row.UpdatedAtMS,
		&row.SKUID, &row.PlatformCode, &row.LeadTime, &skuPub,
		&row.SuggestedRetailCents, &row.SuggestedOldPriceCents,
		&row.PlatformPriceCents,
		&promptName, &promptFileName, &hasPrompt, &hasConfig, &hasCategory,
	); err != nil {
		return contract.CatalogRow{}, constraint(err)
	}
	row.Published = productPub && skuPub
	row.Gallery = itemsGallery(gallery)
	row.PSD = itemsFiles(psd)
	row.ProductVideos = itemsVideos(videos)
	row.Props = propsOf(props)
	// Readiness is the same five gates the staff surface uses. The manager
	// cannot satisfy prompt/fixedTags/ozonConfig itself (those are staff-owned
	// arms), so a manager-created row is expected to read as not ready until
	// staff finishes it. That is the intent, not a bug.
	row.Readiness = contract.RowReadiness{
		Category:      row.DescriptionCategoryID != nil && row.TypeID != nil && hasCategory,
		Prompt:        hasPrompt,
		FixedTags:     hasPrompt,
		PlatformPrice: row.PlatformPriceCents != nil,
		OzonConfig:    hasConfig,
	}
	row.EmptyRowSlices()
	return row, nil
}

// loadRows lists the live rows of one source.
func loadRows(ctx context.Context, tx pgx.Tx, sourceID string) ([]contract.CatalogRow, error) {
	rows, err := tx.Query(ctx, rowSelect+`
	 WHERE p.source_id = $1 AND NOT p.archived
	 ORDER BY p.created_at_ms, p.product_id`, sourceID)
	if err != nil {
		return nil, constraint(err)
	}
	defer rows.Close()
	out := []contract.CatalogRow{}
	for rows.Next() {
		row, err := scanRow(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, constraint(rows.Err())
}

// loadRow reads one row. A row outside the caller's managed set is invisible
// under RLS, so this returns NotFound rather than Forbidden: the manager must
// not learn that the product exists.
func loadRow(ctx context.Context, tx pgx.Tx, sourceID, productID string) (contract.CatalogRow, error) {
	rows, err := tx.Query(ctx, rowSelect+`
	 WHERE p.source_id = $1 AND p.product_id = $2`, sourceID, productID)
	if err != nil {
		return contract.CatalogRow{}, constraint(err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return contract.CatalogRow{}, constraint(err)
		}
		return contract.CatalogRow{}, contract.NotFound()
	}
	return scanRow(rows)
}

func itemsGallery(raw []byte) []contract.GalleryItem {
	var out []contract.GalleryItem
	if len(raw) == 0 || json.Unmarshal(raw, &out) != nil || out == nil {
		return []contract.GalleryItem{}
	}
	return out
}

func itemsFiles(raw []byte) []contract.FileItem {
	var out []contract.FileItem
	if len(raw) == 0 || json.Unmarshal(raw, &out) != nil || out == nil {
		return []contract.FileItem{}
	}
	return out
}

func itemsVideos(raw []byte) []contract.VideoItem {
	var out []contract.VideoItem
	if len(raw) == 0 || json.Unmarshal(raw, &out) != nil || out == nil {
		return []contract.VideoItem{}
	}
	return out
}

func propsOf(raw []byte) map[string]json.RawMessage {
	out := map[string]json.RawMessage{}
	if len(raw) == 0 || json.Unmarshal(raw, &out) != nil || out == nil {
		return map[string]json.RawMessage{}
	}
	return out
}
