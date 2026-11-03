// Package worker is the shared entry for the empty worker processes.
package worker

import (
	"context"
	"fmt"
	queuerepo "github.com/xxww0098/podhub-go/internal/queue/repo"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"

	"github.com/xxww0098/podhub-go/internal/listing/submit"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/httpx"

	loadtest "github.com/xxww0098/podhub-go/internal/platform/loadmode"
	"github.com/xxww0098/podhub-go/internal/platform/observability"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
	queuecontract "github.com/xxww0098/podhub-go/internal/queue/contract"
	queuejobs "github.com/xxww0098/podhub-go/internal/queue/jobs"
	queueservice "github.com/xxww0098/podhub-go/internal/queue/service"
	seller "github.com/xxww0098/podhub-go/internal/seller/ozon"
	telemetryjobs "github.com/xxww0098/podhub-go/internal/telemetry/jobs"
)

// Role names match the Rust process split in src/main.rs, plus the media
// cleaner this skeleton exposes as its own process. Rust runs slice-bucket
// clearing inside the API process (src/media/slice_purge.rs).
const (
	RoleListing   = "listing"
	RoleSync      = "sync"
	RoleReconcile = "reconcile"
	RoleMediaGC   = "media-gc"
)

// Installer receives the config Main just loaded. It may register claim
// and scan hooks. Nil leaves the process on the previous idle scans.
var install func(config.Config)

// SetInstaller registers the hook installer. Call it before Main.
func SetInstaller(fn func(config.Config)) { install = fn }

// ListingHook runs after a listing submit job returns nil.
type ListingHook func(context.Context, *pgxpool.Pool, int64, string)

// ScanHook replaces idle ticks after Attach.
type ScanHook func([]queueservice.DueScan, *pgxpool.Pool, *seller.Egress)

// ReconcileHook owns delegate.posting_sync after it is claimed.
type ReconcileHook func(context.Context, *pgxpool.Pool, queuecontract.Claimed) error

// ProductSyncHook is the store.product_sync body. The sync role claims it and
// no other kind, so a nil hook leaves that process refusing work rather than
// quietly settling it.
type ProductSyncHook func(context.Context, *pgxpool.Pool, queuecontract.Claimed) error

var (
	listingHook     ListingHook
	scanHook        ScanHook
	reconcileHook   ReconcileHook
	productSyncHook ProductSyncHook
)

// SetListingHook is the billing step. The worker does not import billing.
func SetListingHook(fn ListingHook) { listingHook = fn }

// SetScanHook is the six due-scan bodies. UnknownImportsScan stays as seller left it.
func SetScanHook(fn ScanHook) { scanHook = fn }

// SetReconcileHook settles delegate.posting_sync claims. Other kinds stay not-ported.
func SetReconcileHook(fn ReconcileHook) { reconcileHook = fn }

// SetProductSyncHook runs store.product_sync claims.
func SetProductSyncHook(fn ProductSyncHook) { productSyncHook = fn }

// Main loads config, refuses non-loopback databases, and does not call Ozon.
func Main(role string) int {
	cfg := config.Load()
	if err := httpx.ConfigureDNS(cfg.DNSServer); err != nil {
		fmt.Fprintf(os.Stderr, "dns: %v\n", err)
		return 1
	}
	if _, err := cfg.SellerEgressRoutes(); err != nil {
		fmt.Fprintln(os.Stderr, "seller egress routes: invalid CLOUD_SELLER_EGRESS_ROUTES")
		return 1
	}
	if install != nil {
		install(cfg)
	}
	shutdown, err := observability.Init("podhub-worker-"+role, cfg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "observability: %v\n", err)
		return 1
	}
	defer shutdown(context.Background())

	if cfg.LoadTestMode != "" {
		if err := loadtest.Run(cfg.LoadTestMode); err != nil {
			slog.Error("load test mode refused", "err", err)
			return 1
		}
	}

	switch role {
	case RoleMediaGC:
		return runMediaGC(cfg)
	case RoleListing, RoleSync, RoleReconcile:
		return runQueue(role, cfg)
	default:
		slog.Error("unknown worker role", "role", role)
		return 1
	}
}

func runMediaGC(cfg config.Config) int {
	if !cfg.MediaDeleteEnabled() {
		slog.Info("media gc idle; CLOUD_MEDIA_GC_DELETE is off")
		return 0
	}
	if cfg.DatabaseURL == "" || len(strings.TrimSpace(cfg.IntegrationConfigKey)) < 32 {
		slog.Error("media gc requires the database and slice credential encryption key")
		return 1
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	pool, err := db.Connect(ctx, cfg)
	if err != nil {
		slog.Error("database", "role", RoleMediaGC, "err", err)
		return 1
	}
	defer pool.Close()
	slog.Info("media gc watching workspace slice storage")
	for {
		RunWorkspaceSliceClears(ctx, pool, seal.DeriveKEK(cfg.IntegrationConfigKey))
		wait := time.Minute
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return 0
		case <-timer.C:
		}
	}
}

