package integration

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/listing/submit"
	queuecontract "github.com/xxww0098/podhub-go/internal/queue/contract"
	queuedomain "github.com/xxww0098/podhub-go/internal/queue/domain"
)

// TestParallelBatchReceiptSurvivesLeaseLock is the Rust 0.0.112 lesson:
// four listing.submit.batch jobs share one media_object_leases row. The
// receipt is committed before that row is touched, so a lock does not drop
// the task id and a retry does not send again.
func TestParallelBatchReceiptSurvivesLeaseLock(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	userID, orgID := insertWorkspace(t, ctx, pool, "lease-"+uuid.NewString()+"@example.com", "lease")
	storePK, storeID := insertStore(t, ctx, pool, orgID)
	workspace := uuid.NewString()
	if _, err := pool.Exec(ctx, `UPDATE public.organizations SET uuid = $1::uuid WHERE id = $2`, workspace, orgID); err != nil {
		t.Fatal(err)
	}
	digest := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	image := "https://cdn.example/uploads/2023-11-14/1700000000000-22222222-2222-4222-8222-222222222222/images/teams/" + workspace + "/sha256/" + digest + ".jpg"
	if _, err := pool.Exec(ctx, `
		INSERT INTO public.media_object_leases (
			workspace_uuid, batch_id, content_hash, org_id, object_key, media_account_id,
			first_seen_at, last_hit_at, expires_at)
		VALUES ($1::uuid, '', $2, $3, $4, 'acct', clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '7 days')`,
		workspace, digest, orgID, "images/teams/"+workspace+"/sha256/"+digest+".jpg"); err != nil {
		t.Fatal(err)
	}

	prev := submit.OrgSubmitBatchLimit
	submit.OrgSubmitBatchLimit = 8
	t.Cleanup(func() { submit.OrgSubmitBatchLimit = prev })

	var seq atomic.Int32
	var posts atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v3/product/import" {
			http.NotFound(w, r)
			return
		}
		posts.Add(1)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"result":{"task_id":` + strconv.Itoa(1000+int(seq.Add(1))) + `}}`))
	}))
	t.Cleanup(srv.Close)
	eg := egress(t, srv.URL, false)

	const n = 4
	type batch struct {
		row  submit.Seed
		job  queuecontract.Claimed
		task string
	}
	batches := make([]batch, n)
	for i := 0; i < n; i++ {
		offer := "offer-" + uuid.NewString()
		row := submit.Seed{
			OrgID: orgID, StorePK: storePK, StoreID: storeID,
			IntentID: uuid.NewString(), RowID: uuid.NewString(), CardID: uuid.NewString(),
			OfferID: offer, ClientOp: uuid.NewString(),
			RequestHash: "import", RowRevision: 1,
			Import: []byte(`{"items":[{"offer_id":"` + offer + `","images":["` + image + `"]}]}`),
		}
		if err := submit.InsertQueued(ctx, pool, row); err != nil {
			t.Fatal(err)
		}
		jobID := uuid.New()
		payload := `{"storeId":"` + storeID + `","intents":[{"intentId":"` + row.IntentID + `","rowId":"` + row.RowID + `","rowRevision":1,"requestHash":"import","import":` + string(row.Import) + `}]}`
		if _, err := pool.Exec(ctx, `
			INSERT INTO public.jobs (
				id, org_id, kind, aggregate_type, aggregate_id, input_revision, idempotency_key,
				state, attempt, max_attempts, lane, submitter_user_id, payload, cost_units,
				lease_owner, lease_epoch, lease_until)
			VALUES (
				$1::uuid, $2, 'listing.submit.batch', 'submission_batch', $3::uuid, 0, $4,
				'running', 1, 8, 'listing.submit.batch', $5, $6::jsonb, 4,
				'listing-test', 1, clock_timestamp() + interval '5 minutes')`,
			jobID, orgID, uuid.NewString(), "batch-"+jobID.String(), userID, payload); err != nil {
			t.Fatal(err)
		}
		batches[i] = batch{row: row, job: queuecontract.Claimed{
			ID: jobID, OrgID: orgID, Kind: "listing.submit.batch", SubmitterUserID: userID,
			Attempt: 1, MaxAttempts: 8, Epoch: 1, Owner: "listing-test", Payload: []byte(payload),
		}}
	}

	// A pool connection held for the row lock would starve the four workers
	// when the pool's max connections is four. This session is outside the pool.
	conn, err := pgx.ConnectConfig(ctx, pool.Config().ConnConfig.Copy())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	lock, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var held string
	if err := lock.QueryRow(ctx, `
		SELECT content_hash FROM public.media_object_leases
		 WHERE workspace_uuid = $1::uuid AND content_hash = $2
		   FOR UPDATE`, workspace, digest).Scan(&held); err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	errs := make([]error, n)
	for i := range batches {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			errs[i] = submit.Work(ctx, pool, batches[i].job, eg.Port())
		}(i)
	}
	finished := make(chan struct{})
	go func() {
		wg.Wait()
		close(finished)
	}()
	select {
	case <-finished:
	case <-time.After(30 * time.Second):
		t.Fatal("workers did not finish while the lease row was locked")
	}
	for i, err := range errs {
		if !errors.Is(err, queuedomain.ErrLockBusy) {
			t.Fatalf("batch %d: %v", i, err)
		}
	}
	if posts.Load() != n {
		t.Fatalf("posts while locked %d", posts.Load())
	}
	seen := map[string]struct{}{}
	for i, batch := range batches {
		var state, task string
		if err := pool.QueryRow(ctx, `
			SELECT state, external_task_id FROM public.submission_intents WHERE id = $1::uuid`,
			batch.row.IntentID).Scan(&state, &task); err != nil {
			t.Fatal(err)
		}
		if state != "submitting" || task == "" {
			t.Fatalf("receipt %d state %s task %q", i, state, task)
		}
		if _, dup := seen[task]; dup {
			t.Fatalf("duplicate task %s", task)
		}
		seen[task] = struct{}{}
		batches[i].task = task
		var writes int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM public.seller_upstream_writes WHERE idempotency_key = $1`, batch.row.IntentID).Scan(&writes); err != nil || writes != 1 {
			t.Fatalf("writes %d %v", writes, err)
		}
	}
	if err := lock.Rollback(ctx); err != nil {
		t.Fatal(err)
	}

	for i := range batches {
		var err error
		for try := 0; try < 8; try++ {
			err = submit.Work(ctx, pool, batches[i].job, eg.Port())
			if !errors.Is(err, queuedomain.ErrLockBusy) {
				break
			}
		}
		if err != nil {
			t.Fatalf("retry %d: %v", i, err)
		}
	}
	if posts.Load() != n {
		t.Fatalf("posts after unlock %d", posts.Load())
	}
	for i, batch := range batches {
		var state, task string
		if err := pool.QueryRow(ctx, `
			SELECT state, external_task_id FROM public.submission_intents WHERE id = $1::uuid`,
			batch.row.IntentID).Scan(&state, &task); err != nil {
			t.Fatal(err)
		}
		if state != "accepted" || task != batch.task {
			t.Fatalf("converged %d state %s task %s want %s", i, state, task, batch.task)
		}
		var writes int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM public.seller_upstream_writes WHERE idempotency_key = $1`, batch.row.IntentID).Scan(&writes); err != nil || writes != 1 {
			t.Fatalf("writes after retry %d %v", writes, err)
		}
		var rows int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM public.listing_rows WHERE id = $1::uuid`, batch.row.RowID).Scan(&rows); err != nil || rows != 1 {
			t.Fatalf("rows %d %v", rows, err)
		}
	}
}

