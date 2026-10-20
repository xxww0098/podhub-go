package supplierrepo

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/supplier/contract"
	"github.com/xxww0098/podhub-go/internal/supplier/domain"
)

func (r Repo) Catalog(ctx context.Context, nowMs int64) (contract.CatalogData, error) {
	var out contract.CatalogData
	if r.pool == nil || r.begin == nil {
		return out, contract.ErrUnavailable
	}
	tx, err := r.begin(ctx, r.pool.Begin, 0)
	if err != nil {
		return out, mapDB(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	dbs, err := r.listedSources(ctx, tx)
	if err != nil {
		return out, err
	}
	props, visible, err := r.propDefs(ctx, tx)
	if err != nil {
		return out, err
	}
	rows, err := r.sellerRows(ctx, tx, visible, nowMs)
	if err != nil {
		return out, err
	}
	if err := tx.Commit(ctx); err != nil {
		return out, mapDB(err)
	}
	out.DBs = dbs
	out.PropDefs = props
	out.Rows = rows
	return out, nil
}

func (r Repo) listedSources(ctx context.Context, tx pgx.Tx) ([]contract.SourceCard, error) {
	rows, err := tx.Query(ctx, `
		SELECT source_id, name, country, icon
		FROM sc_sources
		WHERE listed
		ORDER BY created_at_ms, source_id`)
	if err != nil {
		return nil, mapDB(err)
	}
	defer rows.Close()
	out := []contract.SourceCard{}
	for rows.Next() {
		var card contract.SourceCard
		if err := rows.Scan(&card.SourceID, &card.Name, &card.Country, &card.Icon); err != nil {
			return nil, mapDB(err)
		}
		out = append(out, card)
	}
	return out, rows.Err()
}

func (r Repo) propDefs(ctx context.Context, tx pgx.Tx) ([]contract.PropDef, map[string]map[string]struct{}, error) {
	rows, err := tx.Query(ctx, `
		SELECT prop_id, source_id, name, type, options, position, seller_visible, created_at_ms, updated_at_ms
		FROM sc_source_prop_defs d
		WHERE d.seller_visible
		  AND EXISTS (SELECT 1 FROM sc_sources s WHERE s.source_id = d.source_id AND s.listed)
		ORDER BY d.source_id, d.position, d.prop_id`)
	if err != nil {
		return nil, nil, mapDB(err)
	}
	defer rows.Close()
	out := []contract.PropDef{}
	visible := map[string]map[string]struct{}{}
	for rows.Next() {
		var def contract.PropDef
		var options []byte
		if err := rows.Scan(&def.PropID, &def.SourceID, &def.Name, &def.Type, &options, &def.Position, &def.SellerVisible, &def.CreatedAtMs, &def.UpdatedAtMs); err != nil {
			return nil, nil, mapDB(err)
		}
		def.Options = []contract.PropOption{}
		_ = json.Unmarshal(options, &def.Options)
		if def.Options == nil {
			def.Options = []contract.PropOption{}
		}
		out = append(out, def)
		set := visible[def.SourceID]
		if set == nil {
			set = map[string]struct{}{}
			visible[def.SourceID] = set
		}
		set[def.PropID] = struct{}{}
	}
	return out, visible, rows.Err()
}

func (r Repo) sellerRows(ctx context.Context, tx pgx.Tx, visible map[string]map[string]struct{}, nowMs int64) ([]contract.CatalogRow, error) {
	rows, err := tx.Query(ctx, sellerRowSQL)
	if err != nil {
		return nil, mapDB(err)
	}
	defer rows.Close()
	out := []contract.CatalogRow{}
	for rows.Next() {
		row, err := scanSellerRow(rows, visible, nowMs)
		if err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

type scannable interface {
	Scan(dest ...any) error
}

func scanSellerRow(rows scannable, visible map[string]map[string]struct{}, nowMs int64) (contract.CatalogRow, error) {
	var row contract.CatalogRow
	var gallery, videos, tags, props []byte
	var configState, validated, current *string
	var fetched *int64
	var sourceListed, archived, skuPublished bool
	var prompt string
	if err := rows.Scan(
		&row.ProductID, &row.SourceID, &row.Title, &row.Description, &row.VariantGroup,
		&prompt, &gallery, &videos, &tags, &props,
		&configState, &validated, &current, &fetched, &sourceListed,
		&row.DescriptionCategoryID, &row.TypeID,
		&row.Size, &row.Material, &row.Craft, &row.GrossWeightG,
		&row.Brand, &row.PackWidthMm, &row.PackHeightMm, &row.PackDepthMm, &row.PackWeightG, &row.Contents,
		&archived, &row.PlatformCode, &row.LeadTime, &skuPublished,
		&row.SuggestedRetailCents, &row.SuggestedOldPriceCents, &row.ListedAtMs,
		&row.ShippingCostCents, &row.PlatformPriceCents,
	); err != nil {
		return row, mapDB(err)
	}
	fresh := "fresh"
	if fetched != nil {
		fresh = domain.Freshness(*fetched, nowMs)
	}
	denial := domain.Denial(domain.ListabilityFacts{
		SourceListed: sourceListed, ProductArchived: archived, SKUPublished: skuPublished,
		PromptValid: false, // ocr_prompt::validate_brief body is not in the spec.
		ConfigState: domain.ConfigState(configState), ValidatedDigest: validated,
		CurrentDigest: current, Freshness: fresh,
	})
	row.Listable = denial == ""
	if denial != "" {
		row.Denial = &denial
	}
	row.Gallery = decodeGallery(gallery)
	row.ProductVideos = decodeVideos(videos)
	row.FixedTags = decodeStrings(tags)
	row.Props = filterProps(props, visible[row.SourceID])
	_ = prompt
	return row, nil
}

const sellerRowSQL = `
SELECT p.product_id, p.source_id, p.title, p.description, p.variant_group,
       COALESCE(m.prompt_text, ''),
       p.gallery, p.product_videos,
       COALESCE(prompt_latest.fixed_tags, m.fixed_tags, '[]'::jsonb),
       p.props,
       c.state, c.validated_catalog_digest, cat.content_digest, cat.fetched_at_ms,
       src.listed,
       p.description_category_id, p.type_id,
       p.size, p.material, p.craft, p.gross_weight_g,
       p.brand, p.pack_width_mm, p.pack_height_mm, p.pack_depth_mm, p.pack_weight_g, p.contents,
       p.archived,
       s.platform_code, s.lead_time, s.published,
       s.suggested_retail_cents, s.suggested_old_price_cents, s.updated_at_ms,
       o.shipping_cost_cents, v.price_cents
FROM sc_products p
JOIN sc_sources src ON src.source_id = p.source_id
JOIN sc_skus s ON s.product_id = p.product_id
LEFT JOIN supplier_ozon_configs m ON m.product_id = p.product_id
LEFT JOIN LATERAL (
    SELECT fixed_tags FROM prompt_revisions r
    WHERE r.product_id = p.product_id ORDER BY r.revision DESC LIMIT 1
) prompt_latest ON TRUE
LEFT JOIN supplier_ozon_configs c
       ON c.product_id = p.product_id
      AND c.description_category_id = p.description_category_id
      AND c.type_id = p.type_id
LEFT JOIN ozon_category_current cat
       ON cat.description_category_id = c.description_category_id
     AND cat.type_id = c.type_id AND cat.language = c.language
LEFT JOIN sc_source_offers o ON o.source_id = p.source_id AND o.sku_id = s.sku_id
LEFT JOIN LATERAL (
    SELECT price_cents FROM sc_price_versions pv WHERE pv.sku_id = s.sku_id ORDER BY pv.id DESC LIMIT 1
) v ON TRUE
WHERE p.published AND s.published AND NOT p.archived AND src.listed
ORDER BY p.updated_at_ms DESC, p.product_id`

func decodeGallery(raw []byte) []contract.GalleryItem {
	var out []contract.GalleryItem
	if json.Unmarshal(raw, &out) != nil || out == nil {
		return []contract.GalleryItem{}
	}
	return out
}

func decodeVideos(raw []byte) []contract.VideoItem {
	var out []contract.VideoItem
	if json.Unmarshal(raw, &out) != nil || out == nil {
		return []contract.VideoItem{}
	}
	return out
}

func decodeStrings(raw []byte) []string {
	var out []string
	if json.Unmarshal(raw, &out) != nil || out == nil {
		return []string{}
	}
	return out
}

func filterProps(raw []byte, allow map[string]struct{}) contract.Object {
	var all map[string]any
	if json.Unmarshal(raw, &all) != nil || all == nil {
		return contract.Object{}
	}
	out := contract.Object{}
	for k, v := range all {
		if _, ok := allow[k]; ok {
			out[k] = v
		}
	}
	return out
}
