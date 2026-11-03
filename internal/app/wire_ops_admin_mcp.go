package app

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	adminbillingrepo "github.com/xxww0098/podhub-go/internal/admin/billing/repo"
	catalogrepo "github.com/xxww0098/podhub-go/internal/admin/catalog/repo"
	admindelegaterepo "github.com/xxww0098/podhub-go/internal/admin/delegate/repo"
	adminhttp "github.com/xxww0098/podhub-go/internal/admin/http"
	observerepo "github.com/xxww0098/podhub-go/internal/admin/observe/repo"
	adminrepo "github.com/xxww0098/podhub-go/internal/admin/repo"
	adminsvc "github.com/xxww0098/podhub-go/internal/admin/service"
	adminshippingrepo "github.com/xxww0098/podhub-go/internal/admin/shipping/repo"
	supplierrepo "github.com/xxww0098/podhub-go/internal/admin/supplier/repo"
	adminusersrepo "github.com/xxww0098/podhub-go/internal/admin/users/repo"
	x1repo "github.com/xxww0098/podhub-go/internal/admin/x1/repo"
	httpapi "github.com/xxww0098/podhub-go/internal/app/api"
	automationhttp "github.com/xxww0098/podhub-go/internal/automation/http"
	automationrepo "github.com/xxww0098/podhub-go/internal/automation/repo"
	automationsvc "github.com/xxww0098/podhub-go/internal/automation/service"
	billingrepo "github.com/xxww0098/podhub-go/internal/billing/repo"
	delegaterepo "github.com/xxww0098/podhub-go/internal/delegate/repo"
	delegatesvc "github.com/xxww0098/podhub-go/internal/delegate/service"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/mcp/domain"
	mcphttp "github.com/xxww0098/podhub-go/internal/mcp/http"
	mcprepo "github.com/xxww0098/podhub-go/internal/mcp/repo"
	mcpsvc "github.com/xxww0098/podhub-go/internal/mcp/service"
	media "github.com/xxww0098/podhub-go/internal/media/contract"
	"github.com/xxww0098/podhub-go/internal/ops/contract"
	opshttp "github.com/xxww0098/podhub-go/internal/ops/http"
	opsrepo "github.com/xxww0098/podhub-go/internal/ops/repo"
	opssvc "github.com/xxww0098/podhub-go/internal/ops/service"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
	managercatalogrepo "github.com/xxww0098/podhub-go/internal/suppliercatalog/repo"

	"github.com/xxww0098/podhub-go/internal/platform/seal"
	sellercontract "github.com/xxww0098/podhub-go/internal/seller/contract"
	seller "github.com/xxww0098/podhub-go/internal/seller/ozon"
	sellerrepo "github.com/xxww0098/podhub-go/internal/seller/ozon/repo"
	shippingrepo "github.com/xxww0098/podhub-go/internal/shipping/repo"
	shippingsvc "github.com/xxww0098/podhub-go/internal/shipping/service"
	storehttp "github.com/xxww0098/podhub-go/internal/store/http"
	telemetryhttp "github.com/xxww0098/podhub-go/internal/telemetry/http"
	telemetryrepo "github.com/xxww0098/podhub-go/internal/telemetry/repo"
	telemetrysvc "github.com/xxww0098/podhub-go/internal/telemetry/service"
)

