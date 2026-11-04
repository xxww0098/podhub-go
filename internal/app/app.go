// Package app composes the HTTP server. It does not migrate on startup and
// does not dial a database unless DATABASE_URL is set to a loopback host.
package app

import (
	"context"
	"errors"
	"fmt"
	queuerepo "github.com/xxww0098/podhub-go/internal/queue/repo"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"

	"github.com/xxww0098/podhub-go/internal/ai"
	httpapi "github.com/xxww0098/podhub-go/internal/app/api"
	billinghttp "github.com/xxww0098/podhub-go/internal/billing/http"
	"github.com/xxww0098/podhub-go/internal/catalog"
	"github.com/xxww0098/podhub-go/internal/identity"
	"github.com/xxww0098/podhub-go/internal/listing/core"
	listing "github.com/xxww0098/podhub-go/internal/listing/core/contract"
	listengine "github.com/xxww0098/podhub-go/internal/listing/core/service/engine"
	readhttp "github.com/xxww0098/podhub-go/internal/listing/read/http"
	readrepo "github.com/xxww0098/podhub-go/internal/listing/read/repo"
	"github.com/xxww0098/podhub-go/internal/listing/submit"
	media "github.com/xxww0098/podhub-go/internal/media/contract"
	ozonerrrepo "github.com/xxww0098/podhub-go/internal/ozonerr/repo"
	ozonerrsvc "github.com/xxww0098/podhub-go/internal/ozonerr/service"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	loadtest "github.com/xxww0098/podhub-go/internal/platform/loadmode"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
	seller "github.com/xxww0098/podhub-go/internal/seller/ozon"
)

// Handler is the chi router wrapped for tracing. pool may be nil.
func Handler(pool *pgxpool.Pool) http.Handler {
	cfg := config.Load()
	return handler(pool, cfg, newCatalogFetcher(context.Background(), pool, cfg), newIdentity(pool, cfg))
}

func handler(pool *pgxpool.Pool, cfg config.Config, fetcher *catalog.Fetcher, svc *identity.Service) http.Handler {
	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return otelhttp.NewHandler(next, "podhub-api")
	})
	router.Use(identity.CSRF)
	router.Use(svc.Middleware)
	var recorded httpapi.OzonRecorder
	if pool != nil {
		recorded = ozonerrsvc.New(ozonerrrepo.New(pool))
	}
	srv := &httpapi.Server{
		ListingPreparationQueue: readhttp.MediaQueue{EnqueueOn: queuerepo.EnqueueOn},
		ListingTaskRecords:      readrepo.TaskRecords,
		Listing:                 submit.Service{Queue: submit.Queue{EnqueueOn: queuerepo.EnqueueOn, MutateRunning: queuerepo.MutateRunning}},
		Pool:                    pool, Engine: sharedEngine(), Identity: svc, Access: svc,
		SliceStorageKey:    sliceStorageKey(cfg),
		SliceDeleteAllowed: cfg.MediaDeleteEnabled(),
		Seller:             sellerPoster(seller.New(cfg)),
		Seals:              sealRing(cfg),
		CatalogSnapshot:    catalogSnapshot,
		CatalogFetch:       fetcher,
		// The grant route reads this captured bool. It does not load again.
		WritesDisabled: cfg.OzonWritesDisabled(),
		PublicURL:      cfg.PublicURL,
		Ozon:           recorded,
		SupplierMediaAccount: func(ctx context.Context) (sign.Account, error) {
			account, _, err := configuredR2Account(ctx, pool, cfg, media.RoleAssets)
			return account, err
		},
	}
	ocrRuntime := newOCRRuntime(pool, cfg)
	srv.RecognitionModels = ocrRuntime.Models
	ai.Register(router, ai.HTTPDeps{Deps: ai.Deps{Pool: pool, Text: newTextRuntime(pool, cfg), Images: newImageRuntime(pool, cfg), OCR: ocrRuntime, Wallet: aiWallet(), Limits: aiLimits(pool, cfg)}, Access: svc})
	billinghttp.Register(router, billinghttp.Deps{Pool: pool, Access: svc, Runtime: NewPaymentRuntime(pool, cfg, nil), Billing: billingHTTPDeps()})
	mountAgent(router, pool, svc)
	bindListingCore()
	httpapi.RegisterBrowserDirect(router, srv)
	httpapi.HandlerFromMux(srv, router)
	httpapi.MountDomains(router, srv)
	mountPR8A(router, pool, svc, cfg)
	mountPR8B(router, srv)
	mountWarehouse(router, pool, svc, cfg)
	mountStore(router, pool, svc, cfg)
	mountRatings(router, pool, svc)
	router.NotFound(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api" || strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"code":"invalid_request","message":"接口不存在"}`))
			return
		}
		http.NotFound(w, r)
	})
	return router
}

