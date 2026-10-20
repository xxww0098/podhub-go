package integration

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	_ "github.com/xxww0098/podhub-go/internal/queue"
	queuecontract "github.com/xxww0098/podhub-go/internal/queue/contract"
	queuedomain "github.com/xxww0098/podhub-go/internal/queue/domain"
	queuerepo "github.com/xxww0098/podhub-go/internal/queue/repo"
	queueservice "github.com/xxww0098/podhub-go/internal/queue/service"
)

func purgeParityFixtures(ctx context.Context, pool *pgxpool.Pool) error {
	_, err := pool.Exec(ctx, `
		DROP TABLE IF EXISTS parity_jobs;
		DELETE FROM jobs
		 WHERE submitter_user_id = 91001
		    OR submitter_user_id BETWEEN 93000 AND 94999
		    OR idempotency_key IN ('browser-1', 'cloud-1');
		DELETE FROM execution_permits
		 WHERE user_id = 1 OR user_id BETWEEN 93000 AND 94999;
		DELETE FROM execution_fairness
		 WHERE user_id = 1 OR user_id BETWEEN 93000 AND 94999;
		DELETE FROM execution_quota
		 WHERE user_id = 1 OR user_id BETWEEN 93000 AND 94999;
		DELETE FROM account_queue_head
		 WHERE user_id IN (1, 91001) OR user_id BETWEEN 93000 AND 94999;
		DELETE FROM organization_members
		 WHERE user_id = 91001 OR user_id BETWEEN 93000 AND 94999;
		DELETE FROM organizations
		 WHERE owner_user_id = 91001 OR owner_user_id BETWEEN 93000 AND 94999;
		DELETE FROM account_users
		 WHERE id = 91001 OR id BETWEEN 93000 AND 94999;
		UPDATE execution_fairness_cursor
		   SET last_user_id = 0
		 WHERE last_user_id BETWEEN 93000 AND 94999;
		DELETE FROM account_queue_cursor`)
	return err
}

func seedTenant(t *testing.T, ctx context.Context, pool *pgxpool.Pool, userID int64) int64 {
	t.Helper()
	tag := fmt.Sprintf("k%d", userID)
	if _, err := pool.Exec(ctx, `
		INSERT INTO account_users (id, public_id, email, password_hash, role, name, target, supplier_id, plan, created_at, updated_at)
		VALUES ($1, $2, $3, 'x', 'user', 'Kernel', '/workspace', '', 'lite', clock_timestamp(), clock_timestamp())`,
		userID, tag, tag+"@example.invalid"); err != nil {
		t.Fatal(err)
	}
	var orgID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO organizations (owner_user_id, name, plan, created_at, updated_at)
		VALUES ($1, $2, 'lite', clock_timestamp(), clock_timestamp())
		RETURNING id`, userID, "org-"+tag).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO organization_members (org_id, user_id, role, status, display_name, created_at, updated_at, join_order)
		VALUES ($1, $2, 'owner', 'active', 'Kernel', clock_timestamp(), clock_timestamp(), 1)`,
		orgID, userID); err != nil {
		t.Fatal(err)
	}
	return orgID
}

func jobInput(org, user int64, kind, key, payload string) queuecontract.NewJob {
	if payload == "" {
		payload = `{}`
	}
	return queuecontract.NewJob{
		ID: uuid.New(), OrgID: org, Kind: kind, AggregateType: "listing_row",
		AggregateID: uuid.New(), InputRevision: 1, IdempotencyKey: key,
		Payload: []byte(payload), SubmitterUserID: user,
	}
}

type seenJob struct {
	state   string
	attempt int32
	epoch   int64
	owner   *string
	until   *time.Time
	errCode *string
}

func readJob(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id uuid.UUID) seenJob {
	t.Helper()
	var row seenJob
	if err := pool.QueryRow(ctx, `
		SELECT state, attempt, lease_epoch, lease_owner, lease_until, last_error_code
		  FROM jobs WHERE id = $1`, id).Scan(
		&row.state, &row.attempt, &row.epoch, &row.owner, &row.until, &row.errCode); err != nil {
		t.Fatal(err)
	}
	return row
}

