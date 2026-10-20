package queuerepo

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

const (
	// State values are jobs.state. They are not river_job_state.
	// Succeeded, failed, and cancelled are declared in names.go as aliases
	// of platform/jobsched. Function bodies in this file still say those names.
	StateQueued    = "queued"
	StateRunning   = "running"
	StateRetryWait = "retry_wait"
	StateUncertain = "uncertain"
)

var (
	// ErrSubmitter rejects enqueue when submitter_user_id is not positive.
	ErrSubmitter = errors.New("submitter_user_id must be positive")
	// ErrLaneFull is the lane queued-cost cap. 249+8 is full; 248+8 is not.
	ErrLaneFull = errors.New("lane queued cost is full")
	// ErrTerminal is an unknown settle target.
	ErrTerminal = errors.New("terminal state is not succeeded, failed, or cancelled")
)

// Enqueue inserts a batch in one transaction. An empty batch sends no
// statement. Conflict on (org_id, kind, idempotency_key) keeps the first
// payload, state, and id. The head row is locked before execution_quota.
// A cost that does not fit rolls the whole batch back.
func Enqueue(ctx context.Context, pool *pgxpool.Pool, jobs []NewJob, laneLimit int64) ([]Queued, error) {
	if err := checkJobs(jobs); err != nil {
		return nil, err
	}
	if len(jobs) == 0 {
		return nil, nil
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if err := tenant.EnterWorker(ctx, tx); err != nil {
		return nil, err
	}
	out, err := EnqueueOn(ctx, tx, jobs, laneLimit)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// EnqueueOn inserts into a transaction that already has the worker role.
// The caller commits. Listing submit uses it so the intents and the jobs
// land in one transaction.
func EnqueueOn(ctx context.Context, tx pgx.Tx, jobs []NewJob, laneLimit int64) ([]Queued, error) {
	if err := checkJobs(jobs); err != nil {
		return nil, err
	}
	if len(jobs) == 0 {
		return nil, nil
	}
	if laneLimit <= 0 {
		laneLimit = AccountLaneQueuedCostLimit
	}
	keys := make([]headKey, 0, len(jobs))
	seen := map[headKey]struct{}{}
	for _, job := range jobs {
		key := headKey{User: job.SubmitterUserID, Lane: job.Kind}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		keys = append(keys, key)
	}
	if err := lockHeadsThenQuotas(ctx, tx, keys, permitClasses(jobs)); err != nil {
		return nil, err
	}
	return enqueueJobs(ctx, tx, jobs, laneLimit)
}

func checkJobs(jobs []NewJob) error {
	for _, job := range jobs {
		if job.SubmitterUserID <= 0 {
			return ErrSubmitter
		}
	}
	return nil
}

// Claim moves up to limit due rows of one kind from queued or retry_wait
// to running. One batch looks at ClaimHeadLimit heads and at most
// ClaimMaxPerUser rows of one user. Sort inside a head is priority,
// run_at, created_at, id. The head lock is taken before execution_quota.
// A refused permit leaves that row queued.
func Claim(ctx context.Context, pool *pgxpool.Pool, kind, owner string, limit int) ([]Claimed, error) {
	if limit <= 0 || owner == "" || kind == "" {
		return nil, nil
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if err := tenant.EnterWorker(ctx, tx); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO public.account_queue_cursor(lane) VALUES ($1) ON CONFLICT DO NOTHING`, kind); err != nil {
		return nil, err
	}
	var cursor int64
	if err := tx.QueryRow(ctx, `SELECT last_user_id FROM public.account_queue_cursor WHERE lane = $1 FOR UPDATE`, kind).Scan(&cursor); err != nil {
		return nil, err
	}
	users, err := headUsers(ctx, tx, kind, cursor)
	if err != nil {
		return nil, err
	}
	if len(users) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return nil, nil
	}
	keys := make([]headKey, len(users))
	for i, user := range users {
		keys[i] = headKey{User: user, Lane: kind}
	}
	if err := lockHeadsThenQuotas(ctx, tx, keys, []string{PermitClass(kind)}); err != nil {
		return nil, err
	}
	class := PermitClass(kind)
	var claimed []Claimed
	var lastUser int64
	remaining := limit
	for _, user := range users {
		if remaining <= 0 {
			break
		}
		n := int(ClaimMaxPerUser)
		if n > remaining {
			n = remaining
		}
		rows, err := lockDueJobs(ctx, tx, kind, user, n)
		if err != nil {
			return nil, err
		}
		took := 0
		for _, row := range rows {
			ok, err := grantPermit(ctx, tx, class, row)
			if err != nil {
				return nil, err
			}
			if !ok {
				continue
			}
			one, err := markRunning(ctx, tx, row.ID, owner)
			if err != nil {
				return nil, err
			}
			if one.ID == uuid.Nil {
				if _, err := tx.Exec(ctx, `SELECT public.release_execution_permit('job', $1, $2)`, row.ID.String(), row.Epoch+1); err != nil {
					return nil, err
				}
				continue
			}
			claimed = append(claimed, one)
			took++
			lastUser = user
		}
		remaining -= took
	}
	if lastUser > 0 {
		if _, err := tx.Exec(ctx, `UPDATE public.account_queue_cursor SET last_user_id = $2 WHERE lane = $1`, kind, lastUser); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return claimed, nil
}

// Renew pushes lease_until out by another default lease when the fence matches.
func Renew(ctx context.Context, pool *pgxpool.Pool, lease Lease) (bool, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	if err := tenant.EnterWorker(ctx, tx); err != nil {
		return false, err
	}
	tag, err := tx.Exec(ctx, `
		UPDATE public.jobs
		   SET lease_until = clock_timestamp() + ($4::bigint * interval '1 second'),
		       updated_at = clock_timestamp()
		 WHERE id = $1 AND lease_owner = $2 AND lease_epoch = $3 AND state = 'running'`,
		lease.ID, lease.Owner, lease.Epoch, DefaultLeaseSeconds)
	if err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// ReclaimExpiredRows applies ReclaimExpired to due running rows of one kind
// and then reap_stale_execution_permits. media.render and media.upload
// change no row. The batch size is LeaseSweepBatch.
func ReclaimExpiredRows(ctx context.Context, pool *pgxpool.Pool, kind string) (int, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	if err := tenant.EnterWorker(ctx, tx); err != nil {
		return 0, err
	}
	n := 0
	if kind != "media.render" && kind != "media.upload" {
		rows, err := lockExpired(ctx, tx, kind)
		if err != nil {
			return 0, err
		}
		for _, row := range rows {
			outcome := ReclaimExpired(row.input())
			if outcome.Untouched {
				continue
			}
			if err := applyLease(ctx, tx, row, outcome); err != nil {
				return 0, err
			}
			if outcome.State != StateUncertain && outcome.State != StateRunning {
				if _, err := tx.Exec(ctx, `SELECT public.release_execution_permit('job', $1, $2)`, row.ID.String(), row.Epoch); err != nil {
					return 0, err
				}
			}
			n++
		}
	}
	if _, err := tx.Exec(ctx, `SELECT public.reap_stale_execution_permits($1)`, LeaseSweepBatch); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return n, nil
}

// RequeueJob applies Requeue and RequeueDelay. A lost fence updates zero rows.
// Non-fault reasons withdraw the attempt the claim counted.
func RequeueJob(ctx context.Context, pool *pgxpool.Pool, lease Lease, reason RequeueReason, retryAfter time.Duration) (bool, error) {
	return withFence(ctx, pool, lease, func(ctx context.Context, tx pgx.Tx) error {
		result := Requeue(lease.Attempt, lease.MaxAttempts, reason)
		delay := RequeueDelay(lease.Kind, lease.Attempt, reason, retryAfter, JitterSeed(lease.ID.String(), lease.Epoch, lease.Attempt))
		tag, err := tx.Exec(ctx, `
			UPDATE public.jobs
			   SET state = $4,
			       attempt = $5,
			       last_error_code = $6,
			       lease_owner = NULL,
			       lease_until = NULL,
			       run_at = clock_timestamp() + ($7::bigint * interval '1 millisecond'),
			       updated_at = clock_timestamp()
			 WHERE id = $1 AND lease_owner = $2 AND lease_epoch = $3 AND state = 'running'`,
			lease.ID, lease.Owner, lease.Epoch, result.State, result.Attempt, result.ErrorCode, delay.Milliseconds())
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return errLostFence
		}
		if _, err := tx.Exec(ctx, `SELECT public.release_execution_permit('job', $1, $2)`, lease.ID.String(), lease.Epoch); err != nil {
			return err
		}
		return nil
	})
}

// Settle moves a running row to a terminal state when the fence matches.
// Deadlock and lock_not_available are retried SettleAttempts times. A lost
// fence returns false and a nil error.
func Settle(ctx context.Context, pool *pgxpool.Pool, lease Lease, terminal string, resultRef []byte) (bool, error) {
	return Finish(ctx, pool, lease, terminal, resultRef, "")
}

// Finish is Settle plus last_error_code. An empty code leaves the column
// untouched. The listing submit worker uses it for OZON_* codes. The lock
// order stays head then quota, inside the same retry loop as Settle.
func Finish(ctx context.Context, pool *pgxpool.Pool, lease Lease, terminal string, resultRef []byte, lastError string) (bool, error) {
	switch terminal {
	case StateSucceeded, StateFailed, StateCancelled:
	default:
		return false, ErrTerminal
	}
	var last error
	for try := 0; try < SettleAttempts; try++ {
		ok, err := withFence(ctx, pool, lease, func(ctx context.Context, tx pgx.Tx) error {
			tag, err := tx.Exec(ctx, `
				UPDATE public.jobs
				   SET state = $4,
				       result_ref = CASE WHEN $5::jsonb IS NULL THEN result_ref ELSE $5::jsonb END,
				       last_error_code = CASE WHEN $6 = '' THEN last_error_code ELSE $6 END,
				       lease_owner = NULL,
				       lease_until = NULL,
				       updated_at = clock_timestamp()
				 WHERE id = $1 AND lease_owner = $2 AND lease_epoch = $3 AND state = 'running'`,
				lease.ID, lease.Owner, lease.Epoch, terminal, resultRef, lastError)
			if err != nil {
				return err
			}
			if tag.RowsAffected() != 1 {
				return errLostFence
			}
			if _, err := tx.Exec(ctx, `SELECT public.release_execution_permit('job', $1, $2)`, lease.ID.String(), lease.Epoch); err != nil {
				return err
			}
			return nil
		})
		if err == nil {
			return ok, nil
		}
		if !isLockRetry(err) {
			return false, err
		}
		last = err
	}
	return false, last
}

// MutateRunning is the settle transaction: worker role, head lock, then
// quota lock, then fn. Listing submit writes the intent, the Seller ledger,
// and the job row in that one transaction. A lost lease returns false.
func MutateRunning(ctx context.Context, pool *pgxpool.Pool, lease Lease, fn func(context.Context, pgx.Tx) error) (bool, error) {
	var last error
	for try := 0; try < SettleAttempts; try++ {
		ok, err := withFence(ctx, pool, lease, fn)
		if err == nil {
			return ok, nil
		}
		if !isLockRetry(err) {
			return false, err
		}
		last = err
	}
	return false, last
}

// RunningOwned counts running rows this owner still holds for the kinds.
func RunningOwned(ctx context.Context, pool *pgxpool.Pool, owner string, kinds []string) (int, error) {
	if owner == "" || len(kinds) == 0 {
		return 0, nil
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	if err := tenant.EnterWorker(ctx, tx); err != nil {
		return 0, err
	}
	var n int
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM public.jobs
		 WHERE lease_owner = $1 AND state = 'running' AND kind = ANY($2)`,
		owner, kinds).Scan(&n); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return n, nil
}

var errLostFence = errors.New("lease fence missed")

func withFence(ctx context.Context, pool *pgxpool.Pool, lease Lease, fn func(context.Context, pgx.Tx) error) (bool, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	if err := tenant.EnterWorker(ctx, tx); err != nil {
		return false, err
	}
	if err := lockHeadsThenQuotas(ctx, tx, []headKey{{User: lease.UserID, Lane: lease.Lane}}, []string{PermitClass(lease.Kind)}); err != nil {
		return false, err
	}
	if err := fn(ctx, tx); err != nil {
		if errors.Is(err, errLostFence) {
			return false, nil
		}
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return true, nil
}

type headKey struct {
	User int64
	Lane string
}

func lockHeadsThenQuotas(ctx context.Context, tx pgx.Tx, keys []headKey, classes []string) error {
	if len(keys) == 0 {
		return nil
	}
	ordered := append([]headKey(nil), keys...)
	sort.Slice(ordered, func(i, j int) bool {
		if ordered[i].Lane != ordered[j].Lane {
			return ordered[i].Lane < ordered[j].Lane
		}
		return ordered[i].User < ordered[j].User
	})
	sort.Strings(classes)
	type quotaKey struct {
		class string
		user  int64
	}
	var quotas []quotaKey
	seen := map[quotaKey]struct{}{}
	for _, class := range classes {
		for _, key := range ordered {
			q := quotaKey{class: class, user: key.User}
			if _, ok := seen[q]; ok {
				continue
			}
			seen[q] = struct{}{}
			quotas = append(quotas, q)
		}
	}
	sort.Slice(quotas, func(i, j int) bool {
		if quotas[i].class != quotas[j].class {
			return quotas[i].class < quotas[j].class
		}
		return quotas[i].user < quotas[j].user
	})
	// One round trip. Head rows are one INSERT; VALUES order is the lane,
	// user sort above. Each advisory key stays its own statement.
	batch := &pgx.Batch{}
	queueHeadUpsert(batch, ordered)
	for _, q := range quotas {
		queueLockQuota(batch, q.class, q.user)
	}
	return execBatch(ctx, tx, batch)
}

func queueHeadUpsert(batch *pgx.Batch, ordered []headKey) {
	args := make([]any, 0, len(ordered)*2)
	var b strings.Builder
	b.WriteString(`INSERT INTO public.account_queue_head(user_id, lane) VALUES `)
	for i, key := range ordered {
		if i > 0 {
			b.WriteString(", ")
		}
		fmt.Fprintf(&b, "($%d, $%d)", len(args)+1, len(args)+2)
		args = append(args, key.User, key.Lane)
	}
	b.WriteString(` ON CONFLICT (user_id, lane) DO UPDATE SET lane = public.account_queue_head.lane`)
	batch.Queue(b.String(), args...)
}

func queueLockQuota(batch *pgx.Batch, class string, user int64) {
	batch.Queue(`
		SELECT pg_advisory_xact_lock(hashtextextended('eq-live:' || class, 0))
		  FROM public.execution_quota
		 WHERE class = $1 AND user_id = 0
		   AND NOT (class = 'ai_ocr' AND hard_limit = 0)`, class)
	batch.Queue(`
		SELECT pg_advisory_xact_lock(hashtextextended('eq-user:' || $1 || ':' || ($2::bigint)::text, 0))`,
		class, user)
	batch.Queue(`
		INSERT INTO public.execution_quota(class, user_id, hard_limit)
		VALUES ($1, $2, public.execution_quota_user_limit($1))
		ON CONFLICT (class, user_id) DO UPDATE SET class = public.execution_quota.class`,
		class, user)
}

func execBatch(ctx context.Context, tx pgx.Tx, batch *pgx.Batch) error {
	br := tx.SendBatch(ctx, batch)
	for range batch.Len() {
		if _, err := br.Exec(); err != nil {
			_ = br.Close()
			return err
		}
	}
	return br.Close()
}

// enqueueJobs pipelines each job's EXISTS, admit, insert, and empty-head
// delete in slice order. The replay flag is a transaction-local setting so
// the next statement in the batch can see it. Admit writes 'go' or 'full'
// the same way; the insert runs only for 'go', so a full lane does not
// write that row. A later job in the same batch may already have run; the
// caller rolls the transaction back, which is what Enqueue does.
func enqueueJobs(ctx context.Context, tx pgx.Tx, jobs []NewJob, laneLimit int64) ([]Queued, error) {
	batch := &pgx.Batch{}
	counts := make([]bool, len(jobs))
	for i, job := range jobs {
		counts[i] = CountsTowardHead(job.Kind, payloadExecutor(job.Payload))
		if counts[i] {
			batch.Queue(`
				SELECT set_config('podhub.enqueue_replay', EXISTS (
					SELECT 1 FROM public.jobs
					 WHERE org_id = $1 AND kind = $2 AND idempotency_key = $3
				)::text, true)`,
				job.OrgID, job.Kind, job.IdempotencyKey)
			batch.Queue(`
				SELECT set_config('podhub.enqueue_decision',
					CASE
						WHEN current_setting('podhub.enqueue_replay', true) = 'true' THEN 'go'
						WHEN COALESCE((
							SELECT queued_cost FROM public.account_queue_head
							 WHERE user_id = $1 AND lane = $2
						), 0) + $3::bigint <= $4::bigint THEN 'go'
						ELSE 'full'
					END, true)`,
				job.SubmitterUserID, job.Kind, int64(CostUnits(job.Kind)), laneLimit)
		} else {
			batch.Queue(`
				SELECT set_config('podhub.enqueue_replay', EXISTS (
					SELECT 1 FROM public.jobs
					 WHERE org_id = $1 AND kind = $2 AND idempotency_key = $3
				)::text, true),
				set_config('podhub.enqueue_decision', 'go', true)`,
				job.OrgID, job.Kind, job.IdempotencyKey)
		}
		queueInsert(batch, job)
		if !counts[i] {
			batch.Queue(`
				DELETE FROM public.account_queue_head
				 WHERE user_id = $1 AND lane = $2 AND queued_cost = 0 AND running_cost = 0
				   AND current_setting('podhub.enqueue_replay', true) = 'false'`,
				job.SubmitterUserID, job.Kind)
		}
	}
	batch.Queue(`SELECT set_config('podhub.enqueue_replay', '', true), set_config('podhub.enqueue_decision', '', true)`)
	br := tx.SendBatch(ctx, batch)
	out := make([]Queued, 0, len(jobs))
	for i := range jobs {
		var decision string
		if counts[i] {
			if _, err := br.Exec(); err != nil {
				_ = br.Close()
				return nil, err
			}
			if err := br.QueryRow().Scan(&decision); err != nil {
				_ = br.Close()
				return nil, err
			}
		} else if _, err := br.Exec(); err != nil {
			_ = br.Close()
			return nil, err
		} else {
			decision = "go"
		}
		row, err := scanQueued(br.QueryRow())
		if decision == "full" {
			_ = br.Close()
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return nil, err
			}
			return nil, ErrLaneFull
		}
		if err != nil {
			_ = br.Close()
			return nil, err
		}
		out = append(out, row)
		if !counts[i] {
			if _, err := br.Exec(); err != nil {
				_ = br.Close()
				return nil, err
			}
		}
	}
	if _, err := br.Exec(); err != nil {
		_ = br.Close()
		return nil, err
	}
	if err := br.Close(); err != nil {
		return nil, err
	}
	return out, nil
}

func lockQuota(ctx context.Context, tx pgx.Tx, class string, user int64) error {
	if _, err := tx.Exec(ctx, `
		SELECT pg_advisory_xact_lock(hashtextextended('eq-live:' || class, 0))
		  FROM public.execution_quota
		 WHERE class = $1 AND user_id = 0
		   AND NOT (class = 'ai_ocr' AND hard_limit = 0)`, class); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		SELECT pg_advisory_xact_lock(hashtextextended('eq-user:' || $1 || ':' || ($2::bigint)::text, 0))`,
		class, user); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO public.execution_quota(class, user_id, hard_limit)
		VALUES ($1, $2, public.execution_quota_user_limit($1))
		ON CONFLICT (class, user_id) DO UPDATE SET class = public.execution_quota.class`,
		class, user)
	return err
}

func permitClasses(jobs []NewJob) []string {
	seen := map[string]struct{}{}
	var out []string
	for _, job := range jobs {
		class := PermitClass(job.Kind)
		if _, ok := seen[class]; ok {
			continue
		}
		seen[class] = struct{}{}
		out = append(out, class)
	}
	return out
}

func admit(ctx context.Context, tx pgx.Tx, user int64, kind, executor string, limit int64) error {
	if !CountsTowardHead(kind, executor) {
		return nil
	}
	var queued int64
	err := tx.QueryRow(ctx, `
		SELECT queued_cost FROM public.account_queue_head
		 WHERE user_id = $1 AND lane = $2`, user, kind).Scan(&queued)
	if errors.Is(err, pgx.ErrNoRows) {
		queued = 0
	} else if err != nil {
		return err
	}
	if !LaneAdmitsLimit(queued, kind, limit) {
		return ErrLaneFull
	}
	return nil
}

const insertJobSQL = `
		INSERT INTO public.jobs (
			id, org_id, kind, aggregate_type, aggregate_id, input_revision,
			idempotency_key, state, payload, lane, submitter_user_id,
			cost_units, priority, max_attempts, run_at, created_at
		) VALUES (
			$1::uuid, $2, $3, $4, $5::uuid, $6,
			$7, 'queued', $8::jsonb, $3, $9,
			$10, $11, $12,
			COALESCE($13::timestamptz, clock_timestamp()),
			COALESCE($14::timestamptz, clock_timestamp())
		)
		ON CONFLICT (org_id, kind, idempotency_key) DO UPDATE
			SET updated_at = public.jobs.updated_at
		RETURNING id::text, payload, state, attempt, lease_epoch, (xmax = 0)`

// insertJobSelectSQL is insertJobSQL with the row taken from SELECT so a
// full lane can suppress the write. The conflict target and RETURNING match.
const insertJobSelectSQL = `
		INSERT INTO public.jobs (
			id, org_id, kind, aggregate_type, aggregate_id, input_revision,
			idempotency_key, state, payload, lane, submitter_user_id,
			cost_units, priority, max_attempts, run_at, created_at
		)
		SELECT
			$1::uuid, $2, $3, $4, $5::uuid, $6,
			$7, 'queued', $8::jsonb, $3, $9,
			$10, $11, $12,
			COALESCE($13::timestamptz, clock_timestamp()),
			COALESCE($14::timestamptz, clock_timestamp())
		WHERE current_setting('podhub.enqueue_decision', true) = 'go'
		ON CONFLICT (org_id, kind, idempotency_key) DO UPDATE
			SET updated_at = public.jobs.updated_at
		RETURNING id::text, payload, state, attempt, lease_epoch, (xmax = 0)`

func insertJob(ctx context.Context, tx pgx.Tx, job NewJob) (Queued, error) {
	job, args := insertArgs(job)
	return scanQueued(tx.QueryRow(ctx, insertJobSQL, args...))
}

func queueInsert(batch *pgx.Batch, job NewJob) {
	_, args := insertArgs(job)
	batch.Queue(insertJobSelectSQL, args...)
}

func insertArgs(job NewJob) (NewJob, []any) {
	if len(job.Payload) == 0 {
		job.Payload = []byte(`{}`)
	}
	maxAttempts := job.MaxAttempts
	if maxAttempts <= 0 {
		maxAttempts = DefaultMaxAttempts
	}
	priority := job.Priority
	if priority == 0 {
		priority = DefaultBusinessPriority
	}
	args := []any{
		job.ID, job.OrgID, job.Kind, job.AggregateType, job.AggregateID, job.InputRevision,
		job.IdempotencyKey, string(job.Payload), job.SubmitterUserID,
		CostUnits(job.Kind), priority, maxAttempts,
		nullTime(job.RunAt), nullTime(job.CreatedAt),
	}
	return job, args
}

func scanQueued(row pgx.Row) (Queued, error) {
	var out Queued
	var id string
	err := row.Scan(&id, &out.Payload, &out.State, &out.Attempt, &out.Epoch, &out.Inserted)
	if err != nil {
		return Queued{}, err
	}
	out.ID, err = uuid.Parse(id)
	return out, err
}

func nullTime(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t
}

func dropEmptyHead(ctx context.Context, tx pgx.Tx, user int64, lane string) error {
	_, err := tx.Exec(ctx, `
		DELETE FROM public.account_queue_head
		 WHERE user_id = $1 AND lane = $2 AND queued_cost = 0 AND running_cost = 0`,
		user, lane)
	return err
}

func headUsers(ctx context.Context, tx pgx.Tx, lane string, cursor int64) ([]int64, error) {
	rows, err := tx.Query(ctx, `
		SELECT user_id
		  FROM public.account_queue_head
		 WHERE lane = $1 AND queued_cost > 0
		 ORDER BY (user_id > $2) DESC, user_id
		 LIMIT $3`, lane, cursor, ClaimHeadLimit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var users []int64
	for rows.Next() {
		var user int64
		if err := rows.Scan(&user); err != nil {
			return nil, err
		}
		users = append(users, user)
	}
	return users, rows.Err()
}

type dueJob struct {
	ID          uuid.UUID
	OrgID       int64
	Epoch       int64
	Attempt     int32
	MaxAttempts int32
	UserID      int64
	Kind        string
	Payload     []byte
}

func lockDueJobs(ctx context.Context, tx pgx.Tx, kind string, user int64, limit int) ([]dueJob, error) {
	rows, err := tx.Query(ctx, `
		SELECT id::text, org_id, lease_epoch, attempt, max_attempts, payload
		  FROM public.jobs
		 WHERE submitter_user_id = $1
		   AND lane = $2
		   AND state IN ('queued', 'retry_wait')
		   AND run_at <= clock_timestamp()
		   AND cancel_requested_at IS NULL
		   AND executor NOT IN ('browser', 'http')
		   AND attempt < max_attempts
		 ORDER BY priority, run_at, created_at, id
		 LIMIT $3
		 FOR UPDATE SKIP LOCKED`, user, kind, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []dueJob
	for rows.Next() {
		var row dueJob
		var id string
		if err := rows.Scan(&id, &row.OrgID, &row.Epoch, &row.Attempt, &row.MaxAttempts, &row.Payload); err != nil {
			return nil, err
		}
		parsed, err := uuid.Parse(id)
		if err != nil {
			return nil, err
		}
		row.ID = parsed
		row.UserID = user
		row.Kind = kind
		out = append(out, row)
	}
	return out, rows.Err()
}

func grantPermit(ctx context.Context, tx pgx.Tx, class string, row dueJob) (bool, error) {
	var ok bool
	err := tx.QueryRow(ctx, `
		SELECT public.try_grant_execution_permit(
			ARRAY[$1]::text[], $2, $3, 'job', $4, $5,
			clock_timestamp() + ($6::bigint * interval '1 second'))`,
		class, row.OrgID, row.UserID, row.ID.String(), row.Epoch+1, DefaultLeaseSeconds).Scan(&ok)
	if err != nil {
		return false, err
	}
	return ok, nil
}

func markRunning(ctx context.Context, tx pgx.Tx, id uuid.UUID, owner string) (Claimed, error) {
	var row Claimed
	var idText string
	err := tx.QueryRow(ctx, `
		UPDATE public.jobs
		   SET state = 'running',
		       attempt = attempt + 1,
		       lease_owner = $2,
		       lease_until = clock_timestamp() + ($3::bigint * interval '1 second'),
		       lease_epoch = lease_epoch + 1,
		       updated_at = clock_timestamp()
		 WHERE id = $1 AND state IN ('queued', 'retry_wait')
		 RETURNING id::text, org_id, kind, submitter_user_id, attempt, max_attempts,
		           lease_epoch, lease_owner, lease_until, payload`,
		id, owner, DefaultLeaseSeconds).Scan(
		&idText, &row.OrgID, &row.Kind, &row.SubmitterUserID, &row.Attempt, &row.MaxAttempts,
		&row.Epoch, &row.Owner, &row.Until, &row.Payload)
	if errors.Is(err, pgx.ErrNoRows) {
		return Claimed{}, nil
	}
	if err != nil {
		return Claimed{}, err
	}
	row.ID, err = uuid.Parse(idText)
	return row, err
}

type expiredRow struct {
	ID        uuid.UUID
	Kind      string
	Executor  string
	Attempt   int32
	Max       int32
	LastError string
	Payload   []byte
	Epoch     int64
}

func (r expiredRow) input() LeaseInput {
	return LeaseInput{
		Kind: r.Kind, Executor: r.Executor, Attempt: r.Attempt, MaxAttempts: r.Max,
		Intents: intentCount(r.Payload), LastError: r.LastError,
	}
}

func lockExpired(ctx context.Context, tx pgx.Tx, kind string) ([]expiredRow, error) {
	rows, err := tx.Query(ctx, `
		SELECT id::text, kind, executor, attempt, max_attempts,
		       COALESCE(last_error_code, ''), payload, lease_epoch
		  FROM public.jobs
		 WHERE kind = $1 AND state = 'running'
		   AND lease_until IS NOT NULL AND lease_until <= clock_timestamp()
		 ORDER BY lease_until, id
		 LIMIT $2
		 FOR UPDATE SKIP LOCKED`, kind, LeaseSweepBatch)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []expiredRow
	for rows.Next() {
		var row expiredRow
		var id string
		if err := rows.Scan(&id, &row.Kind, &row.Executor, &row.Attempt, &row.Max, &row.LastError, &row.Payload, &row.Epoch); err != nil {
			return nil, err
		}
		parsed, err := uuid.Parse(id)
		if err != nil {
			return nil, err
		}
		row.ID = parsed
		out = append(out, row)
	}
	return out, rows.Err()
}

func applyLease(ctx context.Context, tx pgx.Tx, row expiredRow, outcome LeaseResult) error {
	// ClearLease writes NULL. Keeping the columns is the uncertain branch:
	// lease_owner and lease_until stay on the row.
	if outcome.ClearLease {
		_, err := tx.Exec(ctx, `
			UPDATE public.jobs
			   SET state = $2,
			       last_error_code = NULLIF($3, ''),
			       lease_owner = NULL,
			       lease_until = NULL,
			       updated_at = clock_timestamp()
			 WHERE id = $1 AND state = 'running'`,
			row.ID, outcome.State, outcome.LastError)
		return err
	}
	_, err := tx.Exec(ctx, `
		UPDATE public.jobs
		   SET state = $2,
		       last_error_code = NULLIF($3, ''),
		       updated_at = clock_timestamp()
		 WHERE id = $1 AND state = 'running'`,
		row.ID, outcome.State, outcome.LastError)
	return err
}

func intentCount(payload []byte) int {
	if len(payload) == 0 {
		return 0
	}
	var body struct {
		Intents []json.RawMessage `json:"intents"`
	}
	if err := json.Unmarshal(payload, &body); err != nil {
		return 0
	}
	return len(body.Intents)
}

func payloadExecutor(payload []byte) string {
	if len(payload) == 0 {
		return ""
	}
	var body struct {
		Executor string `json:"executor"`
	}
	if err := json.Unmarshal(payload, &body); err != nil {
		return ""
	}
	return body.Executor
}

func isLockRetry(err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code == "40P01" || pgErr.Code == "55P03"
	}
	return false
}

// FormatOwner is the lease_owner this process writes. It is not a Rust
// hostname; tests pass their own owner. Two processes must not share one.
func FormatOwner(role, id string) string {
	if id == "" {
		id = uuid.NewString()
	}
	return fmt.Sprintf("%s:%s", role, id)
}
