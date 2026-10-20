package jobsched

import (
	"context"
	"time"
)

// DueScan is one reconciler tick. The seven names and intervals are the
// scheduled-job table. Tick does not claim a job and does not call
// Ozon. ProductSyncBatch stays 0 until ENQUEUE_BATCH_LIMIT is read from
// the Rust source; the scan does not enqueue.
type DueScan struct {
	Name    string
	Base    time.Duration
	IdleMax time.Duration
	Batch   int
	Enabled func() bool
	Tick    func(context.Context) (bool, error)
}
