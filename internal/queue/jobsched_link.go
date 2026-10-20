package queue

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/platform/jobsched"
	queuedomain "github.com/xxww0098/podhub-go/internal/queue/domain"
	queuerepo "github.com/xxww0098/podhub-go/internal/queue/repo"
)

// init publishes the repo functions that same-level units call through
// platform/jobsched. wire.go holds the service wiring.
func init() {
	jobsched.Finish = queuerepo.Finish
	jobsched.EnqueueOn = queuerepo.EnqueueOn
	jobsched.MutateRunning = queuerepo.MutateRunning
	jobsched.Renew = queuerepo.Renew
	jobsched.Requeue = func(ctx context.Context, pool *pgxpool.Pool, lease jobsched.Lease, reason string, retryAfter time.Duration) (bool, error) {
		return queuerepo.RequeueJob(ctx, pool, lease, queuedomain.RequeueReason(reason), retryAfter)
	}
}
