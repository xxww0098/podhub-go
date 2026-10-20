package app

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
	"github.com/xxww0098/podhub-go/internal/seller"
	storehttp "github.com/xxww0098/podhub-go/internal/store/http"
	storerepo "github.com/xxww0098/podhub-go/internal/store/repo"
	storesvc "github.com/xxww0098/podhub-go/internal/store/service"
)

func mountStore(r chi.Router, pool *pgxpool.Pool, res access.Resolver, cfg config.Config) {
	ring := sealRing(cfg)
	egress := seller.New(cfg).WithPool(pool)
	keyID := cfg.SellerCredentialKeyID
	if keyID == "" {
		keyID = seal.DefaultSellerKeyID
	}
	directory := storerepo.New(pool, tenant.BeginApp).
		WithCredentialKey(ring, cfg.SellerCredentialKey != "", keyID, rolesProbe{egress}).
		WithSellerEgress(sellerReads{egress})
	svc := storesvc.New(directory, sellerInfo{egress}).
		WithCredential(directory).
		WithTags(directory.Tags()).
		WithRoster(directory).
		WithCredentialDirectory(directory).
		WithProducts(directory, cfg.ProductSyncDisabled()).
		WithSnapshots(directory).
		WithThumbnails(directory)
	storehttp.Mount(r, storehttp.Deps{
		Resolve: storeResolve(res), Actions: svc, Tags: svc, Roster: svc,
		Credential: svc, Refresh: svc, Products: svc,
	})
}

// sellerReads adapts the Seller egress to the mirror's read port. It is the
// assembly layer's job: the store repo may not import the seller unit.
type sellerReads struct{ eg *seller.Egress }

func (c sellerReads) SellerRead(ctx context.Context, path string, body []byte, clientID, apiKey string) (int, []byte, error) {
	if c.eg == nil {
		return 0, nil, seller.ErrRefusedOrigin
	}
	reply, err := c.eg.Call(ctx, http.MethodPost, path, body, false, true, clientID, apiKey)
	if err != nil {
		return 0, nil, err
	}
	return reply.Status, []byte(reply.Body), nil
}

// rolesProbe is POST /v1/roles: the credential liveness read. It is a Seller
// read, so the captured write switch does not apply.
type rolesProbe struct{ eg *seller.Egress }

func (p rolesProbe) Roles(ctx context.Context, clientID, apiKey string) (int, []byte, error) {
	if p.eg == nil {
		return 0, nil, seller.ErrRefusedOrigin
	}
	reply, err := p.eg.Call(ctx, http.MethodPost, "/v1/roles", []byte(`{}`), false, true, clientID, apiKey)
	if err != nil {
		return 0, nil, err
	}
	return reply.Status, []byte(reply.Body), nil
}

// sellerInfo posts /v1/seller/info through the existing seller egress.
// write is false, so the captured write switch does not apply. The client
// is OzonClient, and a pool enables the existing rate limit.
type sellerInfo struct{ eg *seller.Egress }

func (c sellerInfo) PostSellerInfo(ctx context.Context, clientID, apiKey string) (int, []byte, error) {
	if c.eg == nil {
		return 0, nil, seller.ErrRefusedOrigin
	}
	reply, err := c.eg.Call(ctx, http.MethodPost, "/v1/seller/info", []byte(`{}`), false, false, clientID, apiKey)
	if err != nil {
		return 0, nil, err
	}
	return reply.Status, []byte(reply.Body), nil
}

func storeResolve(res access.Resolver) storehttp.Resolve {
	if res == nil {
		return func(*http.Request) (*storehttp.Session, *storehttp.Refusal, error) {
			return nil, nil, nil
		}
	}
	return func(r *http.Request) (*storehttp.Session, *storehttp.Refusal, error) {
		p, ref, err := res.Resolve(r)
		if err != nil {
			return nil, nil, err
		}
		if ref != nil {
			return nil, &storehttp.Refusal{Status: ref.Status, Message: ref.Message}, nil
		}
		if p == nil {
			return nil, nil, nil
		}
		return &storehttp.Session{UserID: p.UserID, OrgID: p.OrgID, WorkspaceRole: p.WorkspaceRole}, nil, nil
	}
}
