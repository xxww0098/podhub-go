package jobsched

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Finish, EnqueueOn, and MutateRunning are the repo functions. internal/queue
// assigns them in init. The variables live here so listing/submit can call
// them without importing the queue unit. Signatures match the repo functions,
// so the assignment does not wrap the body.
var (
	Finish        func(ctx context.Context, pool *pgxpool.Pool, lease Lease, terminal string, resultRef []byte, lastError string) (bool, error)
	EnqueueOn     func(ctx context.Context, tx pgx.Tx, jobs []NewJob, laneLimit int64) ([]Queued, error)
	MutateRunning func(ctx context.Context, pool *pgxpool.Pool, lease Lease, fn func(context.Context, pgx.Tx) error) (bool, error)
	// Renew extends a running row's lease. The product-sync loop outruns the
	// claim window and must keep the row it is working.
	Renew func(ctx context.Context, pool *pgxpool.Pool, lease Lease) (bool, error)
	// Requeue hands a running row back for a named wait. The product-sync
	// runner uses it when another owner holds the store's lease.
	Requeue func(ctx context.Context, pool *pgxpool.Pool, lease Lease, reason string, retryAfter time.Duration) (bool, error)
)
