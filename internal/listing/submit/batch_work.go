package submit

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	queue "github.com/xxww0098/podhub-go/internal/queue/contract"
	sellercontract "github.com/xxww0098/podhub-go/internal/seller/contract"
)

func (svc Service) workBatch(ctx context.Context, pool *pgxpool.Pool, job queue.Claimed, tr Transport, storeID string, intents []batchIntent) error {
	storePK, err := storePK(ctx, pool, job.OrgID, storeID)
	if err != nil {
		return err
	}
	attempts := make([]Attempt, 0, len(intents))
	items := make([]json.RawMessage, 0, len(intents))
	originals := make([][]byte, 0, len(intents))
	ids := make([]string, 0, len(intents))
	for _, item := range intents {
		offer, one, err := importItem(item.Import)
		if err != nil {
			return err
		}
		attempts = append(attempts, Attempt{
			OrgID: job.OrgID, IntentID: item.IntentID, RowID: item.RowID,
			RowRevision: item.RowRevision, StorePK: storePK, OfferID: offer,
			RequestHash: item.RequestHash, Body: item.Import, Lease: job.Lease(),
		})
		items = append(items, one)
		originals = append(originals, item.Import)
		ids = append(ids, item.IntentID)
	}
	facts, err := intentFacts(ctx, pool, job.OrgID, ids)
	if err != nil {
		return err
	}
	task, anyQueued, bare := "", false, false
	for _, id := range ids {
		fact := facts[id]
		if fact.task != "" {
			task = fact.task
		}
		if fact.state == "" || fact.state == Queued {
			anyQueued = true
		}
		if fact.state == Submitting && fact.task == "" {
			bare = true
		}
	}
	if task != "" {
		return svc.finishReceipt(ctx, pool, attempts, originals, task)
	}
	if bare {
		if anyQueued {
			return svc.settleInterruptedBatch(ctx, pool, attempts)
		}
		return svc.settleBatch(ctx, pool, attempts, RecoverSubmitting())
	}
	retain := func(facts map[string]intentFact) bool {
		allCancelled, n := true, 0
		for i, in := range attempts {
			state := facts[in.IntentID].state
			if state != Cancelled {
				allCancelled = false
			}
			switch state {
			case Cancelled, Rejected, Superseded, Reconciled, Conflict, OperatorAttested:
				continue
			}
			attempts[n], items[n], originals[n], ids[n] = in, items[i], originals[i], in.IntentID
			n++
		}
		attempts, items, originals, ids = attempts[:n], items[:n], originals[:n], ids[:n]
		return allCancelled
	}
	allCancelled := retain(facts)
	if len(attempts) > 0 {
		busy, err := orgBatchBusy(ctx, pool, job.OrgID, job.ID.String())
		if err != nil {
			return err
		}
		if busy {
			return queue.ErrOrgCap
		}
		if tr != nil && !tr.WritesDisabled() {
			n, err := svc.splitPolicyBatch(ctx, pool, job, storePK, attempts)
			if err != nil {
				return err
			}
			attempts, items, originals, ids = attempts[:n], items[:n], originals[:n], ids[:n]
		}
	}
	baseTransport := tr
	for {
		var refusal *Outcome
		for len(attempts) > 0 {
			if baseTransport == nil || baseTransport.WritesDisabled() {
				out := Classify(Reply{WritesDisabled: true})
				refusal = &out
				break
			}
			bound, err := bindStoreTransport(ctx, baseTransport, sellercontract.StoreBinding{
				OrgID: job.OrgID, UserID: job.SubmitterUserID, StorePK: storePK, StoreUUID: storeID, IntentIDs: ids,
			})
			if errors.Is(err, ErrNotSent) {
				current, readErr := intentFacts(ctx, pool, job.OrgID, ids)
				if readErr != nil {
					return readErr
				}
				previous := len(attempts)
				allCancelled = retain(current)
				if len(attempts) < previous {
					continue
				}
				out := Classify(Reply{Connect: true})
				refusal = &out
				break
			}
			if err != nil {
				return err
			}
			if bound == nil || bound.WritesDisabled() {
				out := Classify(Reply{WritesDisabled: true})
				refusal = &out
				break
			}
			if err := bound.Ready(ctx); err != nil {
				if !errors.Is(err, ErrNotSent) {
					return err
				}
				out := Classify(Reply{Connect: true})
				refusal = &out
				break
			}
			tr = bound
			break
		}

		prepared := false
		err = svc.mutateSettlement(ctx, pool, job.Lease(), func(ctx context.Context, tx pgx.Tx) error {
			if err := tenant.EnterApp(ctx, tx, job.OrgID); err != nil {
				return err
			}
			// Cancellation takes the organization lock before changing an intent.
			var org int64
			if err := tx.QueryRow(ctx, `SELECT id FROM public.organizations WHERE id=$1 AND dissolved_at IS NULL FOR NO KEY UPDATE`, job.OrgID).Scan(&org); err != nil {
				return err
			}
			currentFacts := make(map[string]intentFact, len(attempts))
			for _, in := range attempts {
				var state string
				if err := tx.QueryRow(ctx, `SELECT state FROM public.submission_intents WHERE org_id=$1 AND id=$2::uuid FOR UPDATE`, job.OrgID, in.IntentID).Scan(&state); err != nil {
					return err
				}
				currentFacts[in.IntentID] = intentFact{state: state}
			}
			previous := len(attempts)
			if previous > 0 {
				allCancelled = retain(currentFacts)
			}
			if len(attempts) == 0 {
				state := queue.StateSucceeded
				if allCancelled {
					state = queue.StateCancelled
				}
				return finishSubmitJob(ctx, tx, job.Lease(), state, "", nil)
			}
			if len(attempts) != previous && refusal == nil {
				return errBatchChanged
			}
			if refusal != nil {
				return settleBatchTx(ctx, tx, attempts, *refusal)
			}
			current, err := sliceImportsCurrentTx(ctx, tx, job.OrgID, originals...)
			if err != nil {
				return err
			}
			if !current {
				return settleBatchTx(ctx, tx, attempts, sliceExpiredOutcome())
			}

			if err := requireDispatchPolicy(ctx, tx, job.OrgID, storePK, len(attempts)); err != nil {
				return err
			}
			for i := range attempts {
				if account, ok := tr.(sellercontract.PhysicalAccountTransport); ok {
					attempts[i].PhysicalAccountKey = account.PhysicalAccountKey()
				}
				if err := beginSendingTx(ctx, tx, attempts[i]); err != nil {
					return err
				}
			}
			prepared = true
			return nil
		})
		if errors.Is(err, errBatchChanged) {
			continue
		}
		if err != nil || !prepared {
			return err
		}
		break
	}

	body, err := mergeImport(originals, items)
	if err != nil {
		return err
	}
	status, resp, err := tr.Write(ctx, "/v3/product/import", body)
	if errors.Is(err, ErrNotSent) && status == 0 {
		return svc.settleBatch(ctx, pool, attempts, WriteNotSent())
	}
	reply := Reply{
		Sent: true, Status: status, Body: resp,
		TaskID: taskID(resp), ProviderCode: providerCode(resp),
	}
	if err != nil && status == 0 {
		reply = Reply{Sent: true, Status: 0}
	}
	if reply.TaskID > 0 {
		if err := commitTaskIDs(ctx, pool, job.OrgID, ids, reply.TaskID); err != nil {
			return queue.ErrReceiptHeld
		}
		if err := touchLeases(ctx, pool, job.OrgID, originals...); err != nil {
			return err
		}
		if err := svc.settleBatch(ctx, pool, attempts, Classify(reply)); err != nil {
			return queue.ErrReceiptHeld
		}
		return nil
	}
	return svc.settleBatch(ctx, pool, attempts, Classify(reply))
}

