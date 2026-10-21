package x1repo

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	contract "github.com/xxww0098/podhub-go/internal/admin/core/contract/outcome"
	corerepo "github.com/xxww0098/podhub-go/internal/admin/core/repo"
)

// X1 is the supplier row, ozon-config, and prompt store.
type X1 struct {
	pool  *pgxpool.Pool
	begin corerepo.Begin
}

// NewX1 builds the row store. begin is tenantx.BeginApp. A nil pool fails closed.
func NewX1(pool *pgxpool.Pool, begin corerepo.Begin) X1 {
	return X1{pool: pool, begin: begin}
}

func (r X1) withRead(ctx context.Context, orgID int64, fn func(pgx.Tx) error) error {
	return corerepo.WithRead(ctx, r.pool, r.begin, orgID, fn)
}

// withWrite is a staff write transaction: it sets app.staff_access and takes
// the supplier writer lease. The /api/admin/supplier-dbs rows surface is a
// staff surface (GuardStaff), and 00365 gives every sc_* table FORCE RLS whose
// only write arm is the staff one, so a plain supplier write transaction would
// lock no sc_sources row and insert no sc_products/sc_skus row.
func (r X1) withWrite(ctx context.Context, orgID int64, fn func(pgx.Tx) error) error {
	return corerepo.Gate(ctx, r.pool, r.begin, orgID, true, true, fn)
}

func (r X1) identity(ctx context.Context, tx pgx.Tx, actor contract.Actor) (publicID string, owner *string, err error) {
	return corerepo.Identity(ctx, tx, actor)
}
