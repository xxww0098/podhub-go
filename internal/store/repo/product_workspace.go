package storerepo

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/store/contract"
	"github.com/xxww0098/podhub-go/internal/store/domain"
)

func (r Repo) ExportProducts(ctx context.Context, orgID int64, scope []domain.Row, query domain.ProductQuery) ([]domain.ProductExportRow, *contract.APIError) {
	out := []domain.ProductExportRow{}
	if len(scope) == 0 {
		return out, nil
	}
	ids := make([]string, len(scope))
	for i, row := range scope {
		ids[i] = row.UUID
	}
	var needle any
	if query.Needle != "" {
		needle = query.Needle
	}
	err := db.InTx(ctx, r.pool, db.App(orgID), func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT p.name, p.offer_id, p.sku::text, s.name, p.price::text,
			COALESCE(NULLIF(sync.currency, ''), s.company_currency, ''), p.stock_present::text, d.state,
			p.gone_at_ms IS NOT NULL, COALESCE(NULLIF(p.refreshed_at_ms, 0), sync.last_full_sync_at_ms)
			FROM public.store_products p
			JOIN public.organization_stores s ON s.id=p.store_pk AND s.org_id=p.org_id
			JOIN public.ozon_product_status d ON d.id=p.status_id
			LEFT JOIN public.store_product_sync sync ON sync.store_id=s.uuid AND sync.org_id=s.org_id
			WHERE p.org_id=$1 AND s.uuid=ANY($2::uuid[]) AND s.deleted_at_ms IS NULL
			AND `+statusPredicate(query.Status)+` AND `+gonePredicate(query)+`
			AND ($3::text IS NULL OR lower(p.offer_id || ' ' || COALESCE(p.name,'')) LIKE '%' || $3 || '%' ESCAPE '\')
			ORDER BY s.uuid, p.product_id LIMIT $4`, orgID, ids, needle, domain.MaxProductExportRows+1)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			if len(out) == domain.MaxProductExportRows {
				return contract.ProductExportTooLarge()
			}
			var row domain.ProductExportRow
			if err := rows.Scan(&row.Name, &row.OfferID, &row.SKU, &row.StoreName, &row.Price,
				&row.Currency, &row.Stock, &row.State, &row.Gone, &row.SnapshotAtMS); err != nil {
				return err
			}
			out = append(out, row)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, asAPIError(err, contract.MsgUnavailable)
	}
	return out, nil
}