// mountPR8B registers ops, automation, telemetry, admin, and /mcp.
// The seller egress stays here: ops may import only a lower-level contract,
// and seller has none. The kill switch is already parsed inside config.
func mountPR8B(r chi.Router, s *httpapi.Server) {
	if r == nil || s == nil {
		return
	}
	cfg := config.Load()
	eg := seller.New(cfg)
	if s.Pool != nil {
		eg = eg.WithPool(s.Pool)
	}
	key := cfg.SellerCredentialKey
	var ring seal.Ring
	ready := key != ""
	if ready {
		ring = seal.Ring{Primary: seal.DeriveKEK(key)}
		if cfg.SellerCredentialKeyPrevious != "" {
			ring.Previous = seal.DeriveKEK(cfg.SellerCredentialKeyPrevious)
		}
	}
	var store *opsrepo.Store
	if s.Pool != nil {
		keyID := cfg.SellerCredentialKeyID
		if keyID == "" {
			keyID = seal.DefaultSellerKeyID
		}
		store = opsrepo.New(s.Pool, ring, ready, keyID)
	}
	opshttp.Mount(r, opshttp.Deps{Resolve: opsResolve(s.Access), Screen: &opssvc.Screen{
		Stores: store, Ledger: store, Console: store, Refresh: store, Seller: sellerPort{egress: eg},
		PromotionRead: sellerPort{egress: eg}.promotionRead,
	}})
	var actions *automationsvc.Service
	if s.Pool != nil {
		actions = automationsvc.New(automationrepo.New(s.Pool, tenant.BeginApp), nil, nil)
	}
	automationhttp.Mount(r, automationhttp.Deps{Resolve: automationResolve(s.Access), Actions: actions})
	telemetryhttp.Mount(r, telemetryhttp.Deps{
		Resolve: telemetryResolve(s.Access),
		Actions: telemetrysvc.New(telemetryrepo.New(s.Pool)),
		Collect: cfg.ClientLogCollect(),
		Now:     s.Now,
	})
	deps := adminDeps(s, cfg)
	accounts, _ := configuredStorage(cfg)
	deps.Ported = httpapi.AdminPorted(s, accounts)
	if s.Pool != nil {
		deps.DelegateWrites = delegatePort{inner: delegatesvc.Admin{Store: delegaterepo.New(s.Pool, tenant.BeginApp)}}
		deps.ShippingWrites = shippingPort{inner: shippingsvc.Admin{
			Store:              shippingrepo.Repo{Pool: s.Pool, Ring: ring, KeyReady: ready, KeyID: cfg.SellerCredentialKeyID},
			Ozon:               shippingOzon{egress: eg},
			InjectWrites:       cfg.ShippingInjectOzonWrites(),
			OzonWritesDisabled: cfg.OzonWritesDisabled(),
		}}
	}
	adminhttp.Mount(r, deps)
	mcp := cfg.MCPSettings()
	handler := mcpsvc.New(mcprepo.New(s.Pool))
	if deps.AdminB != nil {
		handler = handler.WithCodes(codeAdmin{billing: deps.AdminB, now: s.Now})
	}
	mcphttp.Mount(r, mcphttp.Deps{
		Allow:      domain.Allow{Hosts: mcp.AllowedHosts, Origins: mcp.AllowedOrigins},
		RunnerPath: mcp.RunnerPath,
		Handler:    handler,
		Session:    mcpSession(s.Access),
	})
}

func mcpSession(res access.Resolver) mcphttp.SessionResolve {
	if res == nil {
		return func(*http.Request) (*domain.Caller, error) { return nil, nil }
	}
	return func(r *http.Request) (*domain.Caller, error) {
		p, ref, err := res.Resolve(r)
		if err != nil {
			return nil, err
		}
		if ref != nil || p == nil {
			return nil, nil
		}
		return &domain.Caller{
			UserID: p.UserID, OrgID: p.OrgID, PlatformRole: p.PlatformRole,
			PublicID: p.PublicID, TokenHash: p.TokenHash,
		}, nil
	}
}

// sellerPort is the ops contract over the process egress. Ops does not import seller.
type sellerPort struct {
	egress *seller.Egress
}

func (p sellerPort) WritesDisabled() bool {
	return p.egress == nil || p.egress.Port().WritesDisabled()
}

func (p sellerPort) Call(ctx context.Context, lane contract.Lane, method, path string, body []byte, secret contract.Secret) (int, string, error) {
	if p.egress == nil {
		return 0, "", contract.ErrUnreachable
	}
	write := lane == contract.LaneWrite || lane == contract.LaneInteractiveWrite
	interactive := lane == contract.LaneInteractiveRead || lane == contract.LaneInteractiveWrite
	call := p.egress.Call
	if !write {
		call = p.egress.SellerReadCall
	} else if path == "/v1/product/import/prices" {
		call = p.egress.ProductPriceCall
	} else if path == "/v2/products/stocks" || path == "/v1/product/archive" || path == "/v1/product/unarchive" || path == "/v2/products/delete" {
		call = p.egress.ProductMutationCall
	} else if path == "/v1/actions/products/update" || path == "/v2/actions/products/deactivate" {
		call = p.egress.PromotionCall
	}
	reply, err := call(ctx, method, path, body, write, interactive, secret.ClientID, secret.APIKey)
	switch {
	case errors.Is(err, sellercontract.ErrWritesDisabled):
		return 0, "", contract.ErrWritesDisabled
	case errors.Is(err, seller.ErrRefusedOrigin):
		return 0, "", contract.ErrUnreachable
	case errors.Is(err, seller.ErrSaturated), errors.Is(err, sellerrepo.ErrRateLimited):
		return 0, "", contract.ErrRateLimited
	}
	return reply.Status, reply.Body, err
}

