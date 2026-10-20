package x1repo

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5"

	contract "github.com/xxww0098/podhub-go/internal/admin/core/contract/outcome"
	corerepo "github.com/xxww0098/podhub-go/internal/admin/core/repo"
	x1contract "github.com/xxww0098/podhub-go/internal/admin/x1/contract"
)

const (
	pathRowCreate     = "/api/admin/supplier-dbs/{source_id}/rows"
	pathRow           = "/api/admin/supplier-dbs/{source_id}/rows/{product_id}"
	pathPrice         = "/api/admin/supplier-dbs/{source_id}/rows/{product_id}/price"
	pathPublish       = "/api/admin/supplier-dbs/{source_id}/rows/{product_id}/publish"
	pathUnpublish     = "/api/admin/supplier-dbs/{source_id}/rows/{product_id}/unpublish"
	pathOzon          = "/api/admin/supplier-dbs/{source_id}/rows/{product_id}/ozon-config"
	pathPromptPublish = "/api/admin/supplier-dbs/{source_id}/rows/{product_id}/prompt/publish"
	pathPromptPatch   = "/api/admin/supplier-prompts/{product_id}"
	pathPromptSync    = "/api/admin/supplier-prompts/sync"
	rowFrom           = `
FROM public.sc_products p
JOIN public.sc_sources src ON src.source_id = p.source_id
JOIN public.sc_skus s ON s.product_id = p.product_id
LEFT JOIN public.supplier_ozon_configs m ON m.product_id = p.product_id
LEFT JOIN LATERAL (
    SELECT brief, fixed_tags, revision, ai_output
    FROM public.prompt_revisions r
    WHERE r.product_id = p.product_id
    ORDER BY r.revision DESC
    LIMIT 1
) prompt_latest ON TRUE
LEFT JOIN public.supplier_ozon_configs c
       ON c.product_id = p.product_id
      AND c.description_category_id = p.description_category_id
      AND c.type_id = p.type_id
LEFT JOIN public.ozon_category_current cat
       ON cat.description_category_id = c.description_category_id
      AND cat.type_id = c.type_id AND cat.language = c.language
LEFT JOIN public.sc_source_offers o
       ON o.source_id = p.source_id AND o.sku_id = s.sku_id
LEFT JOIN LATERAL (
    SELECT price_cents FROM public.sc_price_versions pv
    WHERE pv.sku_id = s.sku_id ORDER BY pv.id DESC LIMIT 1
) v ON TRUE`
)

const rowSelect = `
SELECT p.product_id, p.source_id, p.title, p.description, p.variant_group,
       p.published, p.revision, p.prompt_name, p.prompt_file_name,
       COALESCE(prompt_latest.brief, m.prompt_text, '') ,
       COALESCE(prompt_latest.fixed_tags, m.fixed_tags, '[]'::jsonb),
       COALESCE(m.prompt_text, ''),
       COALESCE(m.fixed_tags, '[]'::jsonb),
       prompt_latest.revision, m.published_revision,
       p.product_videos, p.gallery, p.psd,
       c.state, c.validated_catalog_digest, cat.content_digest, cat.fetched_at_ms,
       src.listed, p.description_category_id, p.type_id, p.internal_note, p.props, p.archived,
       p.size, p.material, p.craft, p.gross_weight_g, p.brand,
       p.pack_width_mm, p.pack_height_mm, p.pack_depth_mm, p.pack_weight_g, p.contents,
       p.created_at_ms, p.updated_at_ms, p.created_by_account_uuid,
       (SELECT profile.name FROM public.account_users creator
          JOIN public.account_profiles profile ON profile.user_id = creator.id
         WHERE creator.public_id = p.created_by_account_uuid),
       s.sku_id, s.platform_code, s.lead_time, s.published,
       s.suggested_retail_cents, s.suggested_old_price_cents,
       o.cost_cents, o.shipping_cost_cents, v.price_cents` + rowFrom

