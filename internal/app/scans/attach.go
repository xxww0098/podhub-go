// Package scans is the six reconciler ticks that seller.Attach leaves idle.
// UnknownImportsScan is not replaced.
//
// SQL that changes a business state was not copied from Rust (无法对照).
// Where the transition is unknown, the tick only leases the due row.
package scans

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
	_ "github.com/xxww0098/podhub-go/internal/queue"
	queueservice "github.com/xxww0098/podhub-go/internal/queue/service"
	"github.com/xxww0098/podhub-go/internal/seller"
	storerepo "github.com/xxww0098/podhub-go/internal/store/repo"
)

// Attach overwrites the six idle ticks. seller.Attach has already wired
// UnknownImportsScan. Call this after that.
func Attach(list []queueservice.DueScan, pool *pgxpool.Pool, eg *seller.Egress, ring seal.Ring, syncDisabled bool) {
	for i := range list {
		batch := list[i].Batch
		switch list[i].Name {
		case "UnknownWritesScan":
			list[i].Tick = func(ctx context.Context) (bool, error) {
				return leaseUnknownWrites(ctx, pool, batchOr(batch, 16))
			}
		case "ProductSyncScan":
			list[i].Tick = func(ctx context.Context) (bool, error) {
				n, err := storerepo.SweepDueProductSync(ctx, pool, batchOr(batch, 32), syncDisabled)
				return n > 0, err
			}
		case "ProductSyncCleanupScan":
			list[i].Tick = func(ctx context.Context) (bool, error) {
				return cleanupPassPages(ctx, pool)
			}
		case "DelegateSyncScan":
			interval := list[i].Base
			list[i].Tick = func(ctx context.Context) (bool, error) {
				n, err := EnqueueDelegateSync(ctx, pool, batchOr(batch, delegateCap), interval)
				return n > 0, err
			}
		case "ProductGroupingScan":
			list[i].Tick = func(ctx context.Context) (bool, error) {
				return leaseGrouping(ctx, pool, batchOr(batch, 16))
			}
		case "AcceptedImportsScan":
			list[i].Tick = func(ctx context.Context) (bool, error) {
				return probeAccepted(ctx, pool, eg, ring, batchOr(batch, 16))
			}
		}
	}
}

func batchOr(batch, fallback int) int {
	if batch <= 0 {
		return fallback
	}
	return batch
}

func asWorker(ctx context.Context, pool interface {
	Begin(ctx context.Context) (pgx.Tx, error)
}, fn func(pgx.Tx) error) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := tenant.EnterWorker(ctx, tx); err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
