package jobs

import (
	"context"
	"errors"

	"github.com/riverqueue/river"
)

// SyncArgs is the staggered seller-info sync. It is not a jobs row.
type SyncArgs struct{}

func (SyncArgs) Kind() string { return "podhub.store_rating_sync" }

// PruneArgs deletes rating history past the retention window.
type PruneArgs struct{}

func (PruneArgs) Kind() string { return "podhub.store_rating_prune" }

// SyncWorker runs one claim pass. Run is supplied by the process assembly.
type SyncWorker struct {
	river.WorkerDefaults[SyncArgs]
	Run func(context.Context) error
}

func (w *SyncWorker) Work(ctx context.Context, _ *river.Job[SyncArgs]) error {
	if w == nil || w.Run == nil {
		return errors.New("store rating sync is not wired")
	}
	return w.Run(ctx)
}

// PruneWorker runs one retention delete.
type PruneWorker struct {
	river.WorkerDefaults[PruneArgs]
	Run func(context.Context) error
}

func (w *PruneWorker) Work(ctx context.Context, _ *river.Job[PruneArgs]) error {
	if w == nil || w.Run == nil {
		return errors.New("store rating prune is not wired")
	}
	return w.Run(ctx)
}

// AddWorkers adds the sync and prune workers. Their schedules are listed in
// internal/app/worker's periodic table.
func AddWorkers(workers *river.Workers, sync, prune func(context.Context) error) {
	river.AddWorker(workers, &SyncWorker{Run: sync})
	river.AddWorker(workers, &PruneWorker{Run: prune})
}