func opsResolve(res access.Resolver) opshttp.Resolve {
	return adapt(res, func(p *access.Principal) *opshttp.Session {
		return &opshttp.Session{UserID: p.UserID, OrgID: p.OrgID, WorkspaceRole: p.WorkspaceRole, PlatformRole: p.PlatformRole}
	}, func(ref *access.Refusal) *opshttp.Refusal {
		return &opshttp.Refusal{Status: ref.Status, Message: ref.Message}
	})
}

func automationResolve(res access.Resolver) automationhttp.Resolve {
	return adapt(res, func(p *access.Principal) *automationhttp.Session {
		return &automationhttp.Session{UserID: p.UserID, OrgID: p.OrgID, WorkspaceRole: p.WorkspaceRole, PlatformRole: p.PlatformRole}
	}, func(ref *access.Refusal) *automationhttp.Refusal {
		return &automationhttp.Refusal{Status: ref.Status, Message: ref.Message}
	})
}

func telemetryResolve(res access.Resolver) telemetryhttp.Resolve {
	return adapt(res, func(p *access.Principal) *telemetryhttp.Session {
		return &telemetryhttp.Session{UserID: p.UserID, OrgID: p.OrgID, WorkspaceRole: p.WorkspaceRole, PlatformRole: p.PlatformRole}
	}, func(ref *access.Refusal) *telemetryhttp.Refusal {
		return &telemetryhttp.Refusal{Status: ref.Status, Message: ref.Message}
	})
}

func adminDeps(s *httpapi.Server, cfg config.Config) adminhttp.Deps {
	store := adminrepo.New(s.Pool, tenant.BeginApp)
	store.Key = cfg.IntegrationConfigKey
	rows := x1repo.NewX1(s.Pool, tenant.BeginApp)
	rows.ValidateConfig = validateSupplierConfig
	portal := supplierrepo.Portal{Pool: s.Pool, Begin: tenant.BeginApp}
	supplier := adminsvc.New(supplierStore{Repo: store, Portal: portal, X1: rows})
	supplier.CatalogAccess = managercatalogrepo.Repo{Pool: s.Pool}
	supplier.Origin = adminhttp.R2Origin{}
	supplier.Accounts = func(context.Context) (sign.Account, bool, error) {
		account, err := configuredR2Account(cfg, media.RoleAssets)
		if errors.Is(err, errR2NotConfigured) {
			return sign.Account{}, false, nil
		}
		return account, err == nil, err
	}
	deps := adminhttp.Deps{Resolve: adminResolve(s.Access, s.Pool), Supplier: &supplier}
	if s.Pool == nil {
		return deps
	}
	deps.AdminB = adminBilling{
		Repo:        adminrepo.NewBilling(s.Pool, cfg.IntegrationConfigKey),
		Entitlement: newEntitlement(s.Pool),
		Observe:     observerepo.NewObserve(s.Pool, storehttp.FetchOzonThumbnail),
	}
	deps.API = &adminsvc.API{
		DB:             adminDB{Store: adminrepo.NewStore(s.Pool, s.Now), Users: adminusersrepo.NewUsers(s.Pool, s.Now)},
		Now:            s.Now,
		IntegrationKey: cfg.IntegrationConfigKey,
		Loopback:       cfg.AIEgressAllowLoopback,
		Fetch:          adminhttp.NewCatalogue(cfg.AIEgressAllowLoopback),
	}
	pool := s.Pool
	accounts, _ := configuredStorage(cfg)
	bases := make([]string, 0, len(accounts))
	for _, account := range accounts {
		if account.PublicBaseURL != "" {
			bases = append(bases, account.PublicBaseURL)
		}
	}
	deps.Catalog = adminsvc.NewCatalog(catalogrepo.CatalogRepo{Pool: pool, PublicBases: bases}, adminsvc.CatalogOptions{Blobs: adminhttp.LoopbackBlob{}})
	deps.Procure = adminsvc.NewProcure(adminrepo.ProcureRepo{Pool: pool}, adminsvc.ProcureOptions{})
	deps.Agents = adminsvc.NewAgents(adminrepo.AgentsRepo{Pool: pool}, adminsvc.AgentsOptions{})
	deps.Shipping = adminsvc.NewShipping(adminshippingrepo.ShippingRepo{Pool: pool}, adminsvc.ShippingOptions{
		OzonWritesDisabled: cfg.OzonWritesDisabled(),
		InjectWrites:       cfg.ShippingInjectWrites(),
	})
	deps.Relay = adminsvc.NewRelay(adminrepo.RelayRepo{Pool: pool}, sellerRelayOptions(cfg))
	deps.Delegate = adminsvc.NewDelegateAdmin(admindelegaterepo.DelegateRepo{Pool: pool})
	return deps
}