func headCosts(t *testing.T, ctx context.Context, pool *pgxpool.Pool, user int64, lane string) (queued, running int64, present bool) {
	t.Helper()
	err := pool.QueryRow(ctx, `
		SELECT queued_cost, running_cost FROM account_queue_head
		 WHERE user_id = $1 AND lane = $2`, user, lane).Scan(&queued, &running)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, 0, false
	}
	if err != nil {
		t.Fatal(err)
	}
	return queued, running, true
}

func sumCosts(t *testing.T, ctx context.Context, pool *pgxpool.Pool, user int64, lane string) (queued, running int64) {
	t.Helper()
	// Independent of refresh_account_queue_head. Browser media.render and
	// media.upload contribute nothing; queued and retry_wait are queued
	// cost; running is running cost. Declaration 269.
	if err := pool.QueryRow(ctx, `
		SELECT
			COALESCE(sum(cost_units) FILTER (
				WHERE state IN ('queued', 'retry_wait')
				  AND NOT (kind IN ('media.render', 'media.upload') AND executor = 'browser')
			), 0),
			COALESCE(sum(cost_units) FILTER (
				WHERE state = 'running'
				  AND NOT (kind IN ('media.render', 'media.upload') AND executor = 'browser')
			), 0)
		  FROM jobs
		 WHERE submitter_user_id = $1 AND lane = $2`, user, lane).Scan(&queued, &running); err != nil {
		t.Fatal(err)
	}
	return queued, running
}

func assertHeadMatchesSum(t *testing.T, ctx context.Context, pool *pgxpool.Pool, user int64, lane string) {
	t.Helper()
	queued, running, present := headCosts(t, ctx, pool, user, lane)
	wantQ, wantR := sumCosts(t, ctx, pool, user, lane)
	if queued != wantQ || running != wantR {
		t.Fatalf("user %d lane %s head %d/%d sum %d/%d", user, lane, queued, running, wantQ, wantR)
	}
	if wantQ == 0 && wantR == 0 && present {
		t.Fatalf("user %d lane %s kept an empty head", user, lane)
	}
}

