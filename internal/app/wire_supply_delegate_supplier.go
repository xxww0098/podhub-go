package app

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	delegatehttp "github.com/xxww0098/podhub-go/internal/delegate/http"
	delegaterepo "github.com/xxww0098/podhub-go/internal/delegate/repo"
	delegatesvc "github.com/xxww0098/podhub-go/internal/delegate/service"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
	supplierhttp "github.com/xxww0098/podhub-go/internal/supplier/http"
	supplierrepo "github.com/xxww0098/podhub-go/internal/supplier/repo"
	suppliersvc "github.com/xxww0098/podhub-go/internal/supplier/service"
	supplyhttp "github.com/xxww0098/podhub-go/internal/supply/http"
	supplyrepo "github.com/xxww0098/podhub-go/internal/supply/repo"
	supplysvc "github.com/xxww0098/podhub-go/internal/supply/service"
)

// mountPR8A registers supply, delegate, and supplier. Delegate seller routes
// call delegatesvc.Seller. Repos receive tenant.BeginApp from here so the
// domains do not import the flat tenant package. Supplier receives the
// loopback media account for asset and catalog blobs.
func mountPR8A(router chi.Router, pool *pgxpool.Pool, sessions access.Resolver, blobs *sign.Account) {
	cfg := config.Load()
	delegateRepo := delegaterepo.New(pool, tenant.BeginApp)
	sellerAPI := delegatesvc.Seller{
		DB:   delegateRepo,
		Edge: delegateEdge(pool, cfg),
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
		Actions: suppliersvc.New(supplierrepo.New(pool, tenant.BeginApp).WithBlobs(blobs, blobs)),
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

func resolve(inner access.Resolver, r *http.Request) (*access.Principal, *access.Refusal, error) {
	if inner == nil {
		return nil, nil, nil
	}
	return inner.Resolve(r)
}
