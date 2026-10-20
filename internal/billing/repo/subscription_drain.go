package billingrepo

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/platform/db"
)

// DrainDeadline is how long after term_end the drain may run. It exists
// because retry backoff is bounded but "bounded" is not "finite": an
// admission refusal withdraws the attempt, so a job can retry forever.
const DrainDeadline = 24 * time.Hour

// DrainBatch bounds one sweep pass.
const DrainBatch = 200

// FinishDrains closes every drain whose deadline has passed. It cancels the
// still-queued part of the drain range and marks the running part so that a
// later lease reclaim cannot put it back into the active set.
//
// Why the second UPDATE is not optional: ReclaimExpiredRows rewrites a
// running row to retry_wait by `WHERE state = 'running'` and never looks at
// cancel_requested_at. Without the flag, an expired lease on a draining job
// would resurrect it into the active set and the workspace could never leave
// the drain.
func FinishDrains(ctx context.Context, pool *pgxpool.Pool, now time.Time) (int, error) {
	type due struct {
		orgID    int64
		drainID  int64
		deadline time.Time
	}
	var open []due
	err := db.InTx(ctx, pool, db.AppRole(), func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "SELECT set_config('role', 'podhub_billing_lookup', true)"); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `
			SELECT e.org_id, e.id, e.effective_at + $1::interval
			  FROM subscription_events e
			 WHERE e.kind = 'drain'
			   AND NOT EXISTS (
			       SELECT 1 FROM subscription_events d
			        WHERE d.org_id = e.org_id AND d.kind = 'drain_done'
			          AND (d.breakdown->>'drain_event_id')::bigint = e.id)
			   AND e.effective_at + $1::interval <= $2
			 ORDER BY e.id
			 LIMIT $3`, DrainDeadline, now, DrainBatch)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var d due
			if err := rows.Scan(&d.orgID, &d.drainID, &d.deadline); err != nil {
				return err
			}
			open = append(open, d)
		}
		return rows.Err()
	})
	if err != nil {
		return 0, err
	}
	var closed int
	for _, d := range open {
		if err := finishOneDrain(ctx, pool, d.orgID, d.drainID, now); err != nil {
			continue
		}
		closed++
	}
	return closed, nil
}

func finishOneDrain(ctx context.Context, pool *pgxpool.Pool, orgID, drainID int64, now time.Time) error {
	return db.InTx(ctx, pool, db.App(orgID), func(tx pgx.Tx) error {
		var start time.Time
		if err := tx.QueryRow(ctx,
			`SELECT effective_at FROM subscription_events WHERE id = $1 AND org_id = $2`,
			drainID, orgID).Scan(&start); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE jobs
			   SET state = 'cancelled', cancel_requested_at = $3, updated_at = $3
			 WHERE org_id = $1
			   AND created_at < $2
			   AND state IN ('queued', 'retry_wait')
			   AND cancel_requested_at IS NULL
			   AND kind NOT IN ('media.render', 'media.upload')`, orgID, start, now); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE jobs
			   SET cancel_requested_at = $3, updated_at = $3
			 WHERE org_id = $1
			   AND created_at < $2
			   AND state = 'running'
			   AND cancel_requested_at IS NULL
			   AND kind NOT IN ('media.render', 'media.upload')`, orgID, start, now); err != nil {
			return err
		}
		var remaining int64
		if err := tx.QueryRow(ctx, `
			SELECT count(*) FROM jobs j
			 WHERE j.org_id = $1
			   AND j.created_at < $2
			   AND j.kind NOT IN ('media.render', 'media.upload')
			   AND (j.state IN ('queued', 'retry_wait')
			        OR (j.state = 'running' AND j.lease_until > $3))`,
			orgID, start, now).Scan(&remaining); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO subscription_events
			    (org_id, kind, effective_at, breakdown, created_at)
			VALUES ($1, 'drain_done', $2, jsonb_build_object('drain_event_id', $3, 'still_active', $4), clock_timestamp())`,
			orgID, now, drainID, remaining); err != nil {
			return err
		}
		_, err := ProjectSubscription(ctx, tx, orgID, now)
		return err
	})
}

// ActiveDrain reports whether the workspace is draining now.
func ActiveDrain(ctx context.Context, tx pgx.Tx, orgID int64) (bool, error) {
	start, err := DrainStart(ctx, tx, orgID)
	return start != nil, err
}