// A partially begun batch cannot be sent again. Settle each existing edge in
// one fenced transaction: dispatched rows stay unknown, unsent rows are rejected.
func (svc Service) settleInterruptedBatch(ctx context.Context, pool *pgxpool.Pool, attempts []Attempt) error {
	lease := attempts[0].Lease
	return svc.mutateSettlement(ctx, pool, lease, func(ctx context.Context, tx pgx.Tx) error {
		for _, in := range attempts {
			var state string
			if err := tx.QueryRow(ctx, `SELECT state FROM public.submission_intents WHERE org_id=$1 AND id=$2::uuid FOR UPDATE`, in.OrgID, in.IntentID).Scan(&state); err != nil {
				return err
			}
			out := Classify(Reply{Connect: true})
			if state == Submitting {
				out = RecoverSubmitting()
			}
			if edgeAllows(out.Edge, state) {
				if err := settleIntentRows(ctx, tx, in, out); err != nil {
					return err
				}
			}
		}
		reason := CodeDispatchInterrupted
		return finishSubmitJob(ctx, tx, lease, queue.StateSucceeded, "unknown", &reason)
	})
}

// finishReceipt runs after external_task_id is already stored. It does not
// call the seller. A lock sends the job back; the receipt stays.
func (svc Service) finishReceipt(ctx context.Context, pool *pgxpool.Pool, attempts []Attempt, bodies [][]byte, task string) error {
	if err := touchLeases(ctx, pool, attempts[0].OrgID, bodies...); err != nil {
		return err
	}
	reply := Reply{Sent: true, Status: 200, Body: receiptBody(task), TaskID: taskID(receiptBody(task))}
	if err := svc.settleBatch(ctx, pool, attempts, Classify(reply)); err != nil {
		return queue.ErrReceiptHeld
	}
	return nil
}

