package submit

import (
	"context"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	queue "github.com/xxww0098/podhub-go/internal/queue/contract"
	queuerepo "github.com/xxww0098/podhub-go/internal/queue/repo"
)

func crashedPolicySplit(t *testing.T, user int64, cap int) (storedRevisionFixture, *pgxpool.Pool, queue.Claimed, []DraftItem) {
	t.Helper()
	f, ready, views, job, storePK := queuedTransportFixture(t, user, 3)
	worker := policyWorkerPool(t, f.pool)
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO store_listing_policies(org_id,store_id,daily_cap) VALUES($1,$2,$3)`, f.org, storePK, cap); err != nil {
		t.Fatal(err)
	}
	attempts := make([]Attempt, len(ready))
	for i := range ready {
		attempts[i] = Attempt{OrgID: f.org, IntentID: views[i].Intent.ID, RowID: ready[i].rowID,
			RowRevision: 1, StorePK: storePK, OfferID: ready[i].offerID, RequestHash: ready[i].digest,
			Body: ready[i].importBody, Lease: job.Lease()}
	}
	if n, err := testSubmit().splitPolicyBatch(f.ctx, worker, job, storePK, attempts); err != nil || n != cap {
		t.Fatalf("persist policy split: allowed=%d err=%v", n, err)
	}
	// The process exits here: only the split transaction committed, before
	// beginSendingTx. The normal sweeper must reclaim its expired lease.
	if _, err := f.pool.Exec(f.ctx, `UPDATE jobs SET lease_until=clock_timestamp()-interval '1 minute' WHERE id=$1`, job.ID); err != nil {
		t.Fatal(err)
	}
	if n, err := queuerepo.ReclaimExpiredRows(f.ctx, worker, job.Kind); err != nil || n != 1 {
		t.Fatalf("normal lease sweep: count=%d err=%v", n, err)
	}
	return f, worker, job, views
}

func TestPolicySplitCrashBeforeDispatchRecoversOnceAndFencesOldWorker(t *testing.T) {
	f, worker, old, _ := crashedPolicySplit(t, 989710, 1)
	start := make(chan struct{})
	counts := make(chan int, 2)
	failures := make(chan error, 2)
	var scans sync.WaitGroup
	for range 2 {
		scans.Add(1)
		go func() {
			defer scans.Done()
			<-start
			n, err := recoverStuckSubmitting(f.ctx, worker, 16)
			counts <- n
			failures <- err
		}()
	}
	close(start)
	scans.Wait()
	close(counts)
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatal(err)
		}
	}
	total := 0
	for count := range counts {
		total += count
	}
	if total != 1 {
		t.Fatalf("concurrent scanners recovered %d times", total)
	}
	var state string
	var epoch int64
	var cleanLease bool
	if err := f.pool.QueryRow(f.ctx, `SELECT state,lease_epoch,lease_owner IS NULL AND lease_until IS NULL FROM jobs WHERE id=$1`, old.ID).Scan(&state, &epoch, &cleanLease); err != nil || state != "retry_wait" || epoch != old.Epoch+1 || !cleanLease {
		t.Fatalf("recovered job=%s epoch=%d clean=%v err=%v", state, epoch, cleanLease, err)
	}
	stale := &capturedBatchTransport{}
	if err := testSubmit().Work(f.ctx, worker, old, stale); err == nil || stale.writes != 0 {
		t.Fatalf("old worker escaped recovery fence: calls=%d err=%v", stale.writes, err)
	}
	// Give this test's recovered head priority over its untouched remainder.
	if _, err := f.pool.Exec(f.ctx, `UPDATE jobs SET priority=0 WHERE id=$1`, old.ID); err != nil {
		t.Fatal(err)
	}
	claimed, err := queuerepo.Claim(f.ctx, worker, old.Kind, "recovered-policy-worker", 1)
	if err != nil || len(claimed) != 1 || claimed[0].ID != old.ID {
		t.Fatalf("normal claim did not recover first chunk: %+v err=%v", claimed, err)
	}
	tr := &capturedBatchTransport{}
	if err := testSubmit().Work(f.ctx, worker, claimed[0], tr); err != nil {
		t.Fatal(err)
	}
	var accepted, queued, writes int
	if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FILTER(WHERE state='accepted'),count(*) FILTER(WHERE state='queued') FROM submission_intents WHERE org_id=$1`, f.org).Scan(&accepted, &queued); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FROM seller_upstream_writes WHERE org_id=$1`, f.org).Scan(&writes); err != nil {
		t.Fatal(err)
	}
	if accepted != 1 || queued != 2 || writes != 1 || tr.writes != 1 || len(tr.ids) != 1 {
		t.Fatalf("recovered send duplicated or lost items: accepted=%d queued=%d ledger=%d calls=%d targets=%v", accepted, queued, writes, tr.writes, tr.ids)
	}
	if n, err := recoverPolicySplits(f.ctx, worker, 16); err != nil || n != 0 {
		t.Fatalf("settled job recovered again: n=%d err=%v", n, err)
	}
}

func TestPolicySplitRecoveryViaProbeDueUsesWorkerLogin(t *testing.T) {
	f, worker, old, _ := crashedPolicySplit(t, 989719, 1)
	if worker.Config().ConnConfig.User != "podhub_login_listing_worker" {
		t.Fatal("recovery must run with an ordinary worker login")
	}
	if _, err := ProbeDue(f.ctx, worker, nil, 16); err != nil {
		t.Fatal(err)
	}
	var recovered bool
	if err := f.pool.QueryRow(f.ctx, `SELECT state='retry_wait' AND lease_epoch=$2 AND lease_owner IS NULL AND lease_until IS NULL FROM jobs WHERE id=$1`, old.ID, old.Epoch+1).Scan(&recovered); err != nil || !recovered {
		t.Fatalf("formal probe scanner did not recover split: recovered=%v err=%v", recovered, err)
	}
}

func TestPolicySplitRecoveryRejectsAnyDispatchEvidenceOrMixedState(t *testing.T) {
	for i, test := range []struct {
		name   string
		mutate func(context.Context, *pgxpool.Pool, int64, string) error
	}{
		{name: "unknown", mutate: func(ctx context.Context, pool *pgxpool.Pool, _ int64, id string) error {
			_, err := pool.Exec(ctx, `UPDATE submission_intents SET state='unknown' WHERE id=$1::uuid`, id)
			return err
		}},
		{name: "submitting", mutate: func(ctx context.Context, pool *pgxpool.Pool, _ int64, id string) error {
			_, err := pool.Exec(ctx, `UPDATE submission_intents SET state='submitting' WHERE id=$1::uuid`, id)
			return err
		}},
		{name: "queued with seller ledger", mutate: func(ctx context.Context, pool *pgxpool.Pool, org int64, id string) error {
			_, err := pool.Exec(ctx, `INSERT INTO seller_upstream_writes(org_id,store_id,idempotency_key,request_hash,state,kind)
			 SELECT $1,s.id,$2,'already-dispatched','dispatching','import' FROM organization_stores s WHERE s.org_id=$1`, org, id)
			return err
		}},
		{name: "queued with receipt", mutate: func(ctx context.Context, pool *pgxpool.Pool, _ int64, id string) error {
			_, err := pool.Exec(ctx, `UPDATE submission_intents SET external_task_id='71' WHERE id=$1::uuid`, id)
			return err
		}},
		{name: "queued with issued browser credential", mutate: func(ctx context.Context, pool *pgxpool.Pool, _ int64, id string) error {
			_, err := pool.Exec(ctx, `UPDATE submission_intents SET credential_granted_at=clock_timestamp() WHERE id=$1::uuid`, id)
			return err
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			f, worker, old, views := crashedPolicySplit(t, 989711+int64(i), 2)
			// Alter only the second item: the entire head must be proven unsent.
			if err := test.mutate(f.ctx, f.pool, f.org, views[1].Intent.ID); err != nil {
				t.Fatal(err)
			}
			if n, err := recoverPolicySplits(f.ctx, worker, 16); err != nil || n != 0 {
				t.Fatalf("unsafe split recovered: n=%d err=%v", n, err)
			}
			var unchanged bool
			if err := f.pool.QueryRow(f.ctx, `SELECT state='failed' AND lease_epoch=$2 FROM jobs WHERE id=$1`, old.ID, old.Epoch).Scan(&unchanged); err != nil || !unchanged {
				t.Fatalf("unsafe job changed: unchanged=%v err=%v", unchanged, err)
			}
		})
	}
}