func runQueue(role string, cfg config.Config) int {
	if role != RoleListing {
		if !cfg.OzonWritesDisabled() {
			slog.Warn("Ozon writes are open for this process; the worker still does not send")
		}
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	pool, err := db.Connect(ctx, cfg)
	if err != nil {
		slog.Error("database", "role", role, "err", err)
		return 1
	}
	defer pool.Close()
	client, err := queuejobs.Start(ctx, pool, riverAddons(pool, cfg)...)
	if err != nil {
		slog.Error("river", "role", role, "err", err)
		return 1
	}
	done := make(chan error, 1)
	go func() {
		done <- queueservice.Run(ctx, pool, queueOptions(role, cfg, pool))
	}()
	slog.Info("worker claim loop", "role", role, "kinds", queueservice.KindsForRole(role))
	exited := false
	select {
	case <-ctx.Done():
	case err := <-done:
		exited = true
		if err != nil {
			slog.Error("queue", "role", role, "err", err)
			stop()
			if stopErr := client.Stop(context.Background()); stopErr != nil {
				slog.Error("river stop", "err", stopErr)
			}
			return 1
		}
	}
	stop()
	if !exited {
		select {
		case err := <-done:
			if err != nil {
				slog.Error("queue", "role", role, "err", err)
				return 1
			}
		case <-time.After(10 * time.Second):
			slog.Error("queue did not stop")
			return 1
		}
	}
	if err := client.Stop(context.Background()); err != nil {
		slog.Error("river stop", "err", err)
		return 1
	}
	return 0
}

func errorDigestAddon(pool *pgxpool.Pool) queuejobs.Addon {
	return queuejobs.Addon{Register: func(workers *river.Workers) []*river.PeriodicJob {
		telemetryjobs.AddWorker(workers, func(ctx context.Context, now time.Time) error {
			return RunErrorDigestHour(ctx, pool, now)
		})
		return nil
	}}
}

func queueOptions(role string, cfg config.Config, pool *pgxpool.Pool) queueservice.Options {
	opts := queueservice.Options{
		Repo:    queueservice.Repository{Claim: queuerepo.Claim, FormatOwner: queuerepo.FormatOwner, ReclaimExpiredRows: queuerepo.ReclaimExpiredRows, RunningOwned: queuerepo.RunningOwned, RequeueJob: queuerepo.RequeueJob},
		Role:    role,
		Kinds:   queueservice.KindsForRole(role),
		Limit:   cfg.InFlight(role),
		LaneCap: cfg.LaneQueuedCostLimit(),
		Config:  cfg,
		Seat:    role == RoleReconcile,
	}
	if role == RoleListing {
		eg := seller.New(cfg).WithPool(pool)
		tr := ListingTransport(eg, pool, ratingRing(cfg), listingKeyID(cfg))
		svc := submit.Service{Queue: submit.Queue{EnqueueOn: queuerepo.EnqueueOn, MutateRunning: queuerepo.MutateRunning}}
		opts.Work = func(ctx context.Context, pool *pgxpool.Pool, job queuecontract.Claimed) error {
			err := svc.Work(ctx, pool, job, tr)
			if err == nil && listingHook != nil {
				listingHook(ctx, pool, job.OrgID, job.ID.String())
			}
			return err
		}
	}
	if role == RoleSync {
		if productSyncHook != nil {
			hook := productSyncHook
			opts.Work = func(ctx context.Context, pool *pgxpool.Pool, job queuecontract.Claimed) error {
				return hook(ctx, pool, job)
			}
		}
	}
	if role == RoleReconcile {
		eg := seller.New(cfg).WithPool(pool)
		tr := ListingTransport(eg, pool, ratingRing(cfg), listingKeyID(cfg))
		opts.PrepareScans = func(scans []queueservice.DueScan) {
			Attach(scans, pool, eg, tr)
			if scanHook != nil {
				scanHook(scans, pool, eg)
			}
		}
		if reconcileHook != nil {
			hook := reconcileHook
			opts.Work = func(ctx context.Context, pool *pgxpool.Pool, job queuecontract.Claimed) error {
				if job.Kind == "delegate.posting_sync" {
					return hook(ctx, pool, job)
				}
				return queueservice.ErrWorkNotPorted
			}
		}
	}
	return opts
}

func listingKeyID(cfg config.Config) string {
	if cfg.SellerCredentialKeyID != "" {
		return cfg.SellerCredentialKeyID
	}
	return seal.DefaultSellerKeyID
}
