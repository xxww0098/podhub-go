package x1repo

import (
	"context"
	"github.com/jackc/pgx/v5"
	contract "github.com/xxww0098/podhub-go/internal/admin/core/contract/outcome"
	corerepo "github.com/xxww0098/podhub-go/internal/admin/core/repo"
	"time"
)

// AuthorizeOCRTest checks the same source ownership as the product editor.
func (r X1) AuthorizeOCRTest(ctx context.Context, actor contract.Actor, source, product string) error {
	if actor.Role != "admin" && actor.Role != "super_admin" {
		return corerepo.NotFound(corerepo.MissingRow)
	}
	return r.withRead(ctx, actor.OrgID, func(tx pgx.Tx) error {
		_, owner, err := r.identity(ctx, tx, actor)
		if err != nil {
			return err
		}
		if err = corerepo.RequireSource(ctx, tx, source, owner); err != nil {
			return err
		}
		_, err = loadRow(ctx, tx, source, product, time.Now().UnixMilli())
		return err
	})
}