func (r X1) Detail(ctx context.Context, actor contract.Actor, sourceID string, now int64) (x1contract.DbDetail, error) {
	var out x1contract.DbDetail
	err := r.withRead(ctx, actor.OrgID, func(tx pgx.Tx) error {
		_, owner, err := r.identity(ctx, tx, actor)
		if err != nil {
			return err
		}
		if err := corerepo.RequireSource(ctx, tx, sourceID, owner); err != nil {
			return err
		}
		dbs, err := corerepo.ListDbs(ctx, tx, owner, sourceID)
		if err != nil {
			return err
		}
		if len(dbs) != 1 {
			return corerepo.NotFound(corerepo.MissingRow)
		}
		props, err := listProps(ctx, tx, sourceID)
		if err != nil {
			return err
		}
		rows, err := loadRows(ctx, tx, sourceID, now)
		if err != nil {
			return err
		}
		out = x1contract.DbDetail{DB: dbs[0], PropDefs: props, Rows: rows}
		return nil
	})
	return out, err
}

func (r X1) CreateRow(ctx context.Context, actor contract.Actor, sourceID string, in x1contract.RowInput, productID, skuID, code string, now int64) (x1contract.RowData, error) {
	var out x1contract.RowData
	err := r.withWrite(ctx, actor.OrgID, func(tx pgx.Tx) error {
		publicID, owner, err := r.identity(ctx, tx, actor)
		if err != nil {
			return err
		}
		if err := corerepo.RequireSource(ctx, tx, sourceID, owner); err != nil {
			return err
		}
		if _, err := corerepo.LockSource(ctx, tx, sourceID); err != nil {
			return err
		}
		if err := insertProduct(ctx, tx, in, productID, sourceID, publicID, now); err != nil {
			return err
		}
		skuTitle := in.Size
		if strings.TrimSpace(skuTitle) == "" {
			skuTitle = in.Title
		}
		if err := insertSKU(ctx, tx, skuID, productID, code, skuTitle, in, publicID, now); err != nil {
			return err
		}
		if err := upsertOffer(ctx, tx, sourceID, skuID, in.CostCents, in.ShippingCents, now); err != nil {
			return err
		}
		if err := writeRowConfig(ctx, tx, actor, sourceID, productID, in.PromptContent, in.FixedTags, publicID, now); err != nil {
			return err
		}
		if err := corerepo.AuditApplied(ctx, tx, actor, "supplier_dbs", "supplier_db", productID, "POST", pathRowCreate, "sc_source_row_created", x1contract.JSONText(struct {
			SourceID string `json:"sourceId"`
			SKU      string `json:"skuId"`
		}{sourceID, skuID})); err != nil {
			return err
		}
		out, err = loadRow(ctx, tx, sourceID, productID, now)
		return err
	})
	return out, err
}

