package rules

import (
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	core "github.com/xxww0098/podhub-go/internal/listing/core/contract"
	"github.com/xxww0098/podhub-go/internal/listing/rules/contract"
)

func init() {
	contract.EnabledBannedTags = EnabledBannedTags
	contract.InvalidateBannedTags = InvalidateBannedTags
	contract.MountBannedWrites = func(r any, pool any, engine core.Engine, resolver access.Resolver) {
		MountBannedWrites(r.(chi.Router), BannedHost{
			Pool:   pool.(*pgxpool.Pool),
			Engine: engine,
			Access: resolver,
		})
	}
}
