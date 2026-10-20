package supplyrepo

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/supply/contract"
	"github.com/xxww0098/podhub-go/internal/supply/gen"
)

// BeginApp opens a podhub_app transaction for one org.
// The process passes tenant.BeginApp. This package does not import tenant.
type BeginApp func(ctx context.Context, begin func(context.Context) (pgx.Tx, error), orgID int64) (pgx.Tx, error)

// Repo reads sc_listing_bindings. The table has no RLS, so every query
// carries the session org_id and refuses a missing org before it begins.
type Repo struct {
	pool  *pgxpool.Pool
	begin BeginApp
}

// New keeps the pool and the tenant opener. A nil pool cannot open a transaction.
func New(pool *pgxpool.Pool, begin BeginApp) Repo {
	return Repo{pool: pool, begin: begin}
}

func (r Repo) GetBinding(ctx context.Context, orgID int64, listingRowID string) (contract.Binding, error) {
	if orgID <= 0 {
		return contract.Binding{}, contract.ErrNoTenant
	}
	if r.pool == nil || r.begin == nil {
		return contract.Binding{}, contract.ErrUnavailable
	}
	var id pgtype.UUID
	if err := id.Scan(strings.TrimSpace(listingRowID)); err != nil || !id.Valid {
		return contract.Binding{}, contract.ErrNotFound
	}
	tx, err := r.begin(ctx, r.pool.Begin, orgID)
	if err != nil {
		return contract.Binding{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row, err := sqlcgen.New(tx).GetListingBinding(ctx, sqlcgen.GetListingBindingParams{
		OrgID: orgID, ListingRowID: id,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return contract.Binding{}, contract.ErrNotFound
	}
	if err != nil {
		return contract.Binding{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return contract.Binding{}, err
	}
	return contract.Binding{
		PlatformSKUID: row.PlatformSkuID, SpecVersion: row.SpecVersion, DesignRevision: row.DesignRevision,
	}, nil
}
