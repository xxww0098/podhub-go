package jobs

import (
	"context"
	"testing"

	"github.com/riverqueue/river"
)

func TestRegisterWorkers(t *testing.T) {
	var syncN, pruneN int
	workers := river.NewWorkers()
	AddWorkers(workers,
		func(context.Context) error { syncN++; return nil },
		func(context.Context) error { pruneN++; return nil },
	)
	if river.AddWorkerSafely(workers, &SyncWorker{}) == nil || river.AddWorkerSafely(workers, &PruneWorker{}) == nil {
		t.Fatal("sync and prune workers were not added")
	}
	if err := (&SyncWorker{Run: func(context.Context) error { syncN++; return nil }}).Work(context.Background(), &river.Job[SyncArgs]{}); err != nil || syncN != 1 {
		t.Fatalf("sync %d %v", syncN, err)
	}
	if err := (&PruneWorker{Run: func(context.Context) error { pruneN++; return nil }}).Work(context.Background(), &river.Job[PruneArgs]{}); err != nil || pruneN != 1 {
		t.Fatalf("prune %d %v", pruneN, err)
	}
	if err := (&SyncWorker{}).Work(context.Background(), &river.Job[SyncArgs]{}); err == nil {
		t.Fatal("unwired sync")
	}
	if (SyncArgs{}).Kind() != "podhub.store_rating_sync" || (PruneArgs{}).Kind() != "podhub.store_rating_prune" {
		t.Fatal("kind")
	}
}
