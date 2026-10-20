package app

import (
	"context"
	"errors"
	"log/slog"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/app/scans"
	"github.com/xxww0098/podhub-go/internal/app/worker"
	billingrepo "github.com/xxww0098/podhub-go/internal/billing/repo"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
	_ "github.com/xxww0098/podhub-go/internal/queue"
	queuecontract "github.com/xxww0098/podhub-go/internal/queue/contract"
	queueservice "github.com/xxww0098/podhub-go/internal/queue/service"
	"github.com/xxww0098/podhub-go/internal/seller"
	storerepo "github.com/xxww0098/podhub-go/internal/store/repo"
)

// Install registers worker hooks from the config Main already loaded.
// It does not call Load again, so the two write switches stay a single parse.
func Install(cfg config.Config) {
	ring := seal.Ring{
		Primary:  seal.DeriveKEK(cfg.SellerCredentialKey),
		Previous: seal.DeriveKEK(cfg.SellerCredentialKeyPrevious),
	}
	if cfg.SellerCredentialKey == "" {
		ring.Primary = nil
	}
	if cfg.SellerCredentialKeyPrevious == "" {
		ring.Previous = nil
	}
	worker.SetListingHook(func(ctx context.Context, pool *pgxpool.Pool, orgID int64, jobID string) {
		if err := billingrepo.SettleListingJob(ctx, pool, orgID, jobID); err != nil {
			slog.Error("listing billing", "job", jobID, "err", err)
		}
	})
	worker.SetScanHook(func(list []queueservice.DueScan, pool *pgxpool.Pool, eg *seller.Egress) {
		scans.Attach(list, pool, eg, ring, cfg.ProductSyncDisabled())
	})
	worker.SetReconcileHook(scans.CancelDelegate)
	// The sync role carries the mirror's whole job body. The egress is the same
	// client the HTTP routes read through, so the sync process and the app
	// process share one budget, one rate class and one gate.
	keyID := cfg.SellerCredentialKeyID
	if keyID == "" {
		keyID = seal.DefaultSellerKeyID
	}
	worker.SetProductSyncHook(func(ctx context.Context, pool *pgxpool.Pool, job queuecontract.Claimed) error {
		eg := seller.New(cfg).WithPool(pool)
		return storerepo.RunProductSync(ctx, pool, job, sellerReads{eg}, ring, keyID, sellerAdmissionRefused)
	})
}

// sellerAdmissionRefused separates our own egress gates from a Seller answer.
// A refused origin, a saturated lane, or a budget backend fault means the
// request never left, so the sync charge goes back and the store is not parked.
func sellerAdmissionRefused(err error) bool {
	return errors.Is(err, seller.ErrRefusedOrigin) ||
		errors.Is(err, seller.ErrSaturated) ||
		errors.Is(err, context.Canceled) ||
		errors.Is(err, context.DeadlineExceeded)
}
