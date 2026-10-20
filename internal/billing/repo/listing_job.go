package billingrepo

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// SettleListingJob runs after a listing submit worker returns nil.
// A succeeded job copies one external_task_id into result_ref.taskId when
// that field is missing, then calls ChargeListingSubmit. The ledger rows are
// the ones ChargeListingSubmit already writes. One job produces one charge,
// not one charge per item.
//
// A failed or cancelled job releases a reserved or outcome_unknown operation.
// A settled operation is not refunded. A created operation with no hold is
// left alone. A job that is still running (the crash-after-send path) is
// left alone, so a nil worker return does not charge it.
func SettleListingJob(ctx context.Context, pool *pgxpool.Pool, orgID int64, jobID string) error {
	state, payload, err := jobState(ctx, pool, orgID, jobID)
	if err != nil || state == "" {
		return err
	}
	switch state {
	case "succeeded":
		price := ListingSubmitPriceMicrofen()
		if price <= 0 {
			return nil
		}
		if err := stampTaskID(ctx, pool, orgID, jobID, payload); err != nil {
			return err
		}
		return ChargeListingSubmit(ctx, pool, orgID, jobID, price)
	case "failed", "cancelled":
		return releaseListingHold(ctx, pool, orgID, jobID)
	default:
		return nil
	}
}

func jobState(ctx context.Context, pool *pgxpool.Pool, orgID int64, jobID string) (string, []byte, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return "", nil, err
	}
	defer tx.Rollback(ctx)
	if err := SetOrg(ctx, tx, orgID); err != nil {
		return "", nil, err
	}
	var state string
	var payload []byte
	err = tx.QueryRow(ctx, `
		SELECT state, payload
		  FROM jobs
		 WHERE org_id = $1 AND id = $2::uuid
		   AND kind IN ('listing.submit', 'listing.submit.batch')`, orgID, jobID).Scan(&state, &payload)
	if err == pgx.ErrNoRows {
		return "", nil, tx.Commit(ctx)
	}
	if err != nil {
		return "", nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", nil, err
	}
	return state, payload, nil
}

func stampTaskID(ctx context.Context, pool *pgxpool.Pool, orgID int64, jobID string, payload []byte) error {
	ids := intentIDs(payload)
	if len(ids) == 0 {
		return nil
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := SetOrg(ctx, tx, orgID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE jobs
		   SET result_ref = COALESCE(result_ref, '{}'::jsonb)
		                || jsonb_build_object('taskId', src.external_task_id),
		       updated_at = clock_timestamp()
		  FROM (
		        SELECT external_task_id
		          FROM submission_intents
		         WHERE org_id = $1
		           AND id = ANY($2::uuid[])
		           AND external_task_id ~ '^[1-9][0-9]*$'
		         ORDER BY updated_at DESC
		         LIMIT 1
		       ) src
		 WHERE jobs.org_id = $1
		   AND jobs.id = $3::uuid
		   AND jobs.state = 'succeeded'
		   AND COALESCE(jobs.result_ref->>'taskId', '') !~ '^[1-9][0-9]*$'`,
		orgID, ids, jobID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func intentIDs(payload []byte) []string {
	var body struct {
		IntentID string `json:"intentId"`
		Intents  []struct {
			IntentID string `json:"intentId"`
		} `json:"intents"`
	}
	if json.Unmarshal(payload, &body) != nil {
		return nil
	}
	var ids []string
	if body.IntentID != "" {
		ids = append(ids, body.IntentID)
	}
	for _, item := range body.Intents {
		if item.IntentID != "" {
			ids = append(ids, item.IntentID)
		}
	}
	return ids
}

func releaseListingHold(ctx context.Context, pool *pgxpool.Pool, orgID int64, jobID string) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := SetOrg(ctx, tx, orgID); err != nil {
		return err
	}
	var id int64
	err = tx.QueryRow(ctx, `
		SELECT id FROM billing_operations
		 WHERE org_id = $1 AND idempotency_key = $2
		   AND state IN ('reserved', 'outcome_unknown')`, orgID, jobID).Scan(&id)
	if err == pgx.ErrNoRows {
		return tx.Commit(ctx)
	}
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	_, err = releaseOne(ctx, pool, id)
	return err
}
