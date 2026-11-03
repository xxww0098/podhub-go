package api

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/db/sqlc"
)

// insertBannedAudit writes the admin audit row for a banned-tag write.
// MountDomains passes it to the rules BannedHost.
func insertBannedAudit(ctx context.Context, pool *pgxpool.Pool, orgID, userID int64, entityID, method, path, action, message string) error {
	return db.InTx(ctx, pool, db.AppRole(), func(tx pgx.Tx) error {
		return sqlc.New(tx).InsertAudit(ctx, sqlc.InsertAuditParams{
			OrgID: orgID, UserID: userID, Module: "admin", EntityType: "banned_tag",
			EntityID: entityID, ApiMethod: method, ApiPath: path, Action: action, Message: message,
		})
	})
}
