package supplyrepo

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/platform/writer"
	"github.com/xxww0098/podhub-go/internal/supply/contract"
)

const productSelect = `
SELECT p.product_id, p.title, p.description,
       CASE WHEN p.media = '[]'::jsonb
            THEN jsonb_path_query_array(p.gallery, '$[*].url')
            ELSE p.media END AS media,
       p.specs
FROM public.sc_products p
INNER JOIN public.sc_sources src ON src.source_id = p.source_id
WHERE p.published AND (src.listed OR p.source_id = 'src_unassigned')`

const skuFrom = `
FROM public.sc_skus s
LEFT JOIN LATERAL (
    SELECT id, price_cents FROM public.sc_price_versions
    WHERE sku_id = s.sku_id ORDER BY id DESC LIMIT 1
) p ON true
LEFT JOIN public.shipping_sku_bindings b ON b.sku_id = s.sku_id
LEFT JOIN public.shipping_presets sp ON sp.preset_id = b.preset_id`

func (r Repo) PublicCatalog(ctx context.Context) (contract.PublicCatalogData, error) {
	var out contract.PublicCatalogData
	err := r.tx(ctx, 0, func(tx pgx.Tx) error {
		products, err := r.loadProducts(ctx, tx, productSelect+` ORDER BY p.created_at_ms, p.product_id`)
		if err != nil {
			return err
		}
		skus, err := r.loadSKUs(ctx, tx, `
			SELECT s.sku_id, s.product_id, s.platform_code, s.title, s.media, s.specs, s.lead_time, p.price_cents
			`+skuFrom+`
			INNER JOIN public.sc_products pr ON pr.product_id = s.product_id
			INNER JOIN public.sc_sources src ON src.source_id = pr.source_id
			WHERE s.published AND p.price_cents IS NOT NULL
			  AND (src.listed OR pr.source_id = 'src_unassigned')
			ORDER BY s.created_at_ms, s.sku_id`)
		if err != nil {
			return err
		}
		out.Products = make([]contract.PublicProduct, 0, len(products))
		for _, product := range products {
			item := contract.PublicProduct{
				ProductID: product.id, Title: product.title, Description: product.description,
				Media: product.media, Specs: product.specs, SKUs: []contract.PublicSKU{},
			}
			for _, sku := range skus {
				if sku.productID != product.id {
					continue
				}
				item.SKUs = append(item.SKUs, contract.PublicSKU{
					SKUID: sku.id, PlatformCode: sku.code, Title: sku.title,
					Media: sku.media, Specs: sku.specs, LeadTime: sku.lead,
				})
			}
			out.Products = append(out.Products, item)
		}
		return nil
	})
	return out, err
}

func (r Repo) SellerCatalog(ctx context.Context, orgID int64) (contract.SellerCatalogData, error) {
	var out contract.SellerCatalogData
	err := r.tx(ctx, orgID, func(tx pgx.Tx) error {
		products, skus, err := r.sellerLists(ctx, tx)
		if err != nil {
			return err
		}
		out.Products = groupSeller(products, skus)
		return nil
	})
	return out, err
}

func (r Repo) SellerProduct(ctx context.Context, orgID int64, productID string) (contract.SellerProduct, error) {
	var out contract.SellerProduct
	err := r.tx(ctx, orgID, func(tx pgx.Tx) error {
		products, err := r.loadProducts(ctx, tx, productSelect+` AND p.product_id = $1`, productID)
		if err != nil {
			return err
		}
		if len(products) != 1 {
			if len(products) == 0 {
				return fail(404, "NOT_FOUND", "记录不存在或未上架")
			}
			return fail(500, "INTERNAL", "服务暂不可用")
		}
		skus, err := r.loadSKUs(ctx, tx, `
			SELECT s.sku_id, s.product_id, s.platform_code, s.title, s.media, s.specs, s.lead_time, p.price_cents
			`+skuFrom+`
			WHERE s.product_id = $1 AND s.published AND p.price_cents IS NOT NULL
			ORDER BY s.created_at_ms, s.sku_id`, productID)
		if err != nil {
			return err
		}
		out = groupSeller(products, skus)[0]
		return nil
	})
	return out, err
}

