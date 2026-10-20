package api

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"

	listing "github.com/xxww0098/podhub-go/internal/listing/rules"
	"github.com/xxww0098/podhub-go/internal/platform/db/sqlc"
)

func init() {
	listing.SetBannedAudit(func(ctx context.Context, pool *pgxpool.Pool, orgID, userID int64, entityID, method, path, action, message string) error {
		return sqlc.New(pool).InsertAudit(ctx, sqlc.InsertAuditParams{
			OrgID: orgID, UserID: userID, Module: "admin", EntityType: "banned_tag",
			EntityID: entityID, ApiMethod: method, ApiPath: path, Action: action, Message: message,
		})
	})
}
