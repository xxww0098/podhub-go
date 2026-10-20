package scans

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// leaseUnknownWrites claims due result_unknown rows and pushes reconcile_after
// 60 seconds. It does not set reconciled or conflict. That transition was not
// in this workspace (无法对照). The 60 second lease is local.
func leaseUnknownWrites(ctx context.Context, pool *pgxpool.Pool, limit int) (bool, error) {
	var n int64
	err := asWorker(ctx, pool, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `
			UPDATE seller_upstream_writes
			   SET reconcile_after = clock_timestamp() + interval '60 seconds',
			       updated_at = clock_timestamp()
			 WHERE id IN (
			       SELECT id FROM seller_upstream_writes
			        WHERE state = 'result_unknown'
			          AND reconcile_after IS NOT NULL
			          AND reconcile_after <= clock_timestamp()
			        ORDER BY reconcile_after
			        FOR UPDATE SKIP LOCKED
			        LIMIT $1)`, limit)
		if err != nil {
			return err
		}
		n = tag.RowsAffected()
		return nil
	})
	return n > 0, err
}

// leaseGrouping claims pending or partial observations and sets a two-minute
// lease. observation_state is not changed. No Seller request is made.
func leaseGrouping(ctx context.Context, pool *pgxpool.Pool, limit int) (bool, error) {
	var n int64
	err := asWorker(ctx, pool, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `
			UPDATE seller_upstream_writes
			   SET observation_lease_until = clock_timestamp() + interval '2 minutes',
			       observation_lease_epoch = observation_lease_epoch + 1,
			       updated_at = clock_timestamp()
			 WHERE id IN (
			       SELECT id FROM seller_upstream_writes
			        WHERE observation_state IN ('pending', 'partial')
			          AND (observation_next_at IS NULL OR observation_next_at <= clock_timestamp())
			          AND (observation_lease_until IS NULL OR observation_lease_until <= clock_timestamp())
			        ORDER BY observation_next_at NULLS FIRST, updated_at
			        FOR UPDATE SKIP LOCKED
			        LIMIT $1)`, limit)
		if err != nil {
			return err
		}
		n = tag.RowsAffected()
		return nil
	})
	return n > 0, err
}
