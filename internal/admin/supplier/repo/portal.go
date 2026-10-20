package supplierrepo

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	outcome "github.com/xxww0098/podhub-go/internal/admin/core/contract/outcome"
	corerepo "github.com/xxww0098/podhub-go/internal/admin/core/repo"
)

// Portal is the supplier source, account, prompt list, and withdrawal store.
type Portal struct {
	Pool  *pgxpool.Pool
	Begin corerepo.Begin
	Key   string
}

func (r Portal) beginCore() corerepo.Begin {
	if r.Begin == nil {
		return nil
	}
	b := r.Begin
	return func(ctx context.Context, begin func(context.Context) (pgx.Tx, error), orgID int64) (pgx.Tx, error) {
		return b(ctx, begin, orgID)
	}
}

func (r Portal) withTx(ctx context.Context, orgID int64, fn func(pgx.Tx) error) error {
	return corerepo.WithTx(ctx, r.Pool, r.beginCore(), orgID, fn)
}

func (r Portal) identity(ctx context.Context, tx pgx.Tx, actor outcome.Actor) (publicID string, owner *string, err error) {
	return corerepo.Identity(ctx, tx, actor)
}
