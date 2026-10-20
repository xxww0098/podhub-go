package submit

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	queue "github.com/xxww0098/podhub-go/internal/platform/jobsched"
)

// Attempt is one queued intent the worker or the HTTP handler is sending.
type Attempt struct {
	OrgID       int64
	IntentID    string
	RowID       string
	RowRevision int64
	StorePK     int64
	OfferID     string
	RequestHash string
	Body        []byte
	Lease       queue.Lease
	// CrashAfterSend leaves the intent submitting and the write dispatching.
	CrashAfterSend bool
}

// RunAttempt applies Classify and writes the rows. A kill switch or a
// connect refusal does not insert seller_upstream_writes. A crash returns
// after the request and before the settle transaction.
func RunAttempt(ctx context.Context, pool *pgxpool.Pool, tr Transport, in Attempt) (Outcome, error) {
	if tr == nil || tr.WritesDisabled() {
		out := Classify(Reply{WritesDisabled: true})
		return out, settleIntent(ctx, pool, in, out)
	}
	if err := tr.Ready(ctx); errors.Is(err, ErrNotSent) {
		out := Classify(Reply{Connect: true})
		return out, settleIntent(ctx, pool, in, out)
	} else if err != nil {
		return Outcome{}, err
	}
	if err := beginSending(ctx, pool, in); err != nil {
		return Outcome{}, err
	}
	status, resp, err := tr.Write(ctx, "/v3/product/import", in.Body)
	reply := Reply{
		Sent: true, Status: status, Body: resp,
		TaskID: taskID(resp), ProviderCode: providerCode(resp),
	}
	if err != nil && status == 0 {
		reply = Reply{Sent: true, Status: 0}
	}
	if in.CrashAfterSend {
		reply.CrashAfterSend = true
		reply.Sent = true
		return Classify(reply), errCrashed
	}
	if reply.TaskID > 0 {
		if err := commitTaskIDs(ctx, pool, in.OrgID, []string{in.IntentID}, reply.TaskID); err != nil {
			return Outcome{}, queue.ErrReceiptHeld
		}
		if err := touchLeases(ctx, pool, in.OrgID, in.Body); err != nil {
			return Outcome{}, err
		}
	}
	out := Classify(reply)
	if err := settleIntent(ctx, pool, in, out); err != nil {
		if reply.TaskID > 0 {
			return out, queue.ErrReceiptHeld
		}
		return out, err
	}
	return out, nil
}

// errCrashed tells the caller the settle transaction did not run. The
// request was already counted by the transport.
var errCrashed = errors.New("crashed after the seller request left the process")

// Crashed reports that error.
func Crashed(err error) bool { return errors.Is(err, errCrashed) }

// Recover parks a submitting intent that has no task id and moves a
// dispatching write to result_unknown. It does not send.
func Recover(ctx context.Context, pool *pgxpool.Pool, in Attempt) (Outcome, error) {
	out := RecoverSubmitting()
	return out, settleIntent(ctx, pool, in, out)
}

func providerCode(body string) int64 {
	var parsed struct {
		Code int64 `json:"code"`
	}
	if json.Unmarshal([]byte(body), &parsed) != nil {
		return 0
	}
	return parsed.Code
}

func taskID(body string) int64 {
	var parsed struct {
		Result struct {
			TaskID int64 `json:"task_id"`
		} `json:"result"`
		TaskID int64 `json:"task_id"`
	}
	if json.Unmarshal([]byte(body), &parsed) != nil {
		return 0
	}
	if parsed.Result.TaskID > 0 {
		return parsed.Result.TaskID
	}
	return parsed.TaskID
}

