package submit

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"

	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

// recoverStuckSubmitting is the safety net for a submitting intent whose
// job has already failed. The reconciler only claims unknown and accepted,
// so without this a failed job would leave the intent in submitting forever.
// A stored task id is accepted without another seller request. A missing
// task id is parked to unknown so the existing probe can run. The unknown
// stamp statements are not used here.
func recoverStuckSubmitting(ctx context.Context, pool *pgxpool.Pool, limit int) (int, error) {
	if limit <= 0 {
		limit = 16
	}
	rows, err := claimStuck(ctx, pool, limit)
	if err != nil || len(rows) == 0 {
		return len(rows), err
	}
	n := 0
	for _, row := range rows {
		if err := applyStuck(ctx, pool, row); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}

type stuckIntent struct {
	ID       string
	OrgID    int64
	RowID    string
	Revision int64
	Task     string
}

func claimStuck(ctx context.Context, pool *pgxpool.Pool, limit int) ([]stuckIntent, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if err := tenant.EnterWorker(ctx, tx); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
		SELECT i.id::text, i.org_id, i.listing_row_id::text, i.row_revision,
		       COALESCE(i.external_task_id, '')
		  FROM public.submission_intents i
		 WHERE i.state = 'submitting'
		   AND i.updated_at <= clock_timestamp() - interval '30 seconds'
		   AND EXISTS (
		     SELECT 1 FROM public.jobs j
		      WHERE j.org_id = i.org_id
		        AND j.state = 'failed'
		        AND j.kind IN ('listing.submit', 'listing.submit.batch')
		        AND (
		          j.payload->>'intentId' = i.id::text
		          OR EXISTS (
		            SELECT 1
		              FROM jsonb_array_elements(COALESCE(j.payload->'intents', '[]'::jsonb)) elem
		             WHERE elem->>'intentId' = i.id::text
		          )
		        )
		   )
		 ORDER BY i.updated_at
		 LIMIT $1
		 FOR UPDATE OF i SKIP LOCKED`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []stuckIntent
	for rows.Next() {
		var row stuckIntent
		if err := rows.Scan(&row.ID, &row.OrgID, &row.RowID, &row.Revision, &row.Task); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func applyStuck(ctx context.Context, pool *pgxpool.Pool, row stuckIntent) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := tenant.EnterApp(ctx, tx, row.OrgID); err != nil {
		return err
	}
	if row.Task != "" {
		tag, err := tx.Exec(ctx, `
			UPDATE public.submission_intents
			   SET state = 'accepted',
			       reconcile_after = NULL,
			       reconcile_claim_until = NULL,
			       updated_at = clock_timestamp()
			 WHERE org_id = $1 AND id = $2::uuid AND state = 'submitting'
			   AND external_task_id IS NOT NULL`, row.OrgID, row.ID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 1 && row.RowID != "" {
			if _, err := tx.Exec(ctx, setRowStateSQL, row.OrgID, row.RowID, row.Revision, Accepted); err != nil {
				return err
			}
		}
		return tx.Commit(ctx)
	}
	tag, err := tx.Exec(ctx, `
		UPDATE public.submission_intents
		   SET state = 'unknown',
		       last_error_code = $3,
		       reconcile_after = clock_timestamp() + interval '30 seconds',
		       reconcile_claim_until = NULL,
		       updated_at = clock_timestamp()
		 WHERE org_id = $1 AND id = $2::uuid AND state = 'submitting'
		   AND external_task_id IS NULL`, row.OrgID, row.ID, CodeSubmitInFlight)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 1 && row.RowID != "" {
		if _, err := tx.Exec(ctx, setRowStateSQL, row.OrgID, row.RowID, row.Revision, Unknown); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