func TestOrgBatchCapDoesNotSend(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	userID, orgID := insertWorkspace(t, ctx, pool, "cap-"+uuid.NewString()+"@example.com", "cap")
	storePK, storeID := insertStore(t, ctx, pool, orgID)
	prev := submit.OrgSubmitBatchLimit
	submit.OrgSubmitBatchLimit = 1
	t.Cleanup(func() { submit.OrgSubmitBatchLimit = prev })

	var posts atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		posts.Add(1)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"result":{"task_id":1}}`))
	}))
	t.Cleanup(srv.Close)
	eg := egress(t, srv.URL, false)

	if _, err := pool.Exec(ctx, `
		INSERT INTO public.jobs (
			id, org_id, kind, aggregate_type, aggregate_id, input_revision, idempotency_key,
			state, attempt, max_attempts, lane, submitter_user_id, payload, cost_units,
			lease_owner, lease_epoch, lease_until)
		VALUES (
			$1::uuid, $2, 'listing.submit.batch', 'submission_batch', $3::uuid, 0, $4,
			'running', 1, 8, 'listing.submit.batch', $5, '{}'::jsonb, 4,
			'other', 1, clock_timestamp() + interval '5 minutes')`,
		uuid.NewString(), orgID, uuid.NewString(), "other-"+uuid.NewString(), userID); err != nil {
		t.Fatal(err)
	}
	row := submit.Seed{
		OrgID: orgID, StorePK: storePK, StoreID: storeID,
		IntentID: uuid.NewString(), RowID: uuid.NewString(), CardID: uuid.NewString(),
		OfferID: "cap-" + uuid.NewString(), ClientOp: uuid.NewString(),
		RequestHash: "import", RowRevision: 1,
		Import: []byte(`{"items":[{"offer_id":"cap"}]}`),
	}
	if err := submit.InsertQueued(ctx, pool, row); err != nil {
		t.Fatal(err)
	}
	jobID := uuid.New()
	payload := []byte(`{"storeId":"` + storeID + `","intents":[{"intentId":"` + row.IntentID + `","rowId":"` + row.RowID + `","rowRevision":1,"requestHash":"import","import":{"items":[{"offer_id":"cap"}]}}]}`)
	if _, err := pool.Exec(ctx, `
		INSERT INTO public.jobs (
			id, org_id, kind, aggregate_type, aggregate_id, input_revision, idempotency_key,
			state, attempt, max_attempts, lane, submitter_user_id, payload, cost_units,
			lease_owner, lease_epoch, lease_until)
		VALUES (
			$1::uuid, $2, 'listing.submit.batch', 'submission_batch', $3::uuid, 0, $4,
			'running', 1, 8, 'listing.submit.batch', $5, $6::jsonb, 4,
			'listing-test', 1, clock_timestamp() + interval '5 minutes')`,
		jobID, orgID, uuid.NewString(), "cap-"+jobID.String(), userID, payload); err != nil {
		t.Fatal(err)
	}
	err := submit.Work(ctx, pool, queuecontract.Claimed{
		ID: jobID, OrgID: orgID, Kind: "listing.submit.batch", SubmitterUserID: userID,
		Attempt: 1, MaxAttempts: 8, Epoch: 1, Owner: "listing-test", Payload: payload,
	}, eg.Port())
	if !errors.Is(err, queuedomain.ErrOrgCap) {
		t.Fatal(err)
	}
	if posts.Load() != 0 {
		t.Fatalf("posts %d", posts.Load())
	}
	var state string
	var task *string
	if err := pool.QueryRow(ctx, `SELECT state, external_task_id FROM public.submission_intents WHERE id = $1::uuid`, row.IntentID).Scan(&state, &task); err != nil {
		t.Fatal(err)
	}
	if state != "queued" || task != nil {
		t.Fatalf("state %s task %v", state, task)
	}
}

func TestReconcilerClosesFailedSubmitting(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	userID, orgID := insertWorkspace(t, ctx, pool, "stuck-"+uuid.NewString()+"@example.com", "stuck")
	_, storeID := insertStore(t, ctx, pool, orgID)
	with := seed(t, ctx, pool, orgID, 0, storeID, "stuck-with")
	without := seed(t, ctx, pool, orgID, 0, storeID, "stuck-without")
	if _, err := pool.Exec(ctx, `
		UPDATE public.submission_intents
		   SET state = 'submitting', external_task_id = '77',
		       updated_at = clock_timestamp() - interval '2 minutes'
		 WHERE id = $1::uuid`, with.IntentID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		UPDATE public.submission_intents
		   SET state = 'submitting', updated_at = clock_timestamp() - interval '2 minutes'
		 WHERE id = $1::uuid`, without.IntentID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		UPDATE public.submission_intents
		   SET reconcile_after = clock_timestamp() + interval '1 day'
		 WHERE state = 'unknown'`); err != nil {
		t.Fatal(err)
	}
	insertFailedSubmitJob(t, ctx, pool, orgID, userID, `{"intentId":"`+with.IntentID+`"}`)
	insertFailedSubmitJob(t, ctx, pool, orgID, userID, `{"intents":[{"intentId":"`+without.IntentID+`"}]}`)

	var posts atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		posts.Add(1)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"items":[]}`))
	}))
	t.Cleanup(srv.Close)
	if _, err := submit.ProbeDue(ctx, pool, egress(t, srv.URL, false).Port(), 16); err != nil {
		t.Fatal(err)
	}
	var state, task string
	if err := pool.QueryRow(ctx, `SELECT state, external_task_id FROM public.submission_intents WHERE id = $1::uuid`, with.IntentID).Scan(&state, &task); err != nil {
		t.Fatal(err)
	}
	if state != "accepted" || task != "77" {
		t.Fatalf("with task %s %s", state, task)
	}
	var bare string
	var bareTask *string
	if err := pool.QueryRow(ctx, `SELECT state, external_task_id FROM public.submission_intents WHERE id = $1::uuid`, without.IntentID).Scan(&bare, &bareTask); err != nil {
		t.Fatal(err)
	}
	if bare != "unknown" || bareTask != nil {
		t.Fatalf("without task %s %v", bare, bareTask)
	}
	if posts.Load() != 0 {
		t.Fatalf("posts %d", posts.Load())
	}
}

func insertFailedSubmitJob(t *testing.T, ctx context.Context, pool *pgxpool.Pool, orgID, userID int64, payload string) {
	t.Helper()
	if _, err := pool.Exec(ctx, `
		INSERT INTO public.jobs (
			id, org_id, kind, aggregate_type, aggregate_id, input_revision, idempotency_key,
			state, attempt, max_attempts, lane, submitter_user_id, payload, cost_units)
		VALUES (
			$1::uuid, $2, 'listing.submit', 'listing_row', $3::uuid, 0, $4,
			'failed', 8, 8, 'listing.submit', $5, $6::jsonb, 4)`,
		uuid.NewString(), orgID, uuid.NewString(), "failed-"+uuid.NewString(), userID, payload); err != nil {
		t.Fatal(err)
	}
}
