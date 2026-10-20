package scans

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	queuecontract "github.com/xxww0098/podhub-go/internal/queue/contract"
	queuedomain "github.com/xxww0098/podhub-go/internal/queue/domain"
	queuerepo "github.com/xxww0098/podhub-go/internal/queue/repo"
	queueservice "github.com/xxww0098/podhub-go/internal/queue/service"
)

// delegateCap is the org limit when the scan batch is zero. The reference
// batch leaves that cell blank (无法对照), so it is not a constant.
const delegateCap = 16

// DelegateBucket is unix milliseconds divided by the interval.
// A non-positive interval uses one minute. The same bucket is the idempotency key.
func DelegateBucket(now time.Time, interval time.Duration) int64 {
	if interval <= 0 {
		interval = time.Minute
	}
	return now.UnixMilli() / interval.Milliseconds()
}

// EnqueueDelegateSync inserts one delegate.posting_sync job per org that still
// has an order outside done and cancelled. The key is bucket:{n}. The worker
// cancels the job; this function does not dial and does not change orders.
func EnqueueDelegateSync(ctx context.Context, pool *pgxpool.Pool, limit int, interval time.Duration) (int, error) {
	if limit <= 0 {
		return 0, nil
	}
	bucket := DelegateBucket(time.Now(), interval)
	type org struct {
		id    int64
		owner int64
		uid   uuid.UUID
	}
	var orgs []org
	err := asWorker(ctx, pool, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT DISTINCT o.id, o.owner_user_id, o.uuid
			  FROM organizations o
			  JOIN delegate_orders d ON d.org_id = o.id
			 WHERE d.state NOT IN ('done', 'cancelled')
			   AND o.dissolved_at IS NULL
			   AND o.owner_user_id > 0
			 ORDER BY o.id
			 LIMIT $1`, limit)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var row org
			if err := rows.Scan(&row.id, &row.owner, &row.uid); err != nil {
				return err
			}
			orgs = append(orgs, row)
		}
		return rows.Err()
	})
	if err != nil || len(orgs) == 0 {
		return 0, err
	}
	jobs := make([]queuecontract.NewJob, 0, len(orgs))
	for _, row := range orgs {
		jobs = append(jobs, queuecontract.NewJob{
			ID:              uuid.New(),
			OrgID:           row.id,
			Kind:            "delegate.posting_sync",
			AggregateType:   "organization",
			AggregateID:     row.uid,
			InputRevision:   1,
			IdempotencyKey:  fmt.Sprintf("bucket:%d", bucket),
			Payload:         []byte(fmt.Sprintf(`{"bucket":%d}`, bucket)),
			SubmitterUserID: row.owner,
			MaxAttempts:     1,
			Priority:        queuedomain.DefaultBusinessPriority,
			RunAt:           time.Now(),
		})
	}
	queued, err := queuerepo.Enqueue(ctx, pool, jobs, queuedomain.AccountLaneQueuedCostLimit)
	if err != nil {
		return 0, err
	}
	n := 0
	for _, row := range queued {
		if row.Inserted {
			n++
		}
	}
	return n, nil
}

// CancelDelegate finishes delegate.posting_sync as cancelled. It does not
// mark the job succeeded, does not dial, and does not update delegate_orders.
func CancelDelegate(ctx context.Context, pool *pgxpool.Pool, job queuecontract.Claimed) error {
	if job.Kind != "delegate.posting_sync" {
		return queueservice.ErrWorkNotPorted
	}
	_, err := queuerepo.Finish(ctx, pool, job.Lease(), queuerepo.StateCancelled, []byte(`{"reason":"body_not_ported"}`), "not_ported")
	return err
}
