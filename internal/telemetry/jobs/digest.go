package jobs

import (
	"context"
	"errors"
	"time"

	"github.com/riverqueue/river"
)

// DigestArgs is the hourly error-digest projection. It is not a jobs row.
type DigestArgs struct{}

func (DigestArgs) Kind() string { return "podhub.error_digest" }

// DigestWorker writes error_digest. Run is supplied by the process assembly.
type DigestWorker struct {
	river.WorkerDefaults[DigestArgs]
	Run func(context.Context, time.Time) error
}

func (w *DigestWorker) Work(ctx context.Context, _ *river.Job[DigestArgs]) error {
	if w == nil || w.Run == nil {
		return errors.New("error digest worker is not wired")
	}
	return w.Run(ctx, time.Now().UTC())
}

// AddWorker adds the digest worker. Its schedule is listed in
// internal/app/worker's periodic table.
func AddWorker(workers *river.Workers, run func(context.Context, time.Time) error) {
	river.AddWorker(workers, &DigestWorker{Run: run})
}
