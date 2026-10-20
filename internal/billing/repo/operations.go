package billingrepo

import (
	"context"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

// ListingSubmitPriceMicrofen parses CLOUD_LISTING_SUBMIT_PRICE_MICROFEN.
// Only a trimmed integer greater than zero is a price. Zero means the work is not sold.
func ListingSubmitPriceMicrofen() int64 { return config.ListingSubmitPriceMicrofen() }

type operation struct {
	ID       int64
	OrgID    int64
	Key      string
	Expected int64
	State    string
}

// ChargeListingSubmit charges one succeeded listing submit once.
// price <= 0 returns nil. A missing job commits without a charge.
// This function is not called from the queue worker.
func ChargeListingSubmit(ctx context.Context, pool *pgxpool.Pool, orgID int64, idempotencyKey string, price int64) error {
	if price <= 0 {
		return nil
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config($1, $2, true)`, tenantx.GUCCurrentOrgID, strconvFormat(orgID)); err != nil {
		return err
	}
	var jobID string
	err = tx.QueryRow(ctx, `
		SELECT id FROM jobs
		 WHERE org_id = $1 AND id = $2::uuid
		   AND kind IN ('listing.submit', 'listing.submit.batch')
		   AND state = 'succeeded'
		   AND result_ref->>'taskId' ~ '^[1-9][0-9]*$'
		 FOR SHARE`, orgID, idempotencyKey).Scan(&jobID)
	if err == pgx.ErrNoRows {
		return tx.Commit(ctx)
	}
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO billing_operations (org_id, idempotency_key, price_snapshot_version, expected_upper_bound_microfen)
		VALUES ($1, $2, 1, $3) ON CONFLICT (idempotency_key) DO NOTHING`, orgID, idempotencyKey, price); err != nil {
		return err
	}
	op, err := lockOperation(ctx, tx, idempotencyKey)
	if err != nil {
		return err
	}
	if op.State == "created" {
		if _, err := HoldTx(ctx, tx, orgID, idempotencyKey, nil, price); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `
			UPDATE billing_operations SET state = 'reserved', updated_at = clock_timestamp()
			 WHERE id = $1 AND state = 'created'`, op.ID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return &Error{Msg: "billing operation reservation update affected an unexpected row count"}
		}
		op.State = "reserved"
	}
	if op.State != "settled" && op.State != "reconciliation_settled" {
		settlement, err := SettleTx(ctx, tx, orgID, idempotencyKey, nil, price, price)
		if err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `
			UPDATE billing_operations
			   SET state = 'settled', actual_microfen = $2, updated_at = clock_timestamp()
			 WHERE id = $1 AND actual_microfen IS NULL`, op.ID, settlement.ChargedMicrofen)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return &Error{Msg: "billing operation settlement update affected an unexpected row count"}
		}
	}
	if _, err := tx.Exec(ctx, `RESET ROLE`); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func lockOperation(ctx context.Context, tx pgx.Tx, key string) (operation, error) {
	var op operation
	err := tx.QueryRow(ctx, `
		SELECT id, org_id, idempotency_key, expected_upper_bound_microfen, state
		  FROM billing_operations WHERE idempotency_key = $1 FOR UPDATE`, key).Scan(
		&op.ID, &op.OrgID, &op.Key, &op.Expected, &op.State)
	if err == pgx.ErrNoRows {
		return operation{}, &Error{Msg: "billing operation vanished after upsert"}
	}
	return op, err
}

func strconvFormat(n int64) string {
	return strconv.FormatInt(n, 10)
}

// ReapReservations releases holds older than olderThan. Each candidate is its own transaction.
func ReapReservations(ctx context.Context, pool *pgxpool.Pool, olderThan time.Duration, limit int64) (int64, error) {
	seconds := int64(olderThan / time.Second)
	if seconds < 0 {
		seconds = 0
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	rows, err := tx.Query(ctx, `
		SELECT id, org_id, idempotency_key, expected_upper_bound_microfen, state
		  FROM billing_operations
		 WHERE state IN ('reserved', 'outcome_unknown')
		   AND updated_at < clock_timestamp() - ($1 || ' seconds')::interval
		 ORDER BY updated_at ASC
		 LIMIT $2`, strconvFormat(seconds), limit)
	if err != nil {
		tx.Rollback(ctx)
		return 0, err
	}
	var candidates []operation
	for rows.Next() {
		var op operation
		if err := rows.Scan(&op.ID, &op.OrgID, &op.Key, &op.Expected, &op.State); err != nil {
			rows.Close()
			tx.Rollback(ctx)
			return 0, err
		}
		candidates = append(candidates, op)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		tx.Rollback(ctx)
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	var released int64
	for _, candidate := range candidates {
		n, err := releaseOne(ctx, pool, candidate.ID)
		if err != nil {
			continue
		}
		released += n
	}
	return released, nil
}

func releaseOne(ctx context.Context, pool *pgxpool.Pool, id int64) (int64, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	var op operation
	err = tx.QueryRow(ctx, `
		SELECT id, org_id, idempotency_key, expected_upper_bound_microfen, state
		  FROM billing_operations
		 WHERE id = $1 AND state IN ('reserved', 'outcome_unknown')
		 FOR UPDATE`, id).Scan(&op.ID, &op.OrgID, &op.Key, &op.Expected, &op.State)
	if err == pgx.ErrNoRows {
		return 0, tx.Commit(ctx)
	}
	if err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
		return 0, err
	}
	if _, err := ReleaseTx(ctx, tx, op.OrgID, op.Key, nil, op.Expected, "billing_reaper_expired"); err != nil {
		return 0, err
	}
	tag, err := tx.Exec(ctx, `
		UPDATE billing_operations SET state = 'released', updated_at = clock_timestamp()
		 WHERE id = $1 AND state IN ('reserved', 'outcome_unknown')`, op.ID)
	if err != nil {
		return 0, err
	}
	if tag.RowsAffected() != 1 {
		return 0, nil
	}
	if _, err := tx.Exec(ctx, `RESET ROLE`); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return 1, nil
}