func testKernelRows(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	if err := purgeParityFixtures(ctx, pool); err != nil {
		t.Fatal(err)
	}
	orgA := seedTenant(t, ctx, pool, 93011)
	orgB := seedTenant(t, ctx, pool, 93012)
	base := time.Now().Add(-3 * time.Minute).UTC()
	a1 := jobInput(orgA, 93011, "listing.submit", "a1", `{"n":1}`)
	a1.Priority = 100
	a1.CreatedAt = base
	a2 := jobInput(orgA, 93011, "listing.submit", "a2", `{}`)
	a2.Priority = 100
	a2.CreatedAt = base.Add(time.Second)
	a3 := jobInput(orgA, 93011, "listing.submit", "a3", `{}`)
	a3.Priority = 10
	a3.CreatedAt = base.Add(2 * time.Second)
	httpJob := jobInput(orgA, 93011, "listing.submit", "http-1", `{"executor":"http"}`)
	browser := jobInput(orgA, 93011, "media.render", "browser-media", `{"executor":"browser"}`)
	b1 := jobInput(orgB, 93012, "listing.submit", "b1", `{}`)
	later := jobInput(orgA, 93011, "store.product_sync", "later", `{}`)
	later.RunAt = time.Now().Add(time.Hour)

	if got, err := queuerepo.Enqueue(ctx, pool, nil, 256); err != nil || got != nil {
		t.Fatalf("empty batch %+v %v", got, err)
	}
	bad := a1
	bad.SubmitterUserID = 0
	if _, err := queuerepo.Enqueue(ctx, pool, []queuecontract.NewJob{bad}, 256); !errors.Is(err, queuerepo.ErrSubmitter) {
		t.Fatalf("submitter: %v", err)
	}

	listen, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer listen.Release()
	if _, err := listen.Exec(ctx, "LISTEN ozon_jobs_wake"); err != nil {
		t.Fatal(err)
	}
	if _, err := queuerepo.Enqueue(ctx, pool, []queuecontract.NewJob{browser}, 256); err != nil {
		t.Fatal(err)
	}
	quiet, cancel := context.WithTimeout(ctx, 200*time.Millisecond)
	defer cancel()
	if _, err := listen.Conn().WaitForNotification(quiet); err == nil {
		t.Fatal("browser insert must not notify")
	}
	inserted, err := queuerepo.Enqueue(ctx, pool, []queuecontract.NewJob{a1, a2, a3, httpJob, b1, later}, 256)
	if err != nil {
		t.Fatal(err)
	}
	if len(inserted) != 6 || !inserted[0].Inserted || inserted[0].ID != a1.ID {
		t.Fatalf("insert %+v", inserted[0])
	}
	note := waitNote(t, ctx, listen)
	if note != "listing.submit" {
		t.Fatalf("wake %q", note)
	}

	replay := a1
	replay.ID = uuid.New()
	replay.Payload = []byte(`{"n":2}`)
	again, err := queuerepo.Enqueue(ctx, pool, []queuecontract.NewJob{replay}, 256)
	if err != nil {
		t.Fatal(err)
	}
	if again[0].Inserted || again[0].ID != a1.ID || again[0].State != "queued" || again[0].Attempt != 0 {
		t.Fatalf("replay %+v", again[0])
	}
	var samePayload bool
	if err := pool.QueryRow(ctx, `SELECT payload = '{"n":1}'::jsonb FROM jobs WHERE id = $1`, a1.ID).Scan(&samePayload); err != nil || !samePayload {
		t.Fatal("replay changed the payload")
	}
	var rows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM jobs WHERE org_id = $1 AND kind = 'listing.submit' AND idempotency_key = 'a1'`, orgA).Scan(&rows); err != nil || rows != 1 {
		t.Fatalf("rows %d %v", rows, err)
	}

	fullOrg := seedTenant(t, ctx, pool, 93013)
	full := jobInput(fullOrg, 93013, "ai.recognize", "full-1", `{}`)
	if _, err := queuerepo.Enqueue(ctx, pool, []queuecontract.NewJob{full}, 8); err != nil {
		t.Fatal(err)
	}
	overflow := jobInput(fullOrg, 93013, "ai.recognize", "full-2", `{}`)
	if _, err := queuerepo.Enqueue(ctx, pool, []queuecontract.NewJob{overflow}, 8); !errors.Is(err, queuerepo.ErrLaneFull) {
		t.Fatalf("cap: %v", err)
	}
	fullReplay := full
	fullReplay.ID = uuid.New()
	fullReplay.Payload = []byte(`{"n":9}`)
	kept, err := queuerepo.Enqueue(ctx, pool, []queuecontract.NewJob{fullReplay}, 8)
	if err != nil || kept[0].ID != full.ID {
		t.Fatalf("full replay %+v %v", kept, err)
	}

	assertHeadMatchesSum(t, ctx, pool, 93011, "listing.submit")
	assertHeadMatchesSum(t, ctx, pool, 93011, "media.render")
	assertHeadMatchesSum(t, ctx, pool, 93012, "listing.submit")

	claimed, err := queuerepo.Claim(ctx, pool, "listing.submit", "kernel-test", 4)
	if err != nil {
		t.Fatal(err)
	}
	if len(claimed) != 3 || claimed[0].ID != a3.ID || claimed[1].ID != a1.ID || claimed[2].ID != b1.ID {
		t.Fatalf("claim order %+v", idsOf(claimed))
	}
	for _, job := range claimed {
		if job.Attempt != 1 || job.Epoch != 1 || job.Owner != "kernel-test" || !job.Until.After(time.Now()) {
			t.Fatalf("claimed %+v", job)
		}
		row := readJob(t, ctx, pool, job.ID)
		if row.state != "running" || row.attempt != 1 || row.epoch != 1 || row.owner == nil || *row.owner != "kernel-test" {
			t.Fatalf("row %+v", row)
		}
	}
	if row := readJob(t, ctx, pool, a2.ID); row.state != "queued" || row.attempt != 0 {
		t.Fatalf("third job of the same user must stay queued, %+v", row)
	}
	if row := readJob(t, ctx, pool, httpJob.ID); row.state != "queued" {
		t.Fatalf("http executor %+v", row)
	}
	if row := readJob(t, ctx, pool, browser.ID); row.state != "queued" {
		t.Fatalf("browser %+v", row)
	}
	missed, err := queuerepo.Claim(ctx, pool, "store.product_sync", "kernel-test", 4)
	if err != nil || len(missed) != 0 {
		t.Fatalf("future run_at %+v %v", missed, err)
	}
	assertHeadMatchesSum(t, ctx, pool, 93011, "listing.submit")
	assertHeadMatchesSum(t, ctx, pool, 93012, "listing.submit")

	before := readJob(t, ctx, pool, a3.ID)
	ok, err := queuerepo.Renew(ctx, pool, claimed[0].Lease())
	if err != nil || !ok {
		t.Fatalf("renew %v %v", ok, err)
	}
	after := readJob(t, ctx, pool, a3.ID)
	if after.until == nil || before.until == nil || after.until.Before(*before.until) {
		t.Fatalf("renew until %v -> %v", before.until, after.until)
	}
	stale := claimed[0].Lease()
	stale.Epoch = 99
	if ok, err := queuerepo.Settle(ctx, pool, stale, "succeeded", nil); err != nil || ok {
		t.Fatalf("stale settle %v %v", ok, err)
	}
	if row := readJob(t, ctx, pool, a3.ID); row.state != "running" {
		t.Fatalf("stale settle wrote %+v", row)
	}

	ok, err = queuerepo.RequeueJob(ctx, pool, claimed[1].Lease(), queuedomain.ReasonStoreBusy, 0)
	if err != nil || !ok {
		t.Fatalf("requeue %v %v", ok, err)
	}
	requeued := readJob(t, ctx, pool, a1.ID)
	want := queuedomain.Requeue(1, 8, queuedomain.ReasonStoreBusy)
	if requeued.state != want.State || requeued.attempt != want.Attempt || requeued.owner != nil || requeued.until != nil {
		t.Fatalf("requeue row %+v want %+v", requeued, want)
	}
	if requeued.errCode == nil || *requeued.errCode != "store_busy" {
		t.Fatalf("requeue error %+v", requeued.errCode)
	}
	delay := queuedomain.RequeueDelay("listing.submit", 1, queuedomain.ReasonStoreBusy, 0, queuedomain.JitterSeed(a1.ID.String(), 1, 1))
	var ahead float64
	if err := pool.QueryRow(ctx, `SELECT EXTRACT(EPOCH FROM (run_at - clock_timestamp())) FROM jobs WHERE id = $1`, a1.ID).Scan(&ahead); err != nil {
		t.Fatal(err)
	}
	if ahead < delay.Seconds()-2 || ahead > delay.Seconds()+2 {
		t.Fatalf("run_at ahead %fs, delay %s", ahead, delay)
	}

	if _, err := pool.Exec(ctx, `UPDATE jobs SET lease_until = clock_timestamp() - interval '1 second' WHERE id = $1`, b1.ID); err != nil {
		t.Fatal(err)
	}
	n, err := queuerepo.ReclaimExpiredRows(ctx, pool, "listing.submit")
	if err != nil || n != 1 {
		t.Fatalf("reclaim %d %v", n, err)
	}
	expired := readJob(t, ctx, pool, b1.ID)
	outcome := queuedomain.ReclaimExpired(queuedomain.LeaseInput{Kind: "listing.submit", Executor: "", Attempt: 1, MaxAttempts: 8})
	if expired.state != outcome.State || expired.attempt != 1 || expired.owner != nil || expired.until != nil {
		t.Fatalf("expired %+v outcome %+v", expired, outcome)
	}
	if row := readJob(t, ctx, pool, a3.ID); row.state != "running" {
		t.Fatalf("unexpired lease %+v", row)
	}
	assertHeadMatchesSum(t, ctx, pool, 93011, "listing.submit")
	assertHeadMatchesSum(t, ctx, pool, 93012, "listing.submit")
}

func idsOf(claimed []queuecontract.Claimed) []string {
	out := make([]string, len(claimed))
	for i, job := range claimed {
		out[i] = job.ID.String()
	}
	return out
}

func testQueueHeadCounters(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	if err := purgeParityFixtures(ctx, pool); err != nil {
		t.Fatal(err)
	}
	org := seedTenant(t, ctx, pool, 93014)
	cloud := jobInput(org, 93014, "listing.submit", "counter", `{}`)
	if _, err := queuerepo.Enqueue(ctx, pool, []queuecontract.NewJob{cloud}, 256); err != nil {
		t.Fatal(err)
	}
	assertHeadMatchesSum(t, ctx, pool, 93014, "listing.submit")
	if q, _, present := headCosts(t, ctx, pool, 93014, "listing.submit"); !present || q != 4 {
		t.Fatalf("queued cost %d present %v", q, present)
	}
	browser := jobInput(org, 93014, "media.render", "counter-browser", `{"executor":"browser"}`)
	if _, err := queuerepo.Enqueue(ctx, pool, []queuecontract.NewJob{browser}, 256); err != nil {
		t.Fatal(err)
	}
	assertHeadMatchesSum(t, ctx, pool, 93014, "media.render")
	if _, _, present := headCosts(t, ctx, pool, 93014, "media.render"); present {
		t.Fatal("browser media must not occupy the head")
	}
	claimed, err := queuerepo.Claim(ctx, pool, "listing.submit", "counter", 2)
	if err != nil || len(claimed) != 1 {
		t.Fatalf("claim %+v %v", claimed, err)
	}
	assertHeadMatchesSum(t, ctx, pool, 93014, "listing.submit")
	if q, r, _ := headCosts(t, ctx, pool, 93014, "listing.submit"); q != 0 || r != 4 {
		t.Fatalf("after claim queued %d running %d", q, r)
	}
	if _, err := queuerepo.RequeueJob(ctx, pool, claimed[0].Lease(), queuedomain.ReasonStoreBusy, 0); err != nil {
		t.Fatal(err)
	}
	assertHeadMatchesSum(t, ctx, pool, 93014, "listing.submit")
	if q, r, _ := headCosts(t, ctx, pool, 93014, "listing.submit"); q != 4 || r != 0 {
		t.Fatalf("retry_wait must count as queued, got %d/%d", q, r)
	}
	// run_at is in the future after requeue. Pull it due and claim again.
	if _, err := pool.Exec(ctx, `UPDATE jobs SET run_at = clock_timestamp() WHERE id = $1`, cloud.ID); err != nil {
		t.Fatal(err)
	}
	claimed, err = queuerepo.Claim(ctx, pool, "listing.submit", "counter", 2)
	if err != nil || len(claimed) != 1 {
		t.Fatalf("reclaim %+v %v", claimed, err)
	}
	if ok, err := queuerepo.Settle(ctx, pool, claimed[0].Lease(), "succeeded", []byte(`{"ok":true}`)); err != nil || !ok {
		t.Fatalf("settle %v %v", ok, err)
	}
	row := readJob(t, ctx, pool, cloud.ID)
	if row.state != "succeeded" || row.owner != nil || row.until != nil || row.attempt != claimed[0].Attempt {
		t.Fatalf("settled %+v", row)
	}
	assertHeadMatchesSum(t, ctx, pool, 93014, "listing.submit")
	var permits int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM execution_permits
		 WHERE holder_id = $1 AND released_at IS NULL`, cloud.ID.String()).Scan(&permits); err != nil || permits != 0 {
		t.Fatalf("permit still live %d %v", permits, err)
	}
}

