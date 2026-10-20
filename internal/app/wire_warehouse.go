package app

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/identity"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	ozonerrdomain "github.com/xxww0098/podhub-go/internal/ozonerr/domain"
	ozonerrrepo "github.com/xxww0098/podhub-go/internal/ozonerr/repo"
	ozonerrsvc "github.com/xxww0098/podhub-go/internal/ozonerr/service"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/seller"
	sellercontract "github.com/xxww0098/podhub-go/internal/seller/contract"
	sellerdomain "github.com/xxww0098/podhub-go/internal/seller/domain"
	sellerrepo "github.com/xxww0098/podhub-go/internal/seller/repo"
	whcontract "github.com/xxww0098/podhub-go/internal/warehouse/contract"
	warehousehttp "github.com/xxww0098/podhub-go/internal/warehouse/http"
	warehouserepo "github.com/xxww0098/podhub-go/internal/warehouse/repo"
	warehousesvc "github.com/xxww0098/podhub-go/internal/warehouse/service"
)

// mountWarehouse registers the tenant warehouse cache and browser-direct writes.
// Reads use seller.Egress.Call with write disabled. The grant path receives
// the kill-switch bool already captured on cfg.
func mountWarehouse(r chi.Router, pool *pgxpool.Pool, sessions access.Resolver, cfg config.Config) {
	if r == nil {
		return
	}
	ring := sealRing(cfg)
	ready := cfg.SellerCredentialKey != ""
	eg := seller.New(cfg).WithPool(pool)
	svc := warehousesvc.Service{
		DB:     warehouserepo.New(pool),
		Open:   admitOpener{store: sellerrepo.NewAdmitStore(pool, ring, ready)},
		Post:   egressPoster{eg: eg},
		Limit:  budgetLimiter{pool: pool},
		Errors: WarehouseCatalog(pool),
		Now:    time.Now,
	}
	warehousehttp.Mount(r, warehousehttp.Deps{
		Session:        warehouseSession{inner: sessions},
		Actions:        svc,
		Read:           allows(identity.CapStoreRead),
		Write:          allows(identity.CapWarehouseWrite),
		WritesDisabled: cfg.OzonWritesDisabled(),
		Now:            time.Now,
	})
}

func allows(cap identity.Capability) func(string) bool {
	return func(role string) bool {
		parsed, ok := identity.ParseWorkspaceRole(role)
		return ok && parsed.Allows(cap)
	}
}

type warehouseSession struct{ inner access.Resolver }

func (s warehouseSession) Resolve(r *http.Request) (*warehousehttp.Principal, *warehousehttp.Refusal, error) {
	if s.inner == nil {
		return nil, nil, nil
	}
	p, refusal, err := s.inner.Resolve(r)
	if err != nil || refusal != nil || p == nil {
		if refusal == nil {
			return nil, nil, err
		}
		return nil, &warehousehttp.Refusal{Status: refusal.Status, Message: refusal.Message, Code: refusalCode(refusal)}, err
	}
	return &warehousehttp.Principal{UserID: p.UserID, OrgID: p.OrgID, WorkspaceRole: p.WorkspaceRole}, nil, nil
}

func refusalCode(refusal *access.Refusal) string {
	if refusal == nil {
		return ""
	}
	if refusal.Status == http.StatusUnauthorized {
		return "AUTH_REQUIRED"
	}
	return "forbidden"
}

type admitOpener struct{ store sellerrepo.AdmitStore }

func (o admitOpener) Open(ctx context.Context, orgID, userID int64, role, storeID string, now time.Time) (string, string, error) {
	clientID, apiKey, err := o.store.Admit(ctx, orgID, userID, role, storeID, now.UnixMilli())
	if err == nil {
		return clientID, apiKey, nil
	}
	var admit *sellercontract.AdmitError
	if errors.As(err, &admit) {
		return "", "", &whcontract.OpenError{Status: admit.Status, Code: admit.Code, Message: admit.Message}
	}
	return "", "", err
}

type egressPoster struct{ eg *seller.Egress }

func (p egressPoster) Post(ctx context.Context, path string, body []byte, clientID, apiKey string) (int, []byte, error) {
	if p.eg == nil {
		return 0, nil, seller.ErrRefusedOrigin
	}
	reply, err := p.eg.Call(ctx, http.MethodPost, path, body, false, true, clientID, apiKey)
	if errors.Is(err, sellerrepo.ErrRateLimited) {
		return 0, nil, whcontract.ErrRateLimited
	}
	if err != nil {
		return 0, nil, err
	}
	return reply.Status, []byte(reply.Body), nil
}

type budgetLimiter struct{ pool *pgxpool.Pool }

func (b budgetLimiter) Reserve(ctx context.Context, scope string) error {
	interval := time.Second / time.Duration(sellerdomain.DefaultRatePerSecond)
	burst := interval * time.Duration(sellerdomain.DefaultBurst-1)
	wait, err := sellerrepo.Reserve(ctx, b.pool, sellerdomain.Namespace(), scope, interval, burst, sellerdomain.MaxRateLimitWait)
	if errors.Is(err, sellerrepo.ErrRateLimited) {
		return whcontract.ErrRateLimited
	}
	if err != nil {
		return err
	}
	if wait <= 0 {
		return nil
	}
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// WarehouseCatalog writes warehouse Seller failures into the Ozon error catalog.
// A nil pool records nothing. The warehouse call still returns its own result.
func WarehouseCatalog(pool *pgxpool.Pool) warehousesvc.ErrorCatalog {
	if pool == nil {
		return nil
	}
	return ozonWarehouseCatalog{svc: ozonerrsvc.New(ozonerrrepo.New(pool))}
}

// ozonWarehouseCatalog keeps a numeric Seller code when the response has one,
// including codes outside the 4xx grpc map. A 4xx without a numeric code uses
// that map. Unmapped statuses are not stored. No body, key, or message is sent.
type ozonWarehouseCatalog struct {
	svc *ozonerrsvc.Service
}

func (c ozonWarehouseCatalog) RecordOzon(ctx context.Context, orgID int64, taskKey string, status int, code string) {
	if c.svc == nil || orgID <= 0 {
		return
	}
	taskKey = strings.TrimSpace(taskKey)
	if taskKey == "" || len([]rune(taskKey)) > ozonerrdomain.MaxTaskKey {
		return
	}
	resolved, ok := warehouseCatalogCode(status, code)
	if !ok {
		return
	}
	_, err := c.svc.RecordRows(ctx, orgID, []ozonerrdomain.Row{{
		Source:  ozonerrdomain.SourceRequest,
		Code:    resolved,
		TaskKey: taskKey,
	}})
	if err != nil {
		slog.Error("ozon error catalog", "err", err)
	}
}

func warehouseCatalogCode(status int, code string) (string, bool) {
	code = strings.TrimSpace(code)
	if n, err := strconv.ParseInt(code, 10, 64); err == nil && n != 0 && !ozonerrdomain.SecretCode(code) && len(code) <= ozonerrdomain.MaxCode {
		return code, true
	}
	resolved, ok := ozonerrdomain.ResolveGRPC(status, nil)
	// Import 4xx stores an unmapped status as its decimal HTTP code.
	// Warehouse reports do not: that decimal is not a row.
	if !ok || resolved == strconv.Itoa(status) {
		return "", false
	}
	return resolved, true
}