func (r Repo) SellerSKU(ctx context.Context, orgID int64, skuID string) (contract.SellerSKU, error) {
	var out contract.SellerSKU
	err := r.tx(ctx, orgID, func(tx pgx.Tx) error {
		skus, err := r.loadSKUs(ctx, tx, `
			SELECT s.sku_id, s.product_id, s.platform_code, s.title, s.media, s.specs, s.lead_time, p.price_cents
			`+skuFrom+`
			INNER JOIN public.sc_products pr ON pr.product_id = s.product_id
			INNER JOIN public.sc_sources src ON src.source_id = pr.source_id
			WHERE s.sku_id = $1 AND s.published AND pr.published
			  AND p.price_cents IS NOT NULL
			  AND (src.listed OR pr.source_id = 'src_unassigned')`, skuID)
		if err != nil {
			return err
		}
		if len(skus) != 1 {
			if len(skus) == 0 {
				return fail(404, "NOT_FOUND", "记录不存在或未上架")
			}
			return fail(500, "INTERNAL", "服务暂不可用")
		}
		out = sellerSKU(skus[0])
		return nil
	})
	return out, err
}

type productRow struct {
	id, title, description string
	media                  []string
	specs                  contract.Object
}

type skuRow struct {
	id, productID, code, title, lead string
	media                            []string
	specs                            contract.Object
	price                            int64
}

func (r Repo) sellerLists(ctx context.Context, tx pgx.Tx) ([]productRow, []skuRow, error) {
	products, err := r.loadProducts(ctx, tx, productSelect+` ORDER BY p.created_at_ms, p.product_id`)
	if err != nil {
		return nil, nil, err
	}
	skus, err := r.loadSKUs(ctx, tx, `
		SELECT s.sku_id, s.product_id, s.platform_code, s.title, s.media, s.specs, s.lead_time, p.price_cents
		`+skuFrom+`
		INNER JOIN public.sc_products pr ON pr.product_id = s.product_id
		INNER JOIN public.sc_sources src ON src.source_id = pr.source_id
		WHERE s.published AND p.price_cents IS NOT NULL
		  AND (src.listed OR pr.source_id = 'src_unassigned')
		ORDER BY s.created_at_ms, s.sku_id`)
	return products, skus, err
}

func groupSeller(products []productRow, skus []skuRow) []contract.SellerProduct {
	out := make([]contract.SellerProduct, 0, len(products))
	for _, product := range products {
		item := contract.SellerProduct{
			ProductID: product.id, Title: product.title, Media: product.media, Specs: product.specs,
			Publication: "published", SKUs: []contract.SellerSKU{},
		}
		for _, sku := range skus {
			if sku.productID == product.id {
				item.SKUs = append(item.SKUs, sellerSKU(sku))
			}
		}
		out = append(out, item)
	}
	return out
}

func sellerSKU(sku skuRow) contract.SellerSKU {
	return contract.SellerSKU{
		SKUID: sku.id, PlatformCode: sku.code, Title: sku.title, Media: sku.media, Specs: sku.specs,
		PlatformPriceCents: sku.price, Available: true, Publication: "published", LeadTime: sku.lead,
	}
}

func (r Repo) loadProducts(ctx context.Context, tx pgx.Tx, sql string, args ...any) ([]productRow, error) {
	rows, err := tx.Query(ctx, sql, args...)
	if err != nil {
		return nil, mapDB(err)
	}
	defer rows.Close()
	out := []productRow{}
	for rows.Next() {
		var item productRow
		var media, specs []byte
		if err := rows.Scan(&item.id, &item.title, &item.description, &media, &specs); err != nil {
			return nil, mapDB(err)
		}
		item.media = jsonStrings(media)
		item.specs = jsonSpecs(specs)
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, mapDB(err)
	}
	return out, nil
}

func (r Repo) loadSKUs(ctx context.Context, tx pgx.Tx, sql string, args ...any) ([]skuRow, error) {
	rows, err := tx.Query(ctx, sql, args...)
	if err != nil {
		return nil, mapDB(err)
	}
	defer rows.Close()
	out := []skuRow{}
	for rows.Next() {
		var item skuRow
		var media, specs []byte
		if err := rows.Scan(&item.id, &item.productID, &item.code, &item.title, &media, &specs, &item.lead, &item.price); err != nil {
			return nil, mapDB(err)
		}
		item.media = jsonStrings(media)
		item.specs = jsonSpecs(specs)
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, mapDB(err)
	}
	return out, nil
}

func (r Repo) tx(ctx context.Context, orgID int64, fn func(pgx.Tx) error) error {
	if r.pool == nil || r.begin == nil {
		return fail(500, "INTERNAL", "服务暂不可用")
	}
	tx, err := r.begin(ctx, r.pool.Begin, orgID)
	if err != nil {
		return mapDB(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	defer writer.Forget(tx)
	if err := fn(tx); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return mapDB(err)
	}
	return nil
}