func beginSending(ctx context.Context, pool *pgxpool.Pool, in Attempt) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := tenant.EnterApp(ctx, tx, in.OrgID); err != nil {
		return err
	}
	if err := moveIntent(ctx, tx, in, Outcome{Edge: Begin, IntentState: Submitting}); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO public.seller_upstream_writes (
			org_id, store_id, idempotency_key, request_hash, state, kind
		) VALUES ($1, $2, $3, $4, 'dispatching', 'import')`,
		in.OrgID, in.StorePK, in.IntentID, in.RequestHash); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO public.seller_resource_occupancies (
			org_id, store_pk, physical_account_key, resource_kind, resource_key,
			owner_kind, owner_ref, spec_digest, state
		) VALUES ($1, $2, 'loopback', 'offer', $3, 'store_write', $4, $5, 'held')`,
		in.OrgID, in.StorePK, in.OfferID, in.IntentID, digest(in.RequestHash)); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE public.listing_rows
		   SET submission_state = 'submitting', updated_at = clock_timestamp()
		 WHERE org_id = $1 AND id = $2::uuid AND revision = $3`,
		in.OrgID, in.RowID, in.RowRevision); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func digest(hash string) string {
	if hash == "" {
		return "import"
	}
	if len(hash) > 128 {
		return hash[:128]
	}
	return hash
}

func settleIntent(ctx context.Context, pool *pgxpool.Pool, in Attempt, out Outcome) error {
	fn := func(ctx context.Context, tx pgx.Tx) error {
		if err := tenant.EnterApp(ctx, tx, in.OrgID); err != nil {
			return err
		}
		if err := moveIntent(ctx, tx, in, out); err != nil {
			return err
		}
		if err := moveWrite(ctx, tx, in, out); err != nil {
			return err
		}
		if err := moveOccupancy(ctx, tx, in, out); err != nil {
			return err
		}
		rowState := out.IntentState
		if rowState == Superseded {
			rowState = "none"
		}
		if rowState == Reconciled || rowState == Conflict || rowState == OperatorAttested {
			rowState = "none"
		}
		if _, err := tx.Exec(ctx, `
			UPDATE public.listing_rows
			   SET submission_state = $4, updated_at = clock_timestamp()
			 WHERE org_id = $1 AND id = $2::uuid AND revision = $3`,
			in.OrgID, in.RowID, in.RowRevision, rowState); err != nil {
			return err
		}
		if in.Lease.ID.String() == "00000000-0000-0000-0000-000000000000" || in.Lease.Owner == "" {
			return nil
		}
		tag, err := tx.Exec(ctx, `
			UPDATE public.jobs
			   SET state = $4,
			       last_error_code = NULLIF($5, ''),
			       result_ref = CASE WHEN $6 = '' THEN result_ref ELSE jsonb_build_object('outcome', $6::text) END,
			       lease_owner = NULL, lease_until = NULL, updated_at = clock_timestamp()
			 WHERE id = $1 AND lease_owner = $2 AND lease_epoch = $3 AND state = 'running'`,
			in.Lease.ID, in.Lease.Owner, in.Lease.Epoch, out.JobState, out.JobError, out.JobResult)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return errors.New("job lease was lost")
		}
		_, err = tx.Exec(ctx, `SELECT public.release_execution_permit('job', $1, $2)`, in.Lease.ID.String(), in.Lease.Epoch)
		return err
	}
	if in.Lease.Owner != "" {
		ok, err := queue.MutateRunning(ctx, pool, in.Lease, fn)
		if err != nil {
			return err
		}
		if !ok {
			return errors.New("job lease was lost")
		}
		return nil
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := tenant.EnterWorker(ctx, tx); err != nil {
		return err
	}
	if err := fn(ctx, tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func moveIntent(ctx context.Context, tx pgx.Tx, in Attempt, out Outcome) error {
	from := out.Edge.From()
	if len(from) == 0 {
		return ErrIllegalEdge
	}
	var task *string
	if out.IntentState == Accepted && out.JobResult == "accepted" {
		if id := taskID(out.WriteBody); id > 0 {
			text := strconv.FormatInt(id, 10)
			task = &text
		}
	}
	tag, err := tx.Exec(ctx, `
		UPDATE public.submission_intents
		   SET state = $4,
		       last_error_code = NULLIF($5, ''),
		       external_task_id = $6,
		       reconcile_after = CASE
		           WHEN $4 = 'unknown' THEN clock_timestamp() + interval '30 seconds'
		           ELSE NULL
		       END,
		       updated_at = clock_timestamp()
		 WHERE org_id = $1 AND id = $2::uuid AND state = ANY($3::text[])`,
		in.OrgID, in.IntentID, from, out.IntentState, out.IntentError, task)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrIllegalEdge
	}
	return nil
}

func moveWrite(ctx context.Context, tx pgx.Tx, in Attempt, out Outcome) error {
	if out.WriteState == "" {
		return nil
	}
	if out.WriteState == "settled" {
		tag, err := tx.Exec(ctx, `
			UPDATE public.seller_upstream_writes
			   SET state = 'settled',
			       response_status = $3,
			       response_body = $4,
			       updated_at = clock_timestamp()
			 WHERE org_id = $1 AND idempotency_key = $2 AND state = 'dispatching'`,
			in.OrgID, in.IntentID, out.WriteStatus, []byte(out.WriteBody))
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return ErrIllegalEdge
		}
		return nil
	}
	tag, err := tx.Exec(ctx, `
		UPDATE public.seller_upstream_writes
		   SET state = $3, response_status = NULL, response_body = NULL,
		       updated_at = clock_timestamp()
		 WHERE org_id = $1 AND idempotency_key = $2 AND state = 'dispatching'`,
		in.OrgID, in.IntentID, out.WriteState)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrIllegalEdge
	}
	return nil
}

func moveOccupancy(ctx context.Context, tx pgx.Tx, in Attempt, out Outcome) error {
	if out.Occupancy != "released" {
		return nil
	}
	tag, err := tx.Exec(ctx, `
		UPDATE public.seller_resource_occupancies
		   SET state = 'released',
		       released_at_ms = (extract(epoch FROM clock_timestamp()) * 1000)::bigint,
		       release_reason = $3
		 WHERE org_id = $1 AND owner_ref = $2 AND state = 'held'`,
		in.OrgID, in.IntentID, out.ReleaseReason)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrIllegalEdge
	}
	return nil
}

// ApplyStored writes one named edge. An illegal pair updates zero rows and
// returns ErrIllegalEdge. The transaction rolls back.
func ApplyStored(ctx context.Context, pool *pgxpool.Pool, orgID int64, intentID string, edge Edge) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := tenant.EnterApp(ctx, tx, orgID); err != nil {
		return err
	}
	out := Outcome{Edge: edge, IntentState: edge.To()}
	if err := moveIntent(ctx, tx, Attempt{OrgID: orgID, IntentID: intentID}, out); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