// adminBilling is the billing and observation port: plans, orders, redeem
// codes, and wallet from the entitlement store, observation SQL from the
// observe store, the rest from admin.
type adminBilling struct {
	*adminrepo.Repo
	*adminbillingrepo.Entitlement
	*observerepo.Observe
}

// newEntitlement wires the manual payment confirmation path. The entitlement
// store may only import the billing contract, so the repo functions are
// passed here from the assembly point.
func newEntitlement(pool *pgxpool.Pool) *adminbillingrepo.Entitlement {
	ent := adminbillingrepo.NewEntitlement(pool)
	ent.SettleFirstOrderCommission = billingrepo.SettleFirstOrderCommission
	ent.FulfillSubscriptionOrder = func(ctx context.Context, tx pgx.Tx, publicID string, now time.Time) error {
		order, err := billingrepo.LoadOrder(ctx, tx, publicID)
		if err != nil {
			return err
		}
		return billingrepo.FulfillPaidSubscription(ctx, tx, order, now)
	}
	return ent
}

// supplierStore is the supplier service port: grants stay on admin Repo,
// sources, accounts, and withdrawals are Portal, rows are the x1 store.
type supplierStore struct {
	adminrepo.Repo
	supplierrepo.Portal
	x1repo.X1
}

// adminDB is the admin service store: accounts and seats from the users
// store, the rest from admin.
type adminDB struct {
	*adminrepo.Store
	*adminusersrepo.Users
}

func adminResolve(res access.Resolver, pool *pgxpool.Pool) adminhttp.Resolve {
	if res == nil {
		return nil
	}
	return func(r *http.Request) (*adminhttp.Session, *adminhttp.Refusal, error) {
		p, ref, err := res.Resolve(r)
		if err != nil {
			return nil, nil, err
		}
		if ref != nil {
			return nil, &adminhttp.Refusal{Status: ref.Status, Message: ref.Message}, nil
		}
		if p == nil {
			return nil, nil, nil
		}
		sess := &adminhttp.Session{
			UserID: p.UserID, OrgID: p.OrgID,
			WorkspaceRole: p.WorkspaceRole, PlatformRole: p.PlatformRole,
			Email: p.Email, PublicID: p.PublicID, TokenHash: p.TokenHash,
		}
		return sess, nil, nil
	}
}

func adapt[S any, R any](res access.Resolver, session func(*access.Principal) *S, refusal func(*access.Refusal) *R) func(*http.Request) (*S, *R, error) {
	if res == nil {
		return nil
	}
	return func(r *http.Request) (*S, *R, error) {
		p, ref, err := res.Resolve(r)
		if err != nil {
			return nil, nil, err
		}
		if ref != nil {
			return nil, refusal(ref), nil
		}
		if p == nil {
			return nil, nil, nil
		}
		return session(p), nil, nil
	}
}
