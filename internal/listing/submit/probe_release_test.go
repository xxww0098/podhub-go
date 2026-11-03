package submit

import (
	"context"
	"errors"
	"testing"
	"time"

	queue "github.com/xxww0098/podhub-go/internal/queue/contract"
)

type lostResponseTransport struct{ receivedStoreTransport }

func (tr *lostResponseTransport) Write(context.Context, string, []byte) (int, string, error) {
	tr.writes++
	return 0, "", errors.New("response lost after dispatch")
}

func TestProbeReleaseClosesUnknownEffectAndAllowsNewIntent(t *testing.T) {
	f, ready, views, job, storePK := queuedTransportFixture(t, 986817, 1)
	in := Attempt{OrgID: f.org, IntentID: views[0].Intent.ID, RowID: ready[0].rowID,
		RowRevision: 1, StorePK: storePK, OfferID: ready[0].offerID,
		RequestHash: ready[0].digest, Body: ready[0].importBody, Lease: job.Lease()}
	if out, err := testSubmit().RunAttempt(f.ctx, f.pool, &lostResponseTransport{}, in); err != nil || out.IntentState != Unknown {
		t.Fatalf("lost response: %+v err=%v", out, err)
	}
	if _, err := f.pool.Exec(f.ctx, `UPDATE submission_intents SET reconcile_after=clock_timestamp()-interval '1 second',reconciliation_outcome='{"probe":{"passes":1,"observation":"absent"}}' WHERE id=$1::uuid`, in.IntentID); err != nil {
		t.Fatal(err)
	}
	claimed, err := claimDue(f.ctx, f.pool, 1)
	if err != nil || len(claimed) != 1 {
		t.Fatalf("claim=%+v err=%v", claimed, err)
	}
	if err := applyGroup(f.ctx, f.pool, f.org, claimed, map[string]sightHit{in.IntentID: {Sight: SightAbsent}}); err != nil {
		t.Fatal(err)
	}
	var state, rowState, writeState, occupancy string
	if err := f.pool.QueryRow(f.ctx, `SELECT i.state,r.submission_state,w.state,o.state
	 FROM submission_intents i JOIN listing_rows r ON r.id=i.listing_row_id
	 JOIN seller_upstream_writes w ON w.org_id=i.org_id AND w.idempotency_key=i.id::text
	 JOIN seller_resource_occupancies o ON o.org_id=i.org_id AND o.owner_ref=i.id::text
	 WHERE i.id=$1::uuid`, in.IntentID).Scan(&state, &rowState, &writeState, &occupancy); err != nil {
		t.Fatal(err)
	}
	if state != Superseded || rowState != "none" || writeState != "reconciled" || occupancy != "released" {
		t.Fatalf("inconsistent release: intent=%s row=%s write=%s occupancy=%s", state, rowState, writeState, occupancy)
	}
	ready[0].clientOp += "-retry"
	seedIntent(t, f.ctx, f.pool, f.org, f.store, f.card, ready[0], Queued, time.Now())
	if err := f.pool.QueryRow(f.ctx, `SELECT id::text FROM submission_intents WHERE org_id=$1 AND client_operation_id=$2`, f.org, ready[0].clientOp).Scan(&in.IntentID); err != nil {
		t.Fatal(err)
	}
	in.Lease = queue.Lease{}
	tr := &receivedStoreTransport{}
	if out, err := testSubmit().RunAttempt(f.ctx, f.pool, tr, in); err != nil || out.IntentState != Accepted || tr.writes != 1 {
		t.Fatalf("released offer cannot be sent again: %+v requests=%d err=%v", out, tr.writes, err)
	}
}
