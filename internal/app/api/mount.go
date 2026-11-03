package api

import (
	"context"
	"errors"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/catalog"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	coredomain "github.com/xxww0098/podhub-go/internal/listing/core/domain"
	listing "github.com/xxww0098/podhub-go/internal/listing/read/http"
	platform "github.com/xxww0098/podhub-go/internal/listing/rules"
	fieldpack "github.com/xxww0098/podhub-go/internal/listing/write/http"
	media "github.com/xxww0098/podhub-go/internal/media/contract"
	mediarepo "github.com/xxww0098/podhub-go/internal/media/repo"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
)

// MountDomains registers listing writes, catalog reads, field packs and the
// banned-tag admin writes. Generated routes stay on HandlerFromMux.
func MountDomains(r chi.Router, s *Server) {
	if s == nil {
		return
	}
	transit := func(ctx context.Context, tx pgx.Tx, actor access.Principal) (*listing.TransitStorage, error) {
		var account *sign.Account
		if s.Media != nil {
			var err error
			account, err = s.Media(ctx, actor)
			if err != nil {
				return nil, err
			}
		} else {
			row, err := mediarepo.ActiveSliceStorage(ctx, tx, actor.OrgID, s.SliceStorageKey)
			if err != nil {
				return nil, err
			}
			if row != nil {
				account = &row.Account
			}
		}
		if account == nil {
			return nil, nil
		}
		if s.Media == nil {
			cfg := media.Config{Role: media.RoleTransit, Provider: string(account.Provider), Endpoint: account.Endpoint, Region: account.Region, Bucket: account.Bucket, KeyPrefix: account.KeyPrefix, PublicBaseURL: account.PublicBaseURL, ForcePathStyle: account.ForcePathStyle, AccessKeyID: account.AccessKeyID, SecretAccessKey: account.SecretAccessKey}
			if err := cfg.ValidateSliceStorage(); err != nil {
				return nil, err
			}
		}
		return &listing.TransitStorage{AccountID: account.ID, StorageRevision: transitStorageRevision(*account), PublicURL: func(key string) string { return sign.PublicURL(*account, key) }}, nil
	}
	listing.Mount(r, listing.Host{
		Queue: s.ListingPreparationQueue, Transit: transit, RecognitionModels: s.RecognitionModels,
		ReadTaskRecords: s.ListingTaskRecords,
		Pool:            s.Pool, Engine: s.Engine, Access: s.Access, Now: s.Now,
		Seller: s.Seller, Seals: s.Seals,
		LoadRules: func(ctx context.Context) ([]listing.Rule, error) {
			if s.Pool == nil {
				return nil, errors.New("database unavailable")
			}
			// listing.Rule and platform.Rule are the same contract type.
			return platform.EnabledBannedTags(ctx, func(ctx context.Context) ([]platform.Rule, error) {
				return s.loadRules(ctx)
			})
		},
		SearchTagTokens: coredomain.SearchTagTokens,
	})
	catalog.Mount(r, catalog.Host{Pool: s.Pool, Access: s.Access, Now: s.Now, Seller: s.Seller, Seals: s.Seals, Snapshot: s.CatalogSnapshot, Fetcher: s.CatalogFetch})
	fieldpack.Mount(r, fieldpack.Host{Pool: s.Pool, Access: s.Access, Now: s.Now})
	platform.MountBannedWrites(r, platform.BannedHost{Pool: s.Pool, Engine: s.Engine, Access: s.Access, InsertAudit: insertBannedAudit})
}
