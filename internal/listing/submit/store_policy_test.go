package submit

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	queue "github.com/xxww0098/podhub-go/internal/queue/contract"
)

func TestStorePolicyDayAndAllowance(t *testing.T) {
	cap := 2
	before := time.Date(2026, 10, 31, 15, 59, 59, 0, time.UTC)
	after := before.Add(time.Second)
	if got := policyDayStart(before); !got.Equal(time.Date(2026, 10, 30, 16, 0, 0, 0, time.UTC)) {
		t.Fatalf("wrong Shanghai day: %v", got)
	}
	if n, wait := policyAllowance(before, &cap, 0, 1, nil, 3); n != 1 || wait != nil {
		t.Fatalf("remaining product capacity: %d %+v", n, wait)
	}
	if n, wait := policyAllowance(before, &cap, 0, 2, nil, 1); n != 0 || wait == nil || wait.code != CodeStoreDailyCap || !wait.at.Equal(after) {
		t.Fatalf("daily boundary: %d %+v", n, wait)
	}
	if n, wait := policyAllowance(after, &cap, 0, 0, nil, 2); n != 2 || wait != nil {
		t.Fatalf("new day did not restore capacity: %d %+v", n, wait)
	}
	if n, wait := policyAllowance(after, nil, 60, 0, &before, 3); n != 0 || wait == nil || wait.code != CodeStoreSendGap || !wait.at.Equal(before.Add(time.Minute)) {
		t.Fatalf("send interval: %d %+v", n, wait)
	}
}

func policyWorkerPool(t *testing.T, pool *pgxpool.Pool) *pgxpool.Pool {
	t.Helper()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `ALTER ROLE podhub_login_listing_worker PASSWORD 'store-policy-worker'`); err != nil {
		t.Fatal(err)
	}
	cfg := pool.Config().Copy()
	cfg.ConnConfig.User, cfg.ConnConfig.Password = "podhub_login_listing_worker", "store-policy-worker"
	worker, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(worker.Close)
	return worker
}

func TestStorePolicySplitsOversizedBatchAndDefersWithoutSending(t *testing.T) {
	f, _, _, job, storePK := queuedTransportFixture(t, 986951, 3)
	worker := policyWorkerPool(t, f.pool)
	parentCreated := time.Now().Add(-48 * time.Hour).UTC().Truncate(time.Microsecond)
	drainCutoff := parentCreated.Add(time.Hour)
	if _, err := f.pool.Exec(f.ctx, `UPDATE jobs SET created_at=$2 WHERE id=$1`, job.ID, parentCreated); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO store_listing_policies(org_id,store_id,daily_cap) VALUES($1,$2,1)`, f.org, storePK); err != nil {
		t.Fatal(err)
	}
	tr := &capturedBatchTransport{}
	if err := testSubmit().Work(f.ctx, worker, job, tr); err != nil {
		t.Fatal(err)
	}
	if len(tr.ids) != 1 || tr.writes != 1 {
		t.Fatalf("oversized batch bypassed policy: ids=%v writes=%d", tr.ids, tr.writes)
	}
	var children, sameDrain int
	if err := f.pool.QueryRow(f.ctx, `SELECT count(*),count(*) FILTER(WHERE created_at=$3 AND created_at<$4)
		FROM jobs WHERE org_id=$1 AND id<>$2`, f.org, job.ID, parentCreated, drainCutoff).Scan(&children, &sameDrain); err != nil || children != 1 || sameDrain != 1 {
		t.Fatalf("split remainder escaped the parent drain range: children=%d same_drain=%d err=%v", children, sameDrain, err)
	}
	var next queue.Claimed
	err := f.pool.QueryRow(f.ctx, `UPDATE jobs SET state='running',attempt=1,lease_owner='policy-next',lease_epoch=1,lease_until=clock_timestamp()+interval '10 minutes'
		WHERE org_id=$1 AND state='queued' RETURNING id,org_id,kind,submitter_user_id,payload`, f.org).Scan(&next.ID, &next.OrgID, &next.Kind, &next.SubmitterUserID, &next.Payload)
	if err != nil {
		t.Fatal("remainder was not durably queued", err)
	}
	next.Owner, next.Epoch, next.Attempt, next.MaxAttempts = "policy-next", 1, 1, 8
	if err := testSubmit().Work(f.ctx, worker, next, tr); err != nil {
		t.Fatal(err)
	}
	var state, code string
	var attempts, pending, accepted, writes int
	var runAt time.Time
	if err := f.pool.QueryRow(f.ctx, `SELECT state,last_error_code,attempt,run_at FROM jobs WHERE id=$1`, next.ID).Scan(&state, &code, &attempts, &runAt); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FILTER(WHERE state='queued'),count(*) FILTER(WHERE state='accepted') FROM submission_intents WHERE org_id=$1`, f.org).Scan(&pending, &accepted); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FROM seller_upstream_writes WHERE org_id=$1`, f.org).Scan(&writes); err != nil {
		t.Fatal(err)
	}
	if state != "retry_wait" || code != CodeStoreDailyCap || attempts != 0 || pending != 2 || accepted != 1 || writes != 1 || tr.writes != 1 || !runAt.Equal(policyDayStart(time.Now()).Add(24*time.Hour)) {
		t.Fatalf("waiting batch lost state: %s/%s attempts=%d pending=%d accepted=%d ledger=%d calls=%d run_at=%v", state, code, attempts, pending, accepted, writes, tr.writes, runAt)
	}
	// Move only this test's dispatch into the previous local day; no wall-clock wait.
	if _, err := f.pool.Exec(f.ctx, `UPDATE seller_upstream_writes SET created_at=$2 WHERE org_id=$1`, f.org, policyDayStart(time.Now()).Add(-time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(f.ctx, `UPDATE jobs SET state='running',attempt=1,lease_owner='policy-next',lease_epoch=2,lease_until=clock_timestamp()+interval '10 minutes' WHERE id=$1 RETURNING payload`, next.ID).Scan(&next.Payload); err != nil {
		t.Fatal(err)
	}
	next.Epoch = 2
	if err := testSubmit().Work(f.ctx, worker, next, tr); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FILTER(WHERE state='queued'),count(*) FILTER(WHERE state='accepted') FROM submission_intents WHERE org_id=$1`, f.org).Scan(&pending, &accepted); err != nil {
		t.Fatal(err)
	}
	if pending != 1 || accepted != 2 || tr.writes != 2 {
		t.Fatalf("next local day did not resume exactly one remaining item: pending=%d accepted=%d calls=%d", pending, accepted, tr.writes)
	}
}