func (r X1) UpdateRow(ctx context.Context, actor contract.Actor, sourceID, productID string, in x1contract.RowInput, now int64) (x1contract.RowData, error) {
	var out x1contract.RowData
	err := r.withWrite(ctx, actor.OrgID, func(tx pgx.Tx) error {
		publicID, owner, err := r.identity(ctx, tx, actor)
		if err != nil {
			return err
		}
		if err := corerepo.RequireSource(ctx, tx, sourceID, owner); err != nil {
			return err
		}
		if _, err := corerepo.LockSource(ctx, tx, sourceID); err != nil {
			return err
		}
		sku, _, err := corerepo.LockProduct(ctx, tx, sourceID, productID)
		if err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `
			UPDATE public.sc_products
			SET title = $4, variant_group = $21, description = $5,
			    prompt_name = $6, prompt_file_name = $7, product_videos = $8,
			    gallery = $9, psd = $10, description_category_id = $11,
			    type_id = $12, internal_note = $13, props = $14,
			    size = $17, gross_weight_g = $18, material = $19, craft = $20,
			    brand = $22, pack_width_mm = $23, pack_height_mm = $24,
			    pack_depth_mm = $25, pack_weight_g = $26, contents = $27,
			    archived = $16, published = published AND NOT $16,
			    revision = revision + 1, updated_at_ms = $15
			WHERE product_id = $1 AND source_id = $2 AND revision = $3`,
			productID, sourceID, *in.ExpectedRevision, in.Title, in.Description,
			in.PromptName, in.PromptFileName, rawOr(in.Videos, `[]`), rawOr(in.Gallery, `[]`), rawOr(in.PSD, `[]`),
			in.DescriptionCategoryID, in.TypeID, in.InternalNote, rawOr(in.Props, `{}`), now, in.Archived,
			in.Size, in.GrossWeightG, in.Material, in.Craft, in.VariantGroup, in.Brand,
			in.PackWidthMM, in.PackHeightMM, in.PackDepthMM, in.PackWeightG, in.Contents)
		if err != nil {
			return rowConstraint(err)
		}
		if tag.RowsAffected() == 0 {
			return rowMissing(ctx, tx, sourceID, productID)
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
			sku, productID, in.PlatformCode, in.LeadTime, in.SuggestedRetail, in.SuggestedOld, now, in.Archived, skuTitle); err != nil {
			return rowConstraint(err)
		}
		if err := upsertOffer(ctx, tx, sourceID, sku, in.CostCents, in.ShippingCents, now); err != nil {
			return err
		}
		if err := writeRowConfig(ctx, tx, actor, sourceID, productID, in.PromptContent, in.FixedTags, publicID, now); err != nil {
			return err
		}
		if err := corerepo.AuditApplied(ctx, tx, actor, "supplier_dbs", "supplier_db", productID, "PUT", pathRow, "sc_source_row_updated", x1contract.JSONText(struct {
			SourceID string `json:"sourceId"`
			SKU      string `json:"skuId"`
		}{sourceID, sku})); err != nil {
			return err
		}
		out, err = loadRow(ctx, tx, sourceID, productID, now)
		return err
	})
	return out, err
}

