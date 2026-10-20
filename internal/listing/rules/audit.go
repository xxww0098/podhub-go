package rules

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"

	rulescontract "github.com/xxww0098/podhub-go/internal/listing/rules/contract"
)

// SetBannedAudit installs the sqlc audit insert. app/api calls this in init.
func SetBannedAudit(fn func(ctx context.Context, pool *pgxpool.Pool, orgID, userID int64, entityID, method, path, action, message string) error) {
	rulescontract.InsertAuditFn = func(ctx context.Context, pool any, orgID, userID int64, entityID, method, path, action, message string) error {
		return fn(ctx, pool.(*pgxpool.Pool), orgID, userID, entityID, method, path, action, message)
	}
}