func testQuotaFunctions(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	if err := purgeParityFixtures(ctx, pool); err != nil {
		t.Fatal(err)
	}
	org := seedTenant(t, ctx, pool, 93021)
	if _, err := pool.Exec(ctx, `SELECT public.register_execution_demand('all_execution', 0)`); err == nil {
		t.Fatal("register_execution_demand must reject user 0")
	}
	if _, err := pool.Exec(ctx, `SELECT public.register_execution_demand('all_execution', $1)`, 93021); err != nil {
		t.Fatal(err)
	}
	var demand int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM execution_fairness WHERE class = 'all_execution' AND user_id = 93021`).Scan(&demand); err != nil || demand != 1 {
		t.Fatalf("demand row %d %v", demand, err)
	}
	// release_execution_permit casts a job holder id to uuid. Non-uuid ids error.
	holderA := uuid.NewString()
	holderB := uuid.NewString()
	holderC := uuid.NewString()
	var granted bool
	if err := pool.QueryRow(ctx, `
		SELECT public.try_grant_execution_permit(
			ARRAY['all_execution'], $1, 93099, 'job', $2, 1, clock_timestamp() + interval '30 seconds')`,
		org, uuid.NewString()).Scan(&granted); err != nil || granted {
		t.Fatalf("non-member grant %v %v", granted, err)
	}
	if err := pool.QueryRow(ctx, `
		SELECT public.try_grant_execution_permit(
			ARRAY['all_execution'], $1, 93021, 'job', $2, 1, clock_timestamp() + interval '30 seconds')`,
		org, holderA).Scan(&granted); err != nil || !granted {
		t.Fatalf("grant %v %v", granted, err)
	}
	var used int64
	if err := pool.QueryRow(ctx, `SELECT used FROM execution_quota WHERE class = 'all_execution' AND user_id = 93021`).Scan(&used); err != nil || used != 1 {
		t.Fatalf("used %d %v", used, err)
	}
	if err := pool.QueryRow(ctx, `
		SELECT public.try_grant_execution_permit(
			ARRAY['all_execution'], $1, 93021, 'job', $2, 1, clock_timestamp() + interval '30 seconds')`,
		org, holderA).Scan(&granted); err != nil || !granted {
		t.Fatalf("same fence must not insert again: %v %v", granted, err)
	}
	if err := pool.QueryRow(ctx, `SELECT used FROM execution_quota WHERE class = 'all_execution' AND user_id = 93021`).Scan(&used); err != nil || used != 1 {
		t.Fatalf("replay used %d", used)
	}
	if _, err := pool.Exec(ctx, `UPDATE execution_quota SET hard_limit = 2 WHERE class = 'all_execution' AND user_id = 93021`); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		SELECT public.try_grant_execution_permit(
			ARRAY['all_execution'], $1, 93021, 'job', $2, 1, clock_timestamp() + interval '30 seconds')`,
		org, holderB).Scan(&granted); err != nil || !granted {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		SELECT public.try_grant_execution_permit(
			ARRAY['all_execution'], $1, 93021, 'job', $2, 1, clock_timestamp() + interval '30 seconds')`,
		org, holderC).Scan(&granted); err != nil || granted {
		t.Fatalf("over cap granted %v", granted)
	}
	if err := pool.QueryRow(ctx, `SELECT used FROM execution_quota WHERE class = 'all_execution' AND user_id = 93021`).Scan(&used); err != nil || used != 2 {
		t.Fatalf("used at cap %d", used)
	}
	var released bool
	if err := pool.QueryRow(ctx, `SELECT public.release_execution_permit('job', $1, 1)`, holderB).Scan(&released); err != nil || !released {
		t.Fatalf("release %v %v", released, err)
	}
	if err := pool.QueryRow(ctx, `SELECT public.release_execution_permit('job', $1, 1)`, holderB).Scan(&released); err != nil || released {
		t.Fatal("second release must be false")
	}
	if err := pool.QueryRow(ctx, `SELECT used FROM execution_quota WHERE class = 'all_execution' AND user_id = 93021`).Scan(&used); err != nil || used != 1 {
		t.Fatalf("used after release %d", used)
	}

	if _, err := pool.Exec(ctx, `
		UPDATE execution_quota SET hard_limit = 3, used = (
			SELECT count(*) FROM execution_permits
			 WHERE class = 'all_execution' AND user_id = 93021 AND released_at IS NULL
		) WHERE class = 'all_execution' AND user_id = 93021`); err != nil {
		t.Fatal(err)
	}
	var liveBefore int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM execution_permits
		 WHERE class = 'all_execution' AND user_id = 93021 AND released_at IS NULL`).Scan(&liveBefore); err != nil {
		t.Fatal(err)
	}
	const burst = 20
	var wg sync.WaitGroup
	var mu sync.Mutex
	okN := 0
	wg.Add(burst)
	for i := 0; i < burst; i++ {
		go func(i int) {
			defer wg.Done()
			var ok bool
			err := pool.QueryRow(ctx, `
				SELECT public.try_grant_execution_permit(
					ARRAY['all_execution'], $1, 93021, 'job', $2, 7, clock_timestamp() + interval '30 seconds')`,
				org, uuid.NewString()).Scan(&ok)
			if err != nil {
				t.Error(err)
				return
			}
			if ok {
				mu.Lock()
				okN++
				mu.Unlock()
			}
		}(i)
	}
	wg.Wait()
	var live int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM execution_permits
		 WHERE class = 'all_execution' AND user_id = 93021 AND released_at IS NULL`).Scan(&live); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT used FROM execution_quota WHERE class = 'all_execution' AND user_id = 93021`).Scan(&used); err != nil {
		t.Fatal(err)
	}
	if live > 3 || used > 3 || okN > 3-liveBefore {
		t.Fatalf("cap exceeded live %d used %d new grants %d already %d", live, used, okN, liveBefore)
	}
	if live != 3 || used != 3 {
		t.Fatalf("cap not filled live %d used %d grants %d", live, used, okN)
	}

	var reaped int64
	if err := pool.QueryRow(ctx, `SELECT public.reap_stale_execution_permits(64)`).Scan(&reaped); err != nil {
		t.Fatal(err)
	}
	if reaped < 1 {
		t.Fatalf("reap %d", reaped)
	}
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM execution_permits
		 WHERE class = 'all_execution' AND user_id = 93021 AND released_at IS NULL`).Scan(&live); err != nil || live != 0 {
		t.Fatalf("permits after reap %d %v", live, err)
	}
}

func testClaimFairness(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	if err := purgeParityFixtures(ctx, pool); err != nil {
		t.Fatal(err)
	}
	orgA := seedTenant(t, ctx, pool, 93031)
	orgB := seedTenant(t, ctx, pool, 93032)
	var batch []queuecontract.NewJob
	for i := 0; i < 6; i++ {
		batch = append(batch, jobInput(orgA, 93031, "store.product_sync", fmt.Sprintf("a-%d", i), `{}`))
		batch = append(batch, jobInput(orgB, 93032, "store.product_sync", fmt.Sprintf("b-%d", i), `{}`))
	}
	if _, err := queuerepo.Enqueue(ctx, pool, batch, 256); err != nil {
		t.Fatal(err)
	}
	claimed, err := queuerepo.Claim(ctx, pool, "store.product_sync", "fair", 4)
	if err != nil {
		t.Fatal(err)
	}
	per := map[int64]int{}
	for _, job := range claimed {
		per[job.SubmitterUserID]++
	}
	if len(claimed) != 4 || per[93031] != 2 || per[93032] != 2 {
		t.Fatalf("one batch %+v", per)
	}
	var wg sync.WaitGroup
	wg.Add(4)
	for i := 0; i < 4; i++ {
		go func(i int) {
			defer wg.Done()
			if _, err := queuerepo.Claim(ctx, pool, "store.product_sync", fmt.Sprintf("fair-%d", i), 2); err != nil {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	for _, user := range []int64{93031, 93032} {
		var running, queued int
		if err := pool.QueryRow(ctx, `
			SELECT count(*) FILTER (WHERE state = 'running'),
			       count(*) FILTER (WHERE state IN ('queued', 'retry_wait'))
			  FROM jobs WHERE submitter_user_id = $1 AND kind = 'store.product_sync'`, user).Scan(&running, &queued); err != nil {
			t.Fatal(err)
		}
		if running != 6 || queued != 0 {
			t.Fatalf("user %d running %d queued %d", user, running, queued)
		}
		var used int64
		if err := pool.QueryRow(ctx, `SELECT used FROM execution_quota WHERE class = 'all_execution' AND user_id = $1`, user).Scan(&used); err != nil {
			t.Fatal(err)
		}
		if used != 6 {
			t.Fatalf("user %d permits %d", user, used)
		}
		assertHeadMatchesSum(t, ctx, pool, user, "store.product_sync")
	}

	if err := purgeParityFixtures(ctx, pool); err != nil {
		t.Fatal(err)
	}
	var globalLimit int64
	if err := pool.QueryRow(ctx, `SELECT hard_limit FROM execution_quota WHERE class = 'all_execution' AND user_id = 0`).Scan(&globalLimit); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE execution_quota SET hard_limit = 400 WHERE class = 'all_execution' AND user_id = 0`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `UPDATE execution_quota SET hard_limit = $1 WHERE class = 'all_execution' AND user_id = 0`, globalLimit)
	})
	const heads = 129
	batch = nil
	for i := 0; i < heads; i++ {
		user := int64(94100 + i)
		org := seedTenant(t, ctx, pool, user)
		batch = append(batch, jobInput(org, user, "delegate.posting_sync", fmt.Sprintf("h-%d", i), `{}`))
	}
	if _, err := queuerepo.Enqueue(ctx, pool, batch, 256); err != nil {
		t.Fatal(err)
	}
	claimed, err = queuerepo.Claim(ctx, pool, "delegate.posting_sync", "heads", 1000)
	if err != nil {
		t.Fatal(err)
	}
	if len(claimed) != int(queuedomain.ClaimHeadLimit) {
		t.Fatalf("head limit claimed %d", len(claimed))
	}
	left := readJob(t, ctx, pool, batch[len(batch)-1].ID)
	if left.state != "queued" {
		t.Fatalf("highest user must stay queued, %+v", left)
	}
	var cursor int64
	if err := pool.QueryRow(ctx, `SELECT last_user_id FROM account_queue_cursor WHERE lane = 'delegate.posting_sync'`).Scan(&cursor); err != nil {
		t.Fatal(err)
	}
	if cursor != 94100+int64(queuedomain.ClaimHeadLimit)-1 {
		t.Fatalf("cursor %d", cursor)
	}
	var permits int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM execution_permits
		 WHERE class = 'all_execution' AND released_at IS NULL AND user_id BETWEEN 94100 AND 94228`).Scan(&permits); err != nil {
		t.Fatal(err)
	}
	if permits != int(queuedomain.ClaimHeadLimit) {
		t.Fatalf("permits %d", permits)
	}
}

func testClaimLockOrder(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	if err := purgeParityFixtures(ctx, pool); err != nil {
		t.Fatal(err)
	}
	org := seedTenant(t, ctx, pool, 93041)
	job := jobInput(org, 93041, "listing.submit", "lock", `{}`)
	if _, err := queuerepo.Enqueue(ctx, pool, []queuecontract.NewJob{job}, 256); err != nil {
		t.Fatal(err)
	}
	holder, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Release()
	tx, err := holder.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `
		INSERT INTO account_queue_head(user_id, lane) VALUES (93041, 'listing.submit')
		ON CONFLICT (user_id, lane) DO UPDATE SET lane = EXCLUDED.lane`); err != nil {
		t.Fatal(err)
	}
	finished := make(chan error, 1)
	go func() {
		_, err := queuerepo.Claim(ctx, pool, "listing.submit", "lock-order", 1)
		finished <- err
	}()
	deadline := time.Now().Add(3 * time.Second)
	for {
		var waiting int
		if err := pool.QueryRow(ctx, `
			SELECT count(*) FROM pg_stat_activity
			 WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock'
			   AND query LIKE '%account_queue_head%'`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting >= 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("claim did not block on account_queue_head")
		}
		time.Sleep(20 * time.Millisecond)
	}
	quota, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer quota.Release()
	qtx, err := quota.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer qtx.Rollback(ctx)
	if _, err := qtx.Exec(ctx, `SET LOCAL lock_timeout = '500ms'`); err != nil {
		t.Fatal(err)
	}
	if _, err := qtx.Exec(ctx, `
		INSERT INTO execution_quota(class, user_id, hard_limit) VALUES ('all_execution', 93041, 1)
		ON CONFLICT (class, user_id) DO UPDATE SET class = EXCLUDED.class`); err != nil {
		t.Fatalf("quota must stay free while claim waits on the head: %v", err)
	}
	// Drop the quota lock before the head lock. The claim takes the head
	// first and the quota second; holding the quota until the claim returns
	// deadlocks that order.
	if err := qtx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
}

func testReconcilerSeat(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	first, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	ok, err := queueservice.TrySeat(ctx, first)
	if err != nil || !ok {
		t.Fatalf("seat %v %v", ok, err)
	}
	second, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Release()
	ok, err = queueservice.TrySeat(ctx, second)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("second reconciler took the seat")
	}
	raw := first.Hijack()
	if err := raw.Close(ctx); err != nil {
		t.Fatal(err)
	}
	// The lock is session-scoped. Close returns when the client socket
	// finishes; the backend can still hold it until that process exits.
	// Wait for the release. The seat must still be taken, and an error
	// still fails the test.
	deadline := time.Now().Add(5 * time.Second)
	for {
		ok, err = queueservice.TrySeat(ctx, second)
		if err != nil || ok || time.Now().After(deadline) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err != nil || !ok {
		t.Fatalf("seat after crash %v %v", ok, err)
	}
	if _, err := second.Exec(ctx, `SELECT pg_advisory_unlock($1)`, queuedomain.ReconcilerAdvisoryLock); err != nil {
		t.Fatal(err)
	}
}