func (r X1) AdjustPrice(ctx context.Context, actor contract.Actor, sourceID, productID string, cents int64, note string, now int64) (x1contract.RowData, error) {
	var out x1contract.RowData
	err := r.withWrite(ctx, actor.OrgID, func(tx pgx.Tx) error {
		publicID, owner, err := r.identity(ctx, tx, actor)
		if err != nil {
			return err
		}
		if err := corerepo.RequireSource(ctx, tx, sourceID, owner); err != nil {
			return err
		}
		if _, err := corerepo.LockSource(ctx, tx, sourceID); err != nil {
			return err
		}
		sku, _, err := corerepo.LockProduct(ctx, tx, sourceID, productID)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO public.sc_price_versions (sku_id, price_cents, created_at_ms, created_by_account_uuid)
			VALUES ($1, $2, $3, $4)`, sku, cents, now, publicID); err != nil {
			return corerepo.MapDB(err)
		}
		if _, err := tx.Exec(ctx, `UPDATE public.sc_products SET revision = revision + 1, updated_at_ms = $3 WHERE product_id = $1 AND source_id = $2`, productID, sourceID, now); err != nil {
			return corerepo.MapDB(err)
		}
		if _, err := tx.Exec(ctx, `UPDATE public.sc_skus SET revision = revision + 1, updated_at_ms = $2 WHERE sku_id = $1`, sku, now); err != nil {
			return corerepo.MapDB(err)
		}
		if err := corerepo.AuditApplied(ctx, tx, actor, "supplier_dbs", "supplier_db", productID, "POST", pathPrice, "sc_source_row_price_adjusted", x1contract.JSONText(struct {
			SourceID string `json:"sourceId"`
			SKU      string `json:"skuId"`
			Cents    int64  `json:"priceCents"`
			Note     string `json:"note"`
		}{sourceID, sku, cents, note})); err != nil {
			return err
		}
		out, err = loadRow(ctx, tx, sourceID, productID, now)
		return err
	})
	return out, err
}

func (r X1) SetPublished(ctx context.Context, actor contract.Actor, sourceID, productID string, on bool, now int64) (x1contract.RowData, error) {
	var out x1contract.RowData
	err := r.withWrite(ctx, actor.OrgID, func(tx pgx.Tx) error {
		_, owner, err := r.identity(ctx, tx, actor)
		if err != nil {
			return err
		}
		if err := corerepo.RequireSource(ctx, tx, sourceID, owner); err != nil {
			return err
		}
		if _, err := corerepo.LockSource(ctx, tx, sourceID); err != nil {
			return err
		}
		sku, _, err := corerepo.LockProduct(ctx, tx, sourceID, productID)
		if err != nil {
			return err
		}
		if on {
			cur, err := loadRow(ctx, tx, sourceID, productID, now)
			if err != nil {
				return err
			}
			if cur.Archived {
				return &contract.Fail{Kind: contract.KindValidation, Message: "归档商品不能上架"}
			}
			missing := x1contract.MissingKeys(cur.Readiness)
			if len(missing) > 0 {
				return &contract.Fail{Kind: contract.KindValidation, Message: "商品尚未满足上架条件", Missing: missing}
			}
		}
		if _, err := tx.Exec(ctx, `
			UPDATE public.sc_products SET published = $3, revision = revision + 1, updated_at_ms = $4
			WHERE product_id = $1 AND source_id = $2`, productID, sourceID, on, now); err != nil {
			return corerepo.MapDB(err)
		}
		if _, err := tx.Exec(ctx, `
			UPDATE public.sc_skus SET published = $2, revision = revision + 1, updated_at_ms = $3
			WHERE sku_id = $1`, sku, on, now); err != nil {
			return corerepo.MapDB(err)
		}
		action, path := "sc_source_row_unpublished", pathUnpublish
		if on {
			action, path = "sc_source_row_published", pathPublish
		}
		if err := corerepo.AuditApplied(ctx, tx, actor, "supplier_dbs", "supplier_db", productID, "POST", path, action, x1contract.JSONText(struct {
			SourceID string `json:"sourceId"`
			SKU      string `json:"skuId"`
		}{sourceID, sku})); err != nil {
			return err
		}
		out, err = loadRow(ctx, tx, sourceID, productID, now)
		return err
	})
	return out, err
}

func (r X1) Referenced(ctx context.Context, actor contract.Actor, suffixes []string) (bool, error) {
	var hit bool
	err := r.withRead(ctx, actor.OrgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT EXISTS (
			  SELECT 1
			    FROM public.sc_products AS product
			    CROSS JOIN LATERAL jsonb_array_elements(
			        COALESCE(product.gallery, '[]'::jsonb)
			        || COALESCE(product.psd, '[]'::jsonb)
			        || COALESCE(product.product_videos, '[]'::jsonb)
			    ) AS object_ref
			    CROSS JOIN unnest($1::text[]) AS wanted(suffix)
			   WHERE right(object_ref->>'url', length(wanted.suffix)) = wanted.suffix
			      OR right(object_ref->>'coverUrl', length(wanted.suffix)) = wanted.suffix
			)`, suffixes).Scan(&hit)
	})
	return hit, err
}

func (r X1) Banned(ctx context.Context, actor contract.Actor) ([]string, error) {
	var terms []string
	err := r.withRead(ctx, actor.OrgID, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT term FROM public.banned_tags WHERE enabled ORDER BY id`)
		if err != nil {
			return corerepo.MapDB(err)
		}
		defer rows.Close()
		for rows.Next() {
			var term string
			if err := rows.Scan(&term); err != nil {
				return corerepo.MapDB(err)
			}
			terms = append(terms, term)
		}
		return corerepo.MapDB(rows.Err())
	})
	if terms == nil {
		terms = []string{}
	}
	return terms, err
}
