package app

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	ai "github.com/xxww0098/podhub-go/internal/ai/contract"
	billingrepo "github.com/xxww0098/podhub-go/internal/billing/repo"
	delegatehttp "github.com/xxww0098/podhub-go/internal/delegate/http"
	delegaterepo "github.com/xxww0098/podhub-go/internal/delegate/repo"
	delegatesvc "github.com/xxww0098/podhub-go/internal/delegate/service"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	media "github.com/xxww0098/podhub-go/internal/media/contract"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
	supplierhttp "github.com/xxww0098/podhub-go/internal/supplier/http"
	supplierrepo "github.com/xxww0098/podhub-go/internal/supplier/repo"
	suppliersvc "github.com/xxww0098/podhub-go/internal/supplier/service"
	cataloghttp "github.com/xxww0098/podhub-go/internal/suppliercatalog/http"
	catalogrepo "github.com/xxww0098/podhub-go/internal/suppliercatalog/repo"
	catalogsvc "github.com/xxww0098/podhub-go/internal/suppliercatalog/service"
	supplyhttp "github.com/xxww0098/podhub-go/internal/supply/http"
	supplyrepo "github.com/xxww0098/podhub-go/internal/supply/repo"
	supplysvc "github.com/xxww0098/podhub-go/internal/supply/service"
)

// mountPR8A registers supply, delegate, and supplier. Delegate seller routes
// call delegatesvc.Seller. Repos receive tenant.BeginApp from here so the
// domains do not import the flat tenant package. Supplier receives the
// current private bucket for originals and the assets account for catalog images.
func mountPR8A(router chi.Router, pool *pgxpool.Pool, sessions access.Resolver, cfg config.Config) {
	delegateRepo := delegaterepo.New(pool, tenant.BeginApp)
	sellerAPI := delegatesvc.Seller{
		DB:   delegateRepo,
		Edge: delegateEdge(cfg, pool),
		Auto: cfg.DelegateAutoDispatch(),
	}
	supplyhttp.Mount(router, supplyhttp.Deps{
		Session: supplySession{sessions},
		Actions: supplysvc.New(supplyrepo.New(pool, tenant.BeginApp)),
	})
	delegatehttp.Mount(router, delegatehttp.Deps{
		Session: delegateSession{sessions},
		Actions: delegatesvc.New(delegateRepo),
		Seller:  &sellerAPI,
	})
	supplierhttp.Mount(router, supplierhttp.Deps{
		Session: supplierSession{sessions},
		Actions: suppliersvc.New(supplierrepo.New(pool, tenant.BeginApp).WithBlobs(func(ctx context.Context) (sign.Account, error) {
			account, _, err := loadDelegateStorage(ctx, pool, cfg)
			return account, err
		}, func(ctx context.Context) (sign.Account, error) {
			account, _, err := configuredR2Account(ctx, pool, cfg, media.RoleAssets)
			return account, err
		}).WithMoney(billingrepo.HoldTx, billingrepo.SettleTx).WithProfileValidation(func(raw string) bool {
			_, err := ai.ParseProductProfile(raw)
			return err == nil
		})),
	})
	// The catalogue manager surface is mounted separately from the admin one:
	// it runs on db.CatalogManager, which never sets app.staff_access.
	cataloghttp.Mount(router, cataloghttp.Deps{
		Session: catalogSession{sessions},
		Actions: catalogsvc.New(catalogrepo.Repo{Pool: pool}),
	})
}

type supplySession struct{ inner access.Resolver }

func (s supplySession) Resolve(r *http.Request) (*supplyhttp.Principal, *supplyhttp.Refusal, error) {
	p, refusal, err := resolve(s.inner, r)
	if p == nil && refusal == nil {
		return nil, nil, err
	}
	var out *supplyhttp.Principal
	if p != nil {
		out = &supplyhttp.Principal{UserID: p.UserID, OrgID: p.OrgID, WorkspaceRole: p.WorkspaceRole}
	}
	var ref *supplyhttp.Refusal
	if refusal != nil {
		ref = &supplyhttp.Refusal{Status: refusal.Status, Message: refusal.Message}
	}
	return out, ref, err
}

type delegateSession struct{ inner access.Resolver }

func (s delegateSession) Resolve(r *http.Request) (*delegatehttp.Principal, *delegatehttp.Refusal, error) {
	p, refusal, err := resolve(s.inner, r)
	if p == nil && refusal == nil {
		return nil, nil, err
	}
	var out *delegatehttp.Principal
	if p != nil {
		out = &delegatehttp.Principal{UserID: p.UserID, OrgID: p.OrgID, WorkspaceRole: p.WorkspaceRole}
	}
	var ref *delegatehttp.Refusal
	if refusal != nil {
		ref = &delegatehttp.Refusal{Status: refusal.Status, Message: refusal.Message}
	}
	return out, ref, err
}

type supplierSession struct{ inner access.Resolver }

func (s supplierSession) Resolve(r *http.Request) (*supplierhttp.Principal, *supplierhttp.Refusal, error) {
	p, refusal, err := resolve(s.inner, r)
	if p == nil && refusal == nil {
		return nil, nil, err
	}
	var out *supplierhttp.Principal
	if p != nil {
		out = &supplierhttp.Principal{UserID: p.UserID, OrgID: p.OrgID}
	}
	var ref *supplierhttp.Refusal
	if refusal != nil {
		ref = &supplierhttp.Refusal{Status: refusal.Status, Message: refusal.Message}
	}
	return out, ref, err
}

type catalogSession struct{ inner access.Resolver }

func (s catalogSession) Resolve(r *http.Request) (*cataloghttp.Principal, *cataloghttp.Refusal, error) {
	p, refusal, err := resolve(s.inner, r)
	if p == nil && refusal == nil {
		return nil, nil, err
	}
	var out *cataloghttp.Principal
	if p != nil {
		out = &cataloghttp.Principal{UserID: p.UserID, PlatformRole: p.PlatformRole}
	}
	var ref *cataloghttp.Refusal
	if refusal != nil {
		ref = &cataloghttp.Refusal{Status: refusal.Status, Message: refusal.Message}
	}
	return out, ref, err
}

func resolve(inner access.Resolver, r *http.Request) (*access.Principal, *access.Refusal, error) {
	if inner == nil {
		return nil, nil, nil
	}
	return inner.Resolve(r)
}
