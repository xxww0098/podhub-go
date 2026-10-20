package worker

import (
	"context"
	"log/slog"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/listing/submit"
	queueservice "github.com/xxww0098/podhub-go/internal/queue/service"
)

// Attach replaces the idle ticks on the seven reconciler scans.
//
// UnknownImportsScan runs the import probe (claim, /v3/product/info/list,
// two agreeing absences). The other six call the business entry that this
// port has. Product sync, its cleanup, delegate sync, accepted imports,
// product grouping, and unknown-write settlement do not have their Rust
// SQL in this process; their ticks log that and return idle so they cannot
// invent a job. The gap list is in docs/parity/seller-parity.md.
func Attach(scans []queueservice.DueScan, pool *pgxpool.Pool, eg *Egress) {
	for i := range scans {
		switch scans[i].Name {
		case "UnknownImportsScan":
			batch := scans[i].Batch
			scans[i].Tick = func(ctx context.Context) (bool, error) {
				n, err := submit.ProbeDue(ctx, pool, eg.Port(), batch)
				return n > 0, err
			}
		case "UnknownWritesScan":
			scans[i].Tick = idleNamed("UnknownWritesScan")
		case "ProductSyncScan":
			scans[i].Tick = idleNamed("ProductSyncScan")
		case "ProductSyncCleanupScan":
			scans[i].Tick = idleNamed("ProductSyncCleanupScan")
		case "DelegateSyncScan":
			scans[i].Tick = idleNamed("DelegateSyncScan")
		case "ProductGroupingScan":
			scans[i].Tick = idleNamed("ProductGroupingScan")
		case "AcceptedImportsScan":
			scans[i].Tick = idleNamed("AcceptedImportsScan")
		}
	}
}

func idleNamed(name string) func(context.Context) (bool, error) {
	return func(context.Context) (bool, error) {
		slog.Info("reconcile scan has no ported writer", "scan", name)
		return false, nil
	}
}
