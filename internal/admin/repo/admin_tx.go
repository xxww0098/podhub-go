package adminrepo

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	corerepo "github.com/xxww0098/podhub-go/internal/admin/core/repo"
	"github.com/xxww0098/podhub-go/internal/admin/domain"
)

// BeginAdmin starts a transaction and sets the local role to podhub_app.
func BeginAdmin(ctx context.Context, pool *pgxpool.Pool) (pgx.Tx, error) {
	return corerepo.BeginAdmin(ctx, pool)
}

// AssertWriteLease is the admin-domain fence. disabledMessage is the call-site 503 text.
func AssertWriteLease(ctx context.Context, tx pgx.Tx, disabledMessage string) error {
	return corerepo.AssertWriteLease(ctx, tx, disabledMessage)
}

// InsertAudit writes one success row. created_at comes from the database clock.
func InsertAudit(ctx context.Context, tx pgx.Tx, a domain.Audit) error {
	return corerepo.InsertAudit(ctx, tx, corerepo.AuditRow{
		OrgID: a.OrgID, UserID: a.UserID, Module: a.Module, EntityType: a.EntityType,
		EntityID: a.EntityID, Method: a.Method, Path: a.Path, Action: a.Action, Message: a.Message,
	})
}

func mapAdmin(err error, code string) error { return corerepo.MapAdmin(err, code) }
