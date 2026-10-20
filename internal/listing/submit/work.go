package submit

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5/pgxpool"

	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	queue "github.com/xxww0098/podhub-go/internal/platform/jobsched"
)

// JobBody is the listing.submit payload after freeze. requestHash is the
// frozen digest. This worker does not compute it.
type JobBody struct {
	IntentID       string          `json:"intentId"`
	RowID          string          `json:"rowId"`
	RowRevision    int64           `json:"rowRevision"`
	StorePK        int64           `json:"storePk"`
	OfferID        string          `json:"offerId"`
	RequestHash    string          `json:"requestHash"`
	Import         json.RawMessage `json:"import"`
	CrashAfterSend bool            `json:"crashAfterSend"`
}

// Work runs one claimed listing.submit job. It settles the jobs row itself.
// A crash after the request leaves the lease running so the next claim parks
// the intent instead of sending again. A nil return means the loop must not
// settle or requeue.
func Work(ctx context.Context, pool *pgxpool.Pool, job queue.Claimed, tr Transport) error {
	var batch struct {
		StoreID string        `json:"storeId"`
		Intents []batchIntent `json:"intents"`
	}
	if err := json.Unmarshal(job.Payload, &batch); err != nil {
		return err
	}
	if len(batch.Intents) > 0 {
		return workBatch(ctx, pool, job, tr, batch.StoreID, batch.Intents)
	}
	var body JobBody
	if err := json.Unmarshal(job.Payload, &body); err != nil {
		return err
	}
	in := Attempt{
		OrgID: job.OrgID, IntentID: body.IntentID, RowID: body.RowID,
		RowRevision: body.RowRevision, StorePK: body.StorePK, OfferID: body.OfferID,
		RequestHash: body.RequestHash, Body: body.Import, Lease: job.Lease(),
		CrashAfterSend: body.CrashAfterSend,
	}
	state, err := intentState(ctx, pool, job.OrgID, body.IntentID)
	if err != nil {
		return err
	}
	switch state {
	case "", Queued:
		_, err = RunAttempt(ctx, pool, tr, in)
		if Crashed(err) {
			return nil
		}
		return err
	case Submitting:
		task, err := intentTask(ctx, pool, job.OrgID, body.IntentID)
		if err != nil {
			return err
		}
		if task != "" {
			return resumeSingle(ctx, pool, in, task)
		}
		_, err = Recover(ctx, pool, in)
		return err
	default:
		return nil
	}
}

func intentState(ctx context.Context, pool *pgxpool.Pool, orgID int64, intentID string) (string, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	if err := tenant.EnterWorker(ctx, tx); err != nil {
		return "", err
	}
	var state string
	err = tx.QueryRow(ctx, `
		SELECT state FROM public.submission_intents
		 WHERE org_id = $1 AND id = $2::uuid`, orgID, intentID).Scan(&state)
	if err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return state, nil
}

func intentTask(ctx context.Context, pool *pgxpool.Pool, orgID int64, intentID string) (string, error) {
	facts, err := intentFacts(ctx, pool, orgID, []string{intentID})
	if err != nil {
		return "", err
	}
	return facts[intentID].task, nil
}

func resumeSingle(ctx context.Context, pool *pgxpool.Pool, in Attempt, task string) error {
	if err := touchLeases(ctx, pool, in.OrgID, in.Body); err != nil {
		return err
	}
	body := receiptBody(task)
	reply := Reply{Sent: true, Status: 200, Body: body, TaskID: taskID(body)}
	if err := settleIntent(ctx, pool, in, Classify(reply)); err != nil {
		return queue.ErrReceiptHeld
	}
	return nil
}
