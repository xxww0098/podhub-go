package scans

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	delegaterepo "github.com/xxww0098/podhub-go/internal/delegate/repo"
	delegatesvc "github.com/xxww0098/podhub-go/internal/delegate/service"
	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
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
// has an unfinished order. Oldest unserved workspaces run first; an active job
// excludes a second claim. The key is bucket:{n}.
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
			SELECT o.id, o.owner_user_id, o.uuid
			  FROM organizations o
			  LEFT JOIN LATERAL (SELECT max(created_at) AS last_sync FROM jobs
			    WHERE org_id=o.id AND kind='delegate.posting_sync') h ON true
			 WHERE EXISTS (SELECT 1 FROM delegate_orders d WHERE d.org_id=o.id AND d.state NOT IN ('done','cancelled'))
			   AND o.dissolved_at IS NULL
			   AND o.owner_user_id > 0
			   AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.org_id=o.id AND j.kind='delegate.posting_sync'
			     AND j.state IN ('queued','running','retry_wait'))
			 ORDER BY h.last_sync ASC NULLS FIRST,o.id
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

// RunDelegate reads outside transactions and applies each receipt under the job's epoch fence.
func RunDelegate(ctx context.Context, pool *pgxpool.Pool, job queuecontract.Claimed, repo delegaterepo.Repo, seller delegatesvc.Seller) error {
	if job.Kind != "delegate.posting_sync" {
		return queueservice.ErrWorkNotPorted
	}
	targets, err := repo.SyncTargets(ctx, job.OrgID)
	if err != nil {
		return err
	}
	applied, skipped := 0, 0
	var failures []error
	for _, target := range targets {
		update, err := seller.ReadPosting(ctx, delegatesvc.Actor{OrgID: job.OrgID, UserID: job.SubmitterUserID, CanManage: true}, target)
		if err != nil {
			failures = append(failures, fmt.Errorf("posting %s: %w", target.PostingNumber, err))
			continue
		}
		changed := false
		owned, err := queuerepo.MutateRunning(ctx, pool, job.Lease(), func(ctx context.Context, tx pgx.Tx) error {
			if err := tenant.EnterApp(ctx, tx, job.OrgID); err != nil {
				return err
			}
			var err error
			changed, err = repo.ApplyPostingOn(ctx, tx, job.OrgID, job.SubmitterUserID, target, update, time.Now().UnixMilli(), seller.Auto)
			return err
		})
		if err != nil {
			failures = append(failures, err)
			continue
		}
		if !owned {
			return nil
		}
		if changed {
			applied++
		} else {
			skipped++
		}
	}
	if len(failures) != 0 {
		return errors.Join(failures...)
	}
	result, err := json.Marshal(map[string]int{"applied": applied, "skipped": skipped})
	if err != nil {
		return err
	}
	_, err = queuerepo.Finish(ctx, pool, job.Lease(), queuerepo.StateSucceeded, result, "")
	return err
}
