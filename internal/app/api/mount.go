package api

import (
	"context"
	"errors"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/podhub-go/internal/catalog"
	listing "github.com/xxww0098/podhub-go/internal/listing/read/http"
	platform "github.com/xxww0098/podhub-go/internal/listing/rules"
	fieldpack "github.com/xxww0098/podhub-go/internal/listing/write/http"
	"github.com/xxww0098/podhub-go/internal/platform/db/sqlc"
)

// MountDomains registers listing writes, catalog reads, field packs and the
// banned-tag admin writes. Generated routes stay on HandlerFromMux.
func MountDomains(r chi.Router, s *Server) {
	if s == nil {
		return
	}
	listing.Mount(r, listing.Host{
		Pool: s.Pool, Engine: s.Engine, Access: s.Access, Now: s.Now,
		Seller: s.Seller, Seals: s.Seals,
		LoadRules: func(ctx context.Context) ([]listing.Rule, error) {
			if s.Pool == nil {
				return nil, errors.New("database unavailable")
			}
			// listing.Rule and platform.Rule are the same contract type.
			return platform.EnabledBannedTags(ctx, func(ctx context.Context) ([]platform.Rule, error) {
				return platform.LoadEnabledBannedTags(ctx, sqlc.New(s.Pool))
			})
		},
	})
	catalog.Mount(r, catalog.Host{Pool: s.Pool, Access: s.Access, Now: s.Now, Seller: s.Seller, Seals: s.Seals})
	fieldpack.Mount(r, fieldpack.Host{Pool: s.Pool, Access: s.Access, Now: s.Now})
	platform.MountBannedWrites(r, platform.BannedHost{Pool: s.Pool, Engine: s.Engine, Access: s.Access})
}
