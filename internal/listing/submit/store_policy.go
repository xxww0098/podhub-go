package submit

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	queue "github.com/xxww0098/podhub-go/internal/queue/contract"
)

const (
	CodeStoreDailyCap = "STORE_DAILY_CAP_REACHED"
	CodeStoreSendGap  = "STORE_MIN_SEND_GAP"
)

type policyWait struct {
	code string
	at   time.Time
}

func (w *policyWait) Error() string { return w.code }

type policyWindow struct {
	now     time.Time
	cap     *int
	gap     int
	today   int
	last    *time.Time
	allowed int
	wait    *policyWait
}

// The store lock serializes policy changes and every real dispatch admission.
func loadPolicyWindow(ctx context.Context, tx pgx.Tx, orgID, storePK int64, wanted int) (policyWindow, error) {
	var window policyWindow
	var store int64
	if err := tx.QueryRow(ctx, `SELECT id FROM public.organization_stores WHERE org_id=$1 AND id=$2 AND deleted_at_ms IS NULL FOR NO KEY UPDATE`, orgID, storePK).Scan(&store); err != nil {
		return window, err
	}
	err := tx.QueryRow(ctx, `SELECT daily_cap,min_gap_seconds FROM public.store_listing_policies WHERE org_id=$1 AND store_id=$2`, orgID, storePK).Scan(&window.cap, &window.gap)
	if errors.Is(err, pgx.ErrNoRows) {
		window.allowed = wanted
		return window, nil
	}
	if err != nil {
		return window, err
	}
	if err := tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&window.now); err != nil {
		return window, err
	}
	start := policyDayStart(window.now)
	if err := tx.QueryRow(ctx, `SELECT count(*) FILTER (WHERE created_at >= $3), max(created_at)
		FROM public.seller_upstream_writes WHERE org_id=$1 AND store_id=$2 AND kind='import' AND error_code IS DISTINCT FROM 'not_dispatched'`, orgID, storePK, start).Scan(&window.today, &window.last); err != nil {
		return window, err
	}
	window.allowed, window.wait = policyAllowance(window.now, window.cap, window.gap, window.today, window.last, wanted)
	return window, nil
}

func policyDayStart(now time.Time) time.Time {
	local := now.In(time.FixedZone("Asia/Shanghai", 8*60*60))
	return time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, local.Location())
}

func policyAllowance(now time.Time, cap *int, gap, today int, last *time.Time, wanted int) (int, *policyWait) {
	n := wanted
	if cap != nil && *cap-today < n {
		n = max(0, *cap-today)
	}
	var wait *policyWait
	if n == 0 && wanted > 0 {
		wait = &policyWait{CodeStoreDailyCap, policyDayStart(now).Add(24 * time.Hour)}
	}
	if gap > 0 && last != nil {
		next := last.Add(time.Duration(gap) * time.Second)
		if next.After(now) {
			if wait == nil || next.After(wait.at) {
				wait = &policyWait{CodeStoreSendGap, next}
			}
			n = 0
		}
	}
	return n, wait
}

func requireDispatchPolicy(ctx context.Context, tx pgx.Tx, orgID, storePK int64, count int) error {
	window, err := loadPolicyWindow(ctx, tx, orgID, storePK, count)
	if err != nil {
		return err
	}
	if window.wait != nil {
		return window.wait
	}
	if window.allowed < count {
		return &policyWait{CodeStoreDailyCap, policyDayStart(window.now).Add(24 * time.Hour)}
	}
	return nil
}

// Splitting before binding keeps the credential scope and crash recovery payload exact.
func (svc Service) splitPolicyBatch(ctx context.Context, pool *pgxpool.Pool, job queue.Claimed, storePK int64, attempts []Attempt) (int, error) {
	n := len(attempts)
	err := svc.mutateSettlement(ctx, pool, job.Lease(), func(ctx context.Context, tx pgx.Tx) error {
		if err := tenant.EnterApp(ctx, tx, job.OrgID); err != nil {
			return err
		}
		window, err := loadPolicyWindow(ctx, tx, job.OrgID, storePK, len(attempts))
		if err != nil {
			return err
		}
		if window.wait != nil {
			return window.wait
		}
		n = window.allowed
		if n == len(attempts) {
			return nil
		}
		var original batchJob
		if err := json.Unmarshal(job.Payload, &original); err != nil {
			return err
		}
		active := make(map[string]bool, len(attempts))
		for _, in := range attempts {
			active[in.IntentID] = true
		}
		var pending []batchIntent
		for _, in := range original.Intents {
			if active[in.IntentID] {
				pending = append(pending, in)
			}
		}
		if len(pending) != len(attempts) || svc.Queue.EnqueueOn == nil {
			return errors.New("listing policy split is unavailable")
		}
		current, remainder := original, original
		current.Intents, remainder.Intents = pending[:n], pending[n:]
		body, err := json.Marshal(current)
		if err != nil {
			return err
		}
		var createdAt time.Time
		err = tx.QueryRow(ctx, `UPDATE public.jobs SET payload=$4::jsonb,updated_at=clock_timestamp() WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3 AND state='running' RETURNING created_at`, job.ID, job.Owner, job.Epoch, body).Scan(&createdAt)
		if errors.Is(err, pgx.ErrNoRows) {
			return errors.New("job lease was lost")
		}
		if err != nil {
			return err
		}
		body, err = json.Marshal(remainder)
		if err != nil {
			return err
		}
		aggregate, err := uuid.Parse(original.BatchID)
		if err != nil {
			return err
		}
		_, err = svc.Queue.EnqueueOn(ctx, tx, []queue.NewJob{{
			ID: uuid.New(), OrgID: job.OrgID, Kind: job.Kind,
			AggregateType: "submission_batch", AggregateID: aggregate,
			IdempotencyKey: "policy:" + job.ID.String() + ":" + remainder.Intents[0].IntentID,
			Payload:        body, SubmitterUserID: job.SubmitterUserID, MaxAttempts: job.MaxAttempts, Priority: 50,
			CreatedAt: createdAt,
		}}, 0)
		return err
	})
	return n, err
}

func (svc Service) deferPolicy(ctx context.Context, pool *pgxpool.Pool, job queue.Claimed, wait *policyWait) error {
	return svc.mutateSettlement(ctx, pool, job.Lease(), func(ctx context.Context, tx pgx.Tx) error {
		if err := tenant.EnterApp(ctx, tx, job.OrgID); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `UPDATE public.jobs SET state='retry_wait',attempt=GREATEST(attempt-1,0),run_at=$4,last_error_code=$5,
			result_ref=jsonb_build_object('outcome','waiting','reason',$5::text,'next_allowed_at',$4::timestamptz),
			lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp()
			WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3 AND state='running'`, job.ID, job.Owner, job.Epoch, wait.at, wait.code)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return errors.New("job lease was lost")
		}
		if _, err := tx.Exec(ctx, `UPDATE public.submission_intents SET last_error_code=$3,updated_at=clock_timestamp()
			WHERE org_id=$1 AND state='queued' AND id::text IN (
			SELECT payload->>'intentId' FROM public.jobs WHERE id=$2
			UNION ALL SELECT item->>'intentId' FROM public.jobs j CROSS JOIN LATERAL jsonb_array_elements(COALESCE(j.payload->'intents','[]'::jsonb)) item WHERE j.id=$2)`, job.OrgID, job.ID, wait.code); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `SELECT public.release_execution_permit('job',$1,$2)`, job.ID.String(), job.Epoch)
		return err
	})
}