func TestStorePolicyAdmissionIsAtomicUnderWorkerRole(t *testing.T) {
	f, ready, views, _, storePK := queuedTransportFixture(t, 986952, 2)
	worker := policyWorkerPool(t, f.pool)
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO store_listing_policies(org_id,store_id,daily_cap) VALUES($1,$2,1)`, f.org, storePK); err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for i := range ready {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			in := Attempt{OrgID: f.org, IntentID: views[i].Intent.ID, RowID: ready[i].rowID, RowRevision: 1, StorePK: storePK, OfferID: ready[i].offerID, RequestHash: ready[i].digest, Body: ready[i].importBody}
			_, err := testSubmit().RunAttempt(f.ctx, worker, &receivedStoreTransport{}, in)
			results <- err
		}(i)
	}
	close(start)
	wg.Wait()
	close(results)
	passed, waiting := 0, 0
	for err := range results {
		var wait *policyWait
		if err == nil {
			passed++
		} else if errors.As(err, &wait) && wait.code == CodeStoreDailyCap {
			waiting++
		} else {
			t.Fatal(err)
		}
	}
	if passed != 1 || waiting != 1 {
		t.Fatalf("concurrent cap escaped: passed=%d waiting=%d", passed, waiting)
	}
}

func TestStorePolicyCountsUnknownAndReleasesOnlyProvenUnsent(t *testing.T) {
	for i, unsent := range []bool{false, true} {
		f, ready, views, _, storePK := queuedTransportFixture(t, 986953+int64(i), 2)
		worker := policyWorkerPool(t, f.pool)
		if _, err := f.pool.Exec(f.ctx, `INSERT INTO store_listing_policies(org_id,store_id,daily_cap,min_gap_seconds) VALUES($1,$2,1,60)`, f.org, storePK); err != nil {
			t.Fatal(err)
		}
		tr := &afterBeginTransport{err: errors.New("response lost")}
		if unsent {
			tr.err = ErrNotSent
		}
		in := Attempt{OrgID: f.org, IntentID: views[0].Intent.ID, RowID: ready[0].rowID, RowRevision: 1, StorePK: storePK, OfferID: ready[0].offerID, RequestHash: ready[0].digest, Body: ready[0].importBody}
		if _, err := testSubmit().RunAttempt(f.ctx, worker, tr, in); err != nil {
			t.Fatal(err)
		}
		tx, err := worker.Begin(f.ctx)
		if err != nil {
			t.Fatal(err)
		}
		if err := tenant.EnterApp(f.ctx, tx, f.org); err != nil {
			t.Fatal(err)
		}
		window, err := loadPolicyWindow(f.ctx, tx, f.org, storePK, 1)
		_ = tx.Rollback(f.ctx)
		if err != nil {
			t.Fatal(err)
		}
		if unsent && (window.today != 0 || window.last != nil || window.allowed != 1 || window.wait != nil) {
			t.Fatalf("proven unsent still consumes policy: %+v", window)
		}
		if !unsent && (window.today != 1 || window.wait == nil || window.allowed != 0) {
			t.Fatalf("unknown was allowed through: %+v", window)
		}
	}
}
