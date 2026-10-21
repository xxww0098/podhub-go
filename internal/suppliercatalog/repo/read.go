package catalogrepo

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/suppliercatalog/contract"
)

// requireManaged refuses a source the caller does not actively manage.
//
// This is a SECOND fence, not the authorization. RLS already filters every
// row to the managed set; this check exists so a caller gets a 403 for a
// source that exists but is not theirs, instead of an empty 200 that looks
// like a source with no rows. The two answers mean different things to the UI.
func (r Repo) requireManaged(ctx context.Context, tx pgx.Tx, userID int64, sourceID string) error {
	var ok bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM public.sc_catalog_managers m
		                WHERE m.source_id = $1 AND m.user_id = $2 AND m.status = 'active')`,
		sourceID, userID).Scan(&ok); err != nil {
		return constraint(err)
	}
	if !ok {
		return contract.Forbidden()
	}
	return nil
}

// Detail is GET /api/supplier-catalog/sources/{source_id}.
func (r Repo) Detail(ctx context.Context, userID int64, sourceID string) (contract.SourceDetail, error) {
	var out contract.SourceDetail
	err := r.read(ctx, userID, func(tx pgx.Tx) error {
		if err := r.requireManaged(ctx, tx, userID, sourceID); err != nil {
			return err
		}
		managed, err := r.managed(ctx, tx, userID)
		if err != nil {
			return err
		}
		src, ok := managed[sourceID]
		if !ok {
			return contract.NotFound()
		}
		props, err := listProps(ctx, tx, sourceID)
		if err != nil {
			return err
		}
		rows, err := loadRows(ctx, tx, sourceID)
		if err != nil {
			return err
		}
		out = contract.SourceDetail{Source: src, PropDefs: props, Rows: rows}
		return nil
	})
	return out, err
}

// Rows is GET /api/supplier-catalog/sources/{source_id}/rows.
func (r Repo) Rows(ctx context.Context, userID int64, sourceID string) (contract.RowListData, error) {
	var out contract.RowListData
	err := r.read(ctx, userID, func(tx pgx.Tx) error {
		if err := r.requireManaged(ctx, tx, userID, sourceID); err != nil {
			return err
		}
		rows, err := loadRows(ctx, tx, sourceID)
		if err != nil {
			return err
		}
		out.Rows = rows
		return nil
	})
	return out, err
}

// Row is GET /api/supplier-catalog/sources/{source_id}/rows/{product_id}.
func (r Repo) Row(ctx context.Context, userID int64, sourceID, productID string) (contract.CatalogRow, error) {
	var out contract.CatalogRow
	err := r.read(ctx, userID, func(tx pgx.Tx) error {
		if err := r.requireManaged(ctx, tx, userID, sourceID); err != nil {
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

func listProps(ctx context.Context, tx pgx.Tx, sourceID string) ([]contract.PropDef, error) {
	rows, err := tx.Query(ctx, `
		SELECT prop_id, source_id, name, type, options, position, seller_visible,
		       created_at_ms, updated_at_ms
		  FROM public.sc_source_prop_defs WHERE source_id = $1
		 ORDER BY position, prop_id`, sourceID)
	if err != nil {
		return nil, constraint(err)
	}
	defer rows.Close()
	out := []contract.PropDef{}
	for rows.Next() {
		var p contract.PropDef
		var options []byte
		if err := rows.Scan(&p.PropID, &p.SourceID, &p.Name, &p.Type, &options,
			&p.Position, &p.SellerVisible, &p.CreatedAtMS, &p.UpdatedAtMS); err != nil {
			return nil, constraint(err)
		}
		p.Options = propOptions(options)
		out = append(out, p)
	}
	return out, constraint(rows.Err())
}

func propOptions(raw []byte) []contract.PropOption {
	var out []contract.PropOption
	if len(raw) == 0 {
		return []contract.PropOption{}
	}
	if err := json.Unmarshal(raw, &out); err != nil || out == nil {
		return []contract.PropOption{}
	}
	return out
}

// requireRevision turns a missing ExpectedRevision into a 400, so the
// optimistic-concurrency check can never be skipped by omitting the field.
func requireRevision(in contract.RowInput) error {
	if in.ExpectedRevision == nil {
		return contract.Validation("缺少 revision，请刷新后重试")
	}
	return nil
}

// rowSlug builds the deterministic ids a new row gets. Ids are derived from
// source + platform code so a retry after a lost response is idempotent: the
// unique index on platform_code turns the second attempt into a 409 instead of
// a duplicate row.
func rowSlug(sourceID, code string) string {
	return fmt.Sprintf("%s-%s", sourceID, strings.ToLower(strings.TrimSpace(code)))
}
