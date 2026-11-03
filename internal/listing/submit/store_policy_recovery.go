package submit

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

type failedPolicySplit struct {
	orgID, userID, epoch int64
	jobID                uuid.UUID
	lane                 string
}

// A persisted policy remainder proves this job was split before dispatch.
// Failed jobs with any send evidence retain the existing unknown-result path.
func recoverPolicySplits(ctx context.Context, pool *pgxpool.Pool, limit int) (int, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	if err := tenant.EnterWorker(ctx, tx); err != nil {
		return 0, err
	}
	rows, err := tx.Query(ctx, `SELECT j.id,j.org_id,j.submitter_user_id,j.lease_epoch,j.lane
	 FROM public.jobs j WHERE j.kind='listing.submit.batch' AND j.state='failed'
	 AND j.lease_owner IS NULL AND j.lease_until IS NULL
	 AND jsonb_typeof(j.payload->'intents')='array' AND jsonb_array_length(j.payload->'intents')>0
	 AND EXISTS (SELECT 1 FROM public.jobs remainder WHERE remainder.org_id=j.org_id AND remainder.kind=j.kind
	   AND remainder.idempotency_key LIKE 'policy:' || j.id::text || ':%')
	 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(j.payload->'intents') item
	   LEFT JOIN public.submission_intents i ON i.org_id=j.org_id AND i.id::text=item->>'intentId'
	   WHERE i.id IS NULL OR i.state<>'queued' OR i.external_task_id IS NOT NULL OR i.submission_receipt IS NOT NULL
	   OR i.credential_granted_at IS NOT NULL OR i.revoked_at IS NOT NULL OR i.cancel_requested_at IS NOT NULL
	   OR i.store_id::text IS DISTINCT FROM j.payload->>'storeId'
	   OR i.listing_row_id::text IS DISTINCT FROM item->>'rowId'
	   OR i.row_revision::text IS DISTINCT FROM item->>'rowRevision'
	   OR i.request_hash IS DISTINCT FROM item->>'requestHash'
	   OR EXISTS(SELECT 1 FROM public.seller_upstream_writes w WHERE w.org_id=j.org_id AND w.idempotency_key=i.id::text))
	 ORDER BY j.updated_at,j.id LIMIT $1`, limit)
	if err != nil {
		return 0, err
	}
	var failed []failedPolicySplit
	for rows.Next() {
		var job failedPolicySplit
		if err := rows.Scan(&job.jobID, &job.orgID, &job.userID, &job.epoch, &job.lane); err != nil {
			rows.Close()
			return 0, err
		}
		failed = append(failed, job)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	recovered := 0
	for _, job := range failed {
		ok, err := recoverPolicySplit(ctx, pool, job)
		if err != nil {
			return recovered, err
		}
		if ok {
			recovered++
		}
	}
	return recovered, nil
}

func recoverPolicySplit(ctx context.Context, pool *pgxpool.Pool, job failedPolicySplit) (bool, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	if err := tenant.EnterWorker(ctx, tx); err != nil {
		return false, err
	}
	// Match the queue's head-before-job order; skip busy organization/intent
	// rows so a cancellation holding them never waits on our head lock.
	if _, err := tx.Exec(ctx, `INSERT INTO public.account_queue_head(user_id,lane) VALUES($1,$2)
	 ON CONFLICT(user_id,lane) DO UPDATE SET lane=public.account_queue_head.lane`, job.userID, job.lane); err != nil {
		return false, err
	}
	var orgID int64
	if err := tx.QueryRow(ctx, `SELECT id FROM public.organizations WHERE id=$1 AND dissolved_at IS NULL FOR NO KEY UPDATE SKIP LOCKED`, job.orgID).Scan(&orgID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	var payload []byte
	if err := tx.QueryRow(ctx, `SELECT payload FROM public.jobs WHERE id=$1 AND org_id=$2 AND submitter_user_id=$3
	 AND lane=$4 AND lease_epoch=$5 AND state='failed' AND lease_owner IS NULL AND lease_until IS NULL
	 FOR UPDATE SKIP LOCKED`, job.jobID, job.orgID, job.userID, job.lane, job.epoch).Scan(&payload); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	var body batchJob
	if json.Unmarshal(payload, &body) != nil || len(body.Intents) == 0 {
		return false, nil
	}
	store, err := uuid.Parse(body.StoreID)
	if err != nil {
		return false, nil
	}
	expected := make(map[string]batchIntent, len(body.Intents))
	ids := make([]string, 0, len(body.Intents))
	for _, in := range body.Intents {
		if _, err := uuid.Parse(in.IntentID); err != nil {
			return false, nil
		}
		if _, duplicate := expected[in.IntentID]; duplicate {
			return false, nil
		}
		expected[in.IntentID] = in
		ids = append(ids, in.IntentID)
	}
	rows, err := tx.Query(ctx, `SELECT id::text,store_id::text,listing_row_id::text,row_revision,request_hash,
	 state='queued' AND external_task_id IS NULL AND submission_receipt IS NULL
	 AND credential_granted_at IS NULL AND revoked_at IS NULL AND cancel_requested_at IS NULL
	 FROM public.submission_intents WHERE org_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE SKIP LOCKED`, job.orgID, ids)
	if err != nil {
		return false, err
	}
	locked := 0
	valid := true
	for rows.Next() {
		var id, storedStore, rowID, hash string
		var revision int64
		var unsent bool
		if err := rows.Scan(&id, &storedStore, &rowID, &revision, &hash, &unsent); err != nil {
			rows.Close()
			return false, err
		}
		in, ok := expected[id]
		valid = valid && ok && unsent && storedStore == store.String() && rowID == in.RowID && revision == in.RowRevision && hash == in.RequestHash
		locked++
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return false, err
	}
	if !valid || locked != len(ids) {
		return false, nil
	}
	var evidence bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM public.seller_upstream_writes WHERE org_id=$1 AND idempotency_key=ANY($2::text[]))
	 OR EXISTS(SELECT 1 FROM public.seller_resource_occupancies WHERE org_id=$1 AND owner_kind='store_write' AND owner_ref=ANY($2::text[]))
	 OR EXISTS(SELECT 1 FROM public.jobs other WHERE other.org_id=$1 AND other.id<>$3 AND other.kind IN ('listing.submit','listing.submit.batch')
	   AND other.state IN ('queued','retry_wait','running','uncertain') AND (other.payload->>'intentId'=ANY($2::text[])
	     OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(other.payload->'intents','[]'::jsonb)) item WHERE item->>'intentId'=ANY($2::text[]))))`, job.orgID, ids, job.jobID).Scan(&evidence); err != nil {
		return false, err
	}
	if evidence {
		return false, nil
	}
	tag, err := tx.Exec(ctx, `UPDATE public.jobs SET state='retry_wait',attempt=GREATEST(attempt-1,0),run_at=clock_timestamp(),
	 lease_owner=NULL,lease_until=NULL,lease_epoch=lease_epoch+1,last_error_code=NULL,
	 result_ref=jsonb_build_object('outcome','waiting','reason','policy_split_not_dispatched'),updated_at=clock_timestamp()
	 WHERE id=$1 AND org_id=$2 AND state='failed' AND lease_epoch=$3 AND lease_owner IS NULL AND lease_until IS NULL`, job.jobID, job.orgID, job.epoch)
	if err != nil {
		return false, err
	}
	if tag.RowsAffected() != 1 {
		return false, nil
	}
	return true, tx.Commit(ctx)
}