func sliceStorageKey(cfg config.Config) []byte {
	if len(strings.TrimSpace(cfg.IntegrationConfigKey)) < 32 {
		return nil
	}
	return seal.DeriveKEK(cfg.IntegrationConfigKey)
}

// sellerPoster uses the dedicated Seller read allowlist. A refused origin or a
// nil egress is unreachable and is not dialed. Saturated slots keep their class
// so catalog can answer 429. The kill switch is the bool seller.New already
// captured; this function does not read OZON_WRITE_KILL_SWITCH.
func sellerPoster(eg *seller.Egress) func(ctx context.Context, path string, body []byte, clientID, apiKey string) (int, []byte, error) {
	return func(ctx context.Context, path string, body []byte, clientID, apiKey string) (int, []byte, error) {
		reply, err := eg.SellerReadCall(ctx, http.MethodPost, path, body, false, false, clientID, apiKey)
		if err != nil {
			class := "unreachable"
			if errors.Is(err, seller.ErrSaturated) {
				class = "saturated"
			}
			return 0, nil, sellerClassError{class: class, err: err}
		}
		return reply.Status, []byte(reply.Body), nil
	}
}

type sellerClassError struct {
	class string
	err   error
}

func (e sellerClassError) Error() string       { return e.err.Error() }
func (e sellerClassError) Unwrap() error       { return e.err }
func (e sellerClassError) SellerClass() string { return e.class }

func sealRing(cfg config.Config) seal.Ring {
	if cfg.SellerCredentialKey == "" {
		return seal.Ring{}
	}
	ring := seal.Ring{Primary: seal.DeriveKEK(cfg.SellerCredentialKey)}
	if cfg.SellerCredentialKeyPrevious != "" {
		ring.Previous = seal.DeriveKEK(cfg.SellerCredentialKeyPrevious)
	}
	return ring
}

func bindListingCore() {
	mod, err := core.Shared(context.Background())
	if err != nil {
		// Send routes fail closed with 503 while the host is unbound.
		slog.Error("listing-core wasm", "err", err)
		return
	}
	submit.BindModule(mod)
	readhttp.BindCore(mod)
}

func sharedEngine() listing.Engine {
	mod, err := core.Shared(context.Background())
	if err != nil {
		// Health still serves. Tag checks fail closed: a nil *Engine returns an
		// error from every method, where a nil interface would panic.
		slog.Error("listing-core wasm", "err", err)
		return (*listengine.Engine)(nil)
	}
	return listengine.New(mod)
}

// Serve listens until SIGINT or SIGTERM. An empty DATABASE_URL still serves
// /api/health as unavailable.
func Serve(ctx context.Context, cfg config.Config) error {
	if cfg.LoadTestMode != "" {
		if err := loadtest.Run(cfg.LoadTestMode); err != nil {
			return err
		}
	}
	if err := cfg.CheckDatabase(); err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	var pool *pgxpool.Pool
	if cfg.DatabaseURL != "" {
		var err error
		pool, err = db.Connect(ctx, cfg)
		if err != nil {
			return err
		}
		defer pool.Close()
	}
	fetcher := newCatalogFetcher(ctx, pool, cfg)
	defer func() { stop(); fetcher.Wait() }()
	svc := newIdentity(pool, cfg)
	mailDone := make(chan struct{})
	go func() { defer close(mailDone); runPasswordRecovery(ctx, svc) }()
	defer func() { stop(); <-mailDone }()
	server := &http.Server{
		Addr:              cfg.Bind,
		Handler:           handler(pool, cfg, fetcher, svc),
		ReadHeaderTimeout: 5 * time.Second,
	}
	errCh := make(chan error, 1)
	go func() {
		slog.Info("api listening", "addr", cfg.Bind, "ozon_writes", !cfg.OzonWritesDisabled(), "media_delete", cfg.MediaDeleteEnabled())
		err := server.ListenAndServe()
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
		close(errCh)
	}()
	if pool != nil {
		go RunBackground(ctx, pool, fetcher)
	}
	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			return fmt.Errorf("shutdown: %w", err)
		}
		return nil
	}
}
