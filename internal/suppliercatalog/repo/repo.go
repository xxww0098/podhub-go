// Package catalogrepo is the supplier catalogue manager's data access.
//
// Every read and write goes through db.CatalogManager, which sets
// app.current_org_user_id and the app role but never app.staff_access. That
// makes the RLS arms in 00365 -- not a WHERE clause -- the thing that decides
// which sources a manager sees. A missing arm therefore fails closed.
package catalogrepo

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/writer"
	"github.com/xxww0098/podhub-go/internal/suppliercatalog/contract"
)

// Repo reads and writes catalogue rows for one catalog manager.
type Repo struct {
	Pool *pgxpool.Pool
}

// managed lists the sources this user is an active manager of. It is the
// gate: a source not in this set is refused before any other query runs.
func (r Repo) managed(ctx context.Context, tx pgx.Tx, userID int64) (map[string]contract.SourceSummary, error) {
	rows, err := tx.Query(ctx, `
		SELECT s.source_id, s.name, s.country, s.contact, s.internal_note,
		       s.listed, s.icon, s.accepts_delegate, s.created_at_ms, s.updated_at_ms,
		       (SELECT count(*) FROM public.sc_products p WHERE p.source_id = s.source_id),
		       (SELECT count(*) FROM public.sc_products p
		         WHERE p.source_id = s.source_id AND p.published)
		  FROM public.sc_sources s
		  JOIN public.sc_catalog_managers m ON m.source_id = s.source_id
		 WHERE m.user_id = $1 AND m.status = 'active'
		 ORDER BY s.source_id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]contract.SourceSummary{}
	for rows.Next() {
		var s contract.SourceSummary
		if err := rows.Scan(&s.SourceID, &s.Name, &s.Country, &s.Contact, &s.InternalNote,
			&s.Listed, &s.Icon, &s.AcceptsDelegate, &s.CreatedAtMS, &s.UpdatedAtMS,
			&s.RowCount, &s.PublishedCount); err != nil {
			return nil, err
		}
		out[s.SourceID] = s
	}
	return out, rows.Err()
}

// Sources is GET /api/supplier-catalog/sources.
func (r Repo) Sources(ctx context.Context, userID int64) (contract.SourceListData, error) {
	var out contract.SourceListData
	err := r.read(ctx, userID, func(tx pgx.Tx) error {
		managed, err := r.managed(ctx, tx, userID)
		if err != nil {
			return err
		}
		out.Sources = []contract.SourceSummary{}
		for _, s := range managed {
			out.Sources = append(out.Sources, s)
		}
		return nil
	})
	return out, err
}

func (r Repo) read(ctx context.Context, userID int64, fn func(pgx.Tx) error) error {
	if r.Pool == nil {
		return contract.Internal()
	}
	return db.InTx(ctx, r.Pool, db.CatalogManager(userID), fn)
}

func (r Repo) write(ctx context.Context, userID int64, fn func(pgx.Tx) error) error {
	if r.Pool == nil {
		return contract.Internal()
	}
	return db.InTx(ctx, r.Pool, db.CatalogManager(userID), func(tx pgx.Tx) error {
		defer writer.Forget(tx)
		return fn(tx)
	})
}

func mapDB(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return contract.NotFound()
	}
	return contract.Internal()
}

var _ = json.RawMessage(nil)
