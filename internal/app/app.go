// Package app composes the HTTP server. It does not migrate on startup and
// does not dial a database unless DATABASE_URL is set to a loopback host.
package app

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"

	"github.com/xxww0098/podhub-go/internal/ai"
	httpapi "github.com/xxww0098/podhub-go/internal/app/api"
	_ "github.com/xxww0098/podhub-go/internal/billing"
	billinghttp "github.com/xxww0098/podhub-go/internal/billing/http"
	"github.com/xxww0098/podhub-go/internal/identity"
	"github.com/xxww0098/podhub-go/internal/listing/core"
	listing "github.com/xxww0098/podhub-go/internal/listing/core/contract"
	readhttp "github.com/xxww0098/podhub-go/internal/listing/read/http"
	_ "github.com/xxww0098/podhub-go/internal/listing/rules"
	"github.com/xxww0098/podhub-go/internal/listing/submit"
	ozonerrrepo "github.com/xxww0098/podhub-go/internal/ozonerr/repo"
	ozonerrsvc "github.com/xxww0098/podhub-go/internal/ozonerr/service"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	loadtest "github.com/xxww0098/podhub-go/internal/platform/loadmode"
	storage "github.com/xxww0098/podhub-go/internal/platform/r2"
	sign "github.com/xxww0098/podhub-go/internal/platform/r2/sigv4"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
	"github.com/xxww0098/podhub-go/internal/seller"
)

// Handler is the chi router wrapped for tracing. pool may be nil.
func Handler(pool *pgxpool.Pool) http.Handler {
	router := chi.NewRouter()
	svc := identity.New(pool)
	router.Use(func(next http.Handler) http.Handler {
		return otelhttp.NewHandler(next, "podhub-api")
	})
	router.Use(identity.CSRF)
	router.Use(svc.Middleware)
	cfg := config.Load()
	var recorded httpapi.OzonRecorder
	if pool != nil {
		recorded = ozonerrsvc.New(ozonerrrepo.New(pool))
	}
	srv := &httpapi.Server{
		Pool: pool, Engine: sharedEngine(), Identity: svc, Access: svc,
		Media:  loopbackMedia(),
		Seller: sellerPoster(seller.New(cfg)),
		Seals:  sealRing(cfg),
		// The grant route reads this captured bool. It does not load again.
		WritesDisabled: cfg.OzonWritesDisabled(),
		Ozon:           recorded,
	}
	ai.Register(router, ai.HTTPDeps{Deps: ai.Deps{Pool: pool}, Access: svc})
	billinghttp.Register(router, billinghttp.Deps{Pool: pool, Access: svc})
	mountAgent(router, pool, svc)
	bindListingCore()
	httpapi.RegisterBrowserDirect(router, srv)
	httpapi.HandlerFromMux(srv, router)
	httpapi.MountDomains(router, srv)
	mountPR8A(router, pool, svc, loopbackMedia())
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

var (
	engineOnce     sync.Once
	embeddedEngine listing.Engine
)

func loopbackMedia() *sign.Account {
	account, ok := storage.LoopbackAccount(config.Load())
	if !ok {
		return nil
	}
	return &account
}

// sellerPoster is seller.Egress.Call with write=false. A refused origin or a
// nil egress is unreachable and is not dialed. Saturated slots keep their class
// so catalog can answer 429. The kill switch is the bool seller.New already
// captured; this function does not read OZON_WRITE_KILL_SWITCH.
func sellerPoster(eg *seller.Egress) func(ctx context.Context, path string, body []byte, clientID, apiKey string) (int, []byte, error) {
	return func(ctx context.Context, path string, body []byte, clientID, apiKey string) (int, []byte, error) {
		reply, err := eg.Call(ctx, http.MethodPost, path, body, false, false, clientID, apiKey)
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
	engineOnce.Do(func() {
		var err error
		embeddedEngine, err = listing.OpenEmbedded(context.Background())
		if err != nil {
			// Health still serves. Tag checks fail closed while the engine is nil.
			slog.Error("listing tags wasm", "err", err)
		}
	})
	return embeddedEngine
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
	var pool *pgxpool.Pool
	if cfg.DatabaseURL != "" {
		var err error
		pool, err = db.Connect(ctx, cfg)
		if err != nil {
			return err
		}
		defer pool.Close()
	}
	server := &http.Server{
		Addr:              cfg.Bind,
		Handler:           Handler(pool),
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
	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	if pool != nil {
		go RunBackground(ctx, pool)
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
