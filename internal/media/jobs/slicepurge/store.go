package slicepurge

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Claim is one running receipt.
type Claim struct {
	Fingerprint string
	RunDay      time.Time
	Token       string
	Epoch       int64
}

// PG is the durable budget. It does not span an S3 call.
type PG struct {
	pool  *pgxpool.Pool
	claim Claim
}

// claimSQL takes the run for the current Shanghai date. There is no window:
// the boundary is the only gate. A `partial` row is retried at once; a
// `completed` row is not re-run. $3 is an explicit instant for tests; NULL
// uses the database clock so a skewed app clock cannot open the gate.
const claimSQL = `
WITH observed AS MATERIALIZED (SELECT COALESCE($3::timestamptz, clock_timestamp()) AS at),
day AS MATERIALIZED (
    SELECT at, (at AT TIME ZONE 'Asia/Shanghai')::date AS d FROM observed
), span AS MATERIALIZED (
    SELECT at, d, (d + time '04:00') AT TIME ZONE 'Asia/Shanghai' AS boundary FROM day
), claimed AS (
 INSERT INTO public.transit_clear_runs AS r
   (bucket_identity, run_day, status, lease_token, lease_epoch, lease_until,
    started_at, next_attempt_at, updated_at)
 SELECT $1, d, 'running', $2::uuid, 1, at + interval '90 seconds', at, at, at
   FROM span WHERE at >= boundary
 ON CONFLICT (bucket_identity, run_day) DO UPDATE SET
   status = 'running', lease_token = EXCLUDED.lease_token, lease_epoch = r.lease_epoch + 1,
   lease_until = EXCLUDED.lease_until, updated_at = clock_timestamp()
 WHERE r.status <> 'completed' AND r.api_calls < 1000000
   AND (r.lease_until IS NULL OR r.lease_until <= clock_timestamp())
   AND r.next_attempt_at <= clock_timestamp()
 RETURNING bucket_identity, run_day, lease_token::text, lease_epoch, lease_until
)
SELECT bucket_identity, run_day, lease_token, lease_epoch FROM claimed
WHERE lease_until > clock_timestamp()
`

const liveSQL = `bucket_identity = $1 AND run_day = $2 AND lease_token = $3::uuid
    AND lease_epoch = $4 AND status = 'running' AND lease_until > clock_timestamp()`

// TryClaim takes today's receipt once the 04:00 Shanghai boundary has passed.
// Before the boundary, or after a completed run, it returns nil.
func TryClaim(ctx context.Context, pool *pgxpool.Pool, fingerprint string) (*PG, error) {
	return claimAt(ctx, pool, fingerprint, nil)
}

// TryClaimAt is TryClaim at an explicit instant. Production uses TryClaim,
// which lets the database clock decide. The instant is what the claim SQL
// compares with that Shanghai date's 04:00; LastClearBoundary is the previous
// gate and is not this predicate.
func TryClaimAt(ctx context.Context, pool *pgxpool.Pool, fingerprint string, now time.Time) (*PG, error) {
	utc := now.UTC()
	return claimAt(ctx, pool, fingerprint, &utc)
}

func claimAt(ctx context.Context, pool *pgxpool.Pool, fingerprint string, now *time.Time) (*PG, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "SET LOCAL statement_timeout = '3s'"); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, "SET LOCAL lock_timeout = '500ms'"); err != nil {
		return nil, err
	}
	token := uuid.NewString()
	var claim Claim
	err = tx.QueryRow(ctx, claimSQL, fingerprint, token, now).Scan(&claim.Fingerprint, &claim.RunDay, &claim.Token, &claim.Epoch)
	if errors.Is(err, pgx.ErrNoRows) {
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &PG{pool: pool, claim: claim}, nil
}

