// Package contract is the import surface of listing/rules.
// The flat listing package and platform reach the cache and the write
// routes through these variables. The function bodies stay in package rules.
package contract

import (
	"context"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	core "github.com/xxww0098/podhub-go/internal/listing/core/contract"
)

// EnabledBannedTags is the one-second cache. rules assigns it in init.
var EnabledBannedTags func(ctx context.Context, load func(context.Context) ([]core.Rule, error)) ([]core.Rule, error)

// InvalidateBannedTags drops the process cache.
var InvalidateBannedTags func()

// MountBannedWrites registers the super-admin write routes. r is a chi
// router and pool is a *pgxpool.Pool. The concrete types stay out of this
// package so contract does not import chi or pgx.
var MountBannedWrites func(r any, pool any, engine core.Engine, access access.Resolver)

// InsertAuditFn writes one audit row. platform assigns the sqlc call.
var InsertAuditFn func(ctx context.Context, pool any, orgID, userID int64, entityID, method, path, action, message string) error
