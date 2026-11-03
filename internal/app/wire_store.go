package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
	seller "github.com/xxww0098/podhub-go/internal/seller/ozon"
	shippingcontract "github.com/xxww0098/podhub-go/internal/shipping/contract"
	shippingrepo "github.com/xxww0098/podhub-go/internal/shipping/repo"
	shippingsvc "github.com/xxww0098/podhub-go/internal/shipping/service"
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
	shippingStore := shippingrepo.Repo{Pool: pool, Ring: ring, KeyReady: cfg.SellerCredentialKey != "", KeyID: keyID}
	shippingAdmin := shippingsvc.Admin{
		Store: shippingStore, Ozon: shippingOzon{egress: egress},
		InjectWrites: cfg.ShippingInjectOzonWrites(), OzonWritesDisabled: cfg.OzonWritesDisabled(),
	}
	shippingSeller := shippingsvc.Seller{
		Store: shippingStore, Admin: shippingAdmin,
		InjectWrites: cfg.ShippingInjectOzonWrites(), OzonWritesDisabled: cfg.OzonWritesDisabled(),
	}
	svc := storesvc.New(directory, sellerInfo{egress}).
		WithCredential(directory).
		WithTags(directory.Tags()).
		WithRoster(directory).
		WithCredentialDirectory(directory).
		WithProducts(directory, cfg.ProductSyncDisabled()).
		WithProductWorkspace(directory).
		WithSnapshots(directory).
		WithThumbnails(directory)
	storehttp.Mount(r, storehttp.Deps{
		Resolve: storeResolve(res), Actions: svc, Tags: svc, Roster: svc,
		Credential: svc, Refresh: svc, Products: svc, ProductWorkspace: svc,
		Shipping: storeShipping{svc: shippingSeller},
	})
}

// sellerReads adapts the Seller egress to the mirror's read port. It is the
// assembly layer's job: the store repo may not import the seller unit.
type sellerReads struct{ eg *seller.Egress }

func (c sellerReads) SellerRead(ctx context.Context, path string, body []byte, clientID, apiKey string) (int, []byte, error) {
	if c.eg == nil {
		return 0, nil, seller.ErrRefusedOrigin
	}
	reply, err := c.eg.SellerReadCall(ctx, http.MethodPost, path, body, false, true, clientID, apiKey)
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
	reply, err := p.eg.ProbeRoles(ctx, clientID, apiKey)
	if err != nil {
		return 0, nil, err
	}
	return reply.Status, []byte(reply.Body), nil
}

// sellerInfo uses the dedicated read allowlist and the existing rate limit.
type sellerInfo struct{ eg *seller.Egress }

func (c sellerInfo) PostSellerInfo(ctx context.Context, clientID, apiKey string) (int, []byte, error) {
	if c.eg == nil {
		return 0, nil, seller.ErrRefusedOrigin
	}
	reply, err := c.eg.SellerReadCall(ctx, http.MethodPost, "/v1/seller/info", []byte(`{}`), false, false, clientID, apiKey)
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

// storeShipping adapts the shipping service to the store HTTP port. The
// assembly layer owns the domain-to-wire failure mapping.
type storeShipping struct{ svc shippingsvc.Seller }

func (a storeShipping) Readiness(ctx context.Context, orgID int64, storeUUID, sku string) (json.RawMessage, error) {
	row, err := a.svc.Readiness(ctx, orgID, storeUUID, sku)
	if err != nil {
		return nil, storeShippingError(err)
	}
	return json.Marshal(row)
}

func (a storeShipping) Ensure(ctx context.Context, orgID, userID int64, storeUUID, sku string) (json.RawMessage, error) {
	row, err := a.svc.Ensure(ctx, orgID, userID, storeUUID, sku)
	if err != nil {
		return nil, storeShippingError(err)
	}
	return json.Marshal(row)
}

func storeShippingError(err error) error {
	var failure *shippingcontract.Fail
	if errors.As(err, &failure) && failure != nil {
		status := failure.Status
		if status == 0 {
			status = http.StatusServiceUnavailable
		}
		code := failure.Code
		if code == "" {
			code = "INTERNAL"
		}
		return &storehttp.ShippingError{Status: status, Code: code, Message: failure.Message}
	}
	return &storehttp.ShippingError{Status: http.StatusServiceUnavailable, Code: "INTERNAL", Message: access.MsgUnavailable}
}