// Reserve takes one prepaid API call and renews the lease.
func (p *PG) Reserve(ctx context.Context) (Reservation, bool, error) {
	tx, err := p.begin(ctx)
	if err != nil {
		return Reservation{}, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockReceipt(ctx, tx, p.claim); err != nil {
		return Reservation{}, false, err
	}
	var callNo int32
	var remaining int64
	err = tx.QueryRow(ctx, `
		UPDATE public.transit_clear_runs SET api_calls = api_calls + 1,
		last_api_at = clock_timestamp(), updated_at = clock_timestamp(),
		lease_until = clock_timestamp() + interval '90 seconds'
		WHERE `+liveSQL+` AND api_calls < 1000000
		RETURNING api_calls, greatest(0, floor(extract(epoch FROM (lease_until - clock_timestamp())) * 1000))::bigint`,
		p.claim.Fingerprint, p.claim.RunDay, p.claim.Token, p.claim.Epoch).Scan(&callNo, &remaining)
	if errors.Is(err, pgx.ErrNoRows) {
		return Reservation{}, false, tx.Commit(ctx)
	}
	if err != nil {
		return Reservation{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Reservation{}, false, err
	}
	return Reservation{CallNo: callNo, Remaining: time.Duration(remaining) * time.Millisecond}, true, nil
}

// Record acknowledges one call. A repeated acknowledgement cannot add twice.
func (p *PG) Record(ctx context.Context, reservation Reservation, deleted, failed uint32) (bool, error) {
	if uint64(deleted)+uint64(failed) > 1000 {
		return false, errCode("slice_delete_receipt_invalid")
	}
	return p.exec(ctx, `
		UPDATE public.transit_clear_runs SET
		last_result_call = $5, api_results = api_results + 1,
		deleted_acked = deleted_acked + $6, failed_objects = failed_objects + $7,
		updated_at = clock_timestamp()
		WHERE `+liveSQL+` AND $5 = api_calls AND $5 > last_result_call`,
		p.claim.Fingerprint, p.claim.RunDay, p.claim.Token, p.claim.Epoch,
		reservation.CallNo, int64(deleted), int64(failed))
}

// Finish marks the receipt completed after an empty list.
func (p *PG) Finish(ctx context.Context) (bool, error) {
	return p.exec(ctx, `
		UPDATE public.transit_clear_runs SET status = 'completed',
		completed_at = clock_timestamp(), updated_at = clock_timestamp(),
		lease_token = NULL, lease_until = NULL, error_code = NULL
		WHERE `+liveSQL+` AND api_calls > 0 AND last_result_call = api_calls`,
		p.claim.Fingerprint, p.claim.RunDay, p.claim.Token, p.claim.Epoch)
}

// RetryLater parks a partial receipt. The code must match the table's check.
func (p *PG) RetryLater(ctx context.Context, code string) (bool, error) {
	if !validCode(code) {
		return false, errCode("invalid_transit_clear_error_code")
	}
	return p.exec(ctx, `
		UPDATE public.transit_clear_runs SET status = 'partial',
		error_code = $5, lease_token = NULL, lease_until = NULL, updated_at = clock_timestamp(),
		next_attempt_at = clock_timestamp() + interval '30 seconds' WHERE `+liveSQL,
		p.claim.Fingerprint, p.claim.RunDay, p.claim.Token, p.claim.Epoch, code)
}

func (p *PG) exec(ctx context.Context, sql string, args ...any) (bool, error) {
	tx, err := p.begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockReceipt(ctx, tx, p.claim); err != nil {
		return false, err
	}
	tag, err := tx.Exec(ctx, sql, args...)
	if err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

func (p *PG) begin(ctx context.Context) (pgx.Tx, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, "SET LOCAL statement_timeout = '3s'"); err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	if _, err := tx.Exec(ctx, "SET LOCAL lock_timeout = '500ms'"); err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	return tx, nil
}

func lockReceipt(ctx context.Context, tx pgx.Tx, claim Claim) error {
	_, err := tx.Exec(ctx, `SELECT 1 FROM public.transit_clear_runs WHERE bucket_identity = $1 AND run_day = $2 FOR UPDATE`, claim.Fingerprint, claim.RunDay)
	return err
}

func validCode(code string) bool {
	if code == "" || len(code) > 64 {
		return false
	}
	if code[0] < 'a' || code[0] > 'z' {
		return false
	}
	for i := 0; i < len(code); i++ {
		c := code[i]
		if (c < 'a' || c > 'z') && (c < '0' || c > '9') && c != '_' {
			return false
		}
	}
	return true
}