// settleBatch commits the intents and job under one lease fence. A lost
// lease or later item failure rolls back the whole settlement. Positive
// receipts commit separately; intents past the edge stay unchanged.
func (svc Service) settleBatch(ctx context.Context, pool *pgxpool.Pool, attempts []Attempt, out Outcome) error {
	if len(attempts) == 0 {
		return nil
	}
	return svc.mutateSettlement(ctx, pool, attempts[0].Lease, func(ctx context.Context, tx pgx.Tx) error {
		return settleBatchTx(ctx, tx, attempts, out)
	})
}

func settleBatchTx(ctx context.Context, tx pgx.Tx, attempts []Attempt, out Outcome) error {
	for _, in := range attempts {
		var state string
		if err := tx.QueryRow(ctx, `SELECT state FROM public.submission_intents WHERE org_id=$1 AND id=$2::uuid FOR UPDATE`, in.OrgID, in.IntentID).Scan(&state); err != nil {
			return err
		}
		if !edgeAllows(out.Edge, state) {
			continue
		}
		if err := settleIntentRows(ctx, tx, in, out); err != nil {
			return err
		}
	}
	switch out.JobState {
	case queue.StateSucceeded, queue.StateFailed, queue.StateCancelled:
	default:
		return nil
	}
	var lastError *string
	if out.JobError != "" {
		lastError = &out.JobError
	}
	return finishSubmitJob(ctx, tx, attempts[0].Lease, out.JobState, out.JobResult, lastError)
}

func edgeAllows(edge Edge, state string) bool {
	for _, from := range edge.From() {
		if from == state {
			return true
		}
	}
	return false
}

func storePK(ctx context.Context, pool *pgxpool.Pool, orgID int64, storeID string) (int64, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	if err := tenant.EnterWorker(ctx, tx); err != nil {
		return 0, err
	}
	var id int64
	err = tx.QueryRow(ctx, `
		SELECT id FROM public.organization_stores
		 WHERE org_id = $1 AND uuid = $2::uuid`, orgID, storeID).Scan(&id)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return id, nil
}

func importItem(raw []byte) (string, json.RawMessage, error) {
	var body struct {
		Items []json.RawMessage `json:"items"`
	}
	if err := json.Unmarshal(raw, &body); err != nil || len(body.Items) != 1 {
		return "", nil, errBadImport
	}
	var item struct {
		OfferID string `json:"offer_id"`
	}
	if err := json.Unmarshal(body.Items[0], &item); err != nil {
		return "", nil, err
	}
	offer := strings.TrimSpace(item.OfferID)
	if offer == "" {
		return "", nil, errBadImport
	}
	return offer, body.Items[0], nil
}

// mergeImport sends a one-item chunk as the frozen import bytes. A longer
// chunk is re-wrapped as {"items":[...]}. That re-serialization is not
// proven equal to ImportV3Request field order.
func mergeImport(originals [][]byte, items []json.RawMessage) ([]byte, error) {
	if len(originals) == 1 {
		return originals[0], nil
	}
	return json.Marshal(struct {
		Items []json.RawMessage `json:"items"`
	}{Items: items})
}

var errBatchChanged = errors.New("listing batch targets changed before dispatch")

var errBadImport = errString("frozen import must contain exactly one item")

type errString string

func (e errString) Error() string { return string(e) }
