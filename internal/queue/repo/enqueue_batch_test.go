package queuerepo

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go/modules/postgres"

	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/tests/testkit"
)

func TestEnqueueBatchMatchesSequential(t *testing.T) {
	pool, ctx := parityDB(t)
	org, users := seedOrgs(t, ctx, pool, 96111, 96112)
	clearQueue(context.Background(), pool, users)
	t.Cleanup(func() { purgeUsers(context.Background(), pool, users) })
	when := time.Date(2026, 10, 17, 3, 4, 5, 0, time.UTC)

	cloud := func(user int64, kind, key, payload string) NewJob {
		job := makeJob(org[user], user, kind, key, payload)
		job.RunAt = when
		job.CreatedAt = when
		job.Priority = 50
		job.MaxAttempts = 8
		return job
	}

	t.Run("mixed heads browser and duplicate key", func(t *testing.T) {
		dup := cloud(96111, "listing.submit", "dup", `{"n":1}`)
		again := dup
		again.ID = uuid.New()
		again.Payload = []byte(`{"n":2}`)
		jobs := []NewJob{
			cloud(96111, "media.render", "browser-first", `{"executor":"browser"}`),
			cloud(96111, "media.render", "cloud-after", `{}`),
			cloud(96112, "media.upload", "browser-upload", `{"executor":"browser"}`),
			cloud(96112, "listing.submit", "cloud-then", `{"executor":"cloud"}`),
			cloud(96112, "media.render", "cloud-before-browser", `{}`),
			cloud(96112, "media.render", "browser-after", `{"executor":"browser"}`),
			dup,
			again,
		}
		compareEnqueue(t, ctx, pool, users, jobs, 256)
	})

	t.Run("same batch duplicate does not fail when the lane fills", func(t *testing.T) {
		first := cloud(96111, "ai.recognize", "same", `{"keep":1}`)
		second := first
		second.ID = uuid.New()
		second.Payload = []byte(`{"keep":2}`)
		left, right := compareEnqueue(t, ctx, pool, users, []NewJob{first, second}, 8)
		if !left[0].Inserted || left[1].Inserted || left[1].ID != left[0].ID {
			t.Fatalf("sequential duplicate %+v", left)
		}
		if !right[0].Inserted || right[1].Inserted || right[1].ID != right[0].ID {
			t.Fatalf("batch duplicate %+v", right)
		}
		if jsonEqual(right[1].Payload, []byte(`{"keep":2}`)) {
			t.Fatal("conflict kept the second payload")
		}
	})

	t.Run("replay of a full lane returns the first row", func(t *testing.T) {
		seed := cloud(96111, "ai.recognize", "full-replay", `{"n":1}`)
		if _, err := Enqueue(ctx, pool, []NewJob{seed}, 8); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { clearQueue(context.Background(), pool, users) })
		replay := seed
		replay.ID = uuid.New()
		replay.Payload = []byte(`{"n":9}`)
		seq, bat := compareEnqueue(t, ctx, pool, users, []NewJob{replay}, 8)
		if seq[0].Inserted || seq[0].ID != seed.ID || bat[0].ID != seed.ID {
			t.Fatalf("replay seq %+v bat %+v", seq[0], bat[0])
		}
		var payload string
		if err := pool.QueryRow(ctx, `SELECT payload::text FROM jobs WHERE id = $1`, seed.ID).Scan(&payload); err != nil {
			t.Fatal(err)
		}
		if !jsonEqual([]byte(payload), []byte(`{"n":1}`)) {
			t.Fatalf("payload %s", payload)
		}
	})

	t.Run("third job fills the lane and leaves nothing", func(t *testing.T) {
		clearQueue(context.Background(), pool, users)
		jobs := []NewJob{
			cloud(96111, "ai.recognize", "cap-1", `{}`),
			cloud(96111, "ai.recognize", "cap-2", `{}`),
			cloud(96111, "ai.recognize", "cap-3", `{}`),
		}
		seqErr := runExpectErr(t, ctx, pool, enqueueOnSequential, jobs, 16)
		batErr := runExpectErr(t, ctx, pool, EnqueueOn, jobs, 16)
		if !errors.Is(seqErr, ErrLaneFull) || !errors.Is(batErr, ErrLaneFull) {
			t.Fatalf("seq %v bat %v", seqErr, batErr)
		}
		if n := countJobs(t, ctx, pool, users); n != 0 {
			t.Fatalf("residue jobs %d", n)
		}
		if n := countHeads(t, ctx, pool, users); n != 0 {
			t.Fatalf("residue heads %d", n)
		}
		if _, err := Enqueue(ctx, pool, jobs, 16); !errors.Is(err, ErrLaneFull) {
			t.Fatal(err)
		}
		if n := countJobs(t, ctx, pool, users); n != 0 {
			t.Fatalf("enqueue residue %d", n)
		}
		one := jobs[0]
		one.IdempotencyKey = "cap-ok"
		one.ID = uuid.New()
		if _, err := Enqueue(ctx, pool, []NewJob{one}, 16); err != nil {
			t.Fatal(err)
		}
		clearQueue(context.Background(), pool, users)
	})

	t.Run("empty batch sends nothing", func(t *testing.T) {
		tr, traced := tracedPool(t, ctx)
		tr.sql = nil
		tr.batches = 0
		if got, err := Enqueue(ctx, traced, nil, 256); err != nil || got != nil {
			t.Fatalf("%+v %v", got, err)
		}
		if got, err := Enqueue(ctx, traced, []NewJob{}, 256); err != nil || got != nil {
			t.Fatalf("empty %+v %v", got, err)
		}
		bad := cloud(96111, "listing.submit", "nope", `{}`)
		bad.SubmitterUserID = 0
		if _, err := Enqueue(ctx, traced, []NewJob{bad}, 256); !errors.Is(err, ErrSubmitter) {
			t.Fatal(err)
		}
		if len(tr.sql) != 0 || tr.batches != 0 {
			t.Fatalf("statements %d batches %d", len(tr.sql), tr.batches)
		}
	})

	t.Run("whole batch replay", func(t *testing.T) {
		clearQueue(context.Background(), pool, users)
		a := cloud(96111, "listing.submit", "all-1", `{"a":1}`)
		b := cloud(96112, "store.product_sync", "all-2", `{"b":1}`)
		if _, err := Enqueue(ctx, pool, []NewJob{a, b}, 256); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { clearQueue(context.Background(), pool, users) })
		ra, rb := a, b
		ra.ID, rb.ID = uuid.New(), uuid.New()
		ra.Payload, rb.Payload = []byte(`{"a":2}`), []byte(`{"b":2}`)
		seq, bat := compareEnqueue(t, ctx, pool, users, []NewJob{ra, rb}, 256)
		if seq[0].Inserted || seq[1].Inserted || seq[0].ID != a.ID || seq[1].ID != b.ID {
			t.Fatalf("seq %+v", seq)
		}
		if bat[0].ID != a.ID || bat[1].ID != b.ID || bat[0].Inserted || bat[1].Inserted {
			t.Fatalf("bat %+v", bat)
		}
	})
}

func TestEnqueueBatchStatementOrder(t *testing.T) {
	pool, ctx := parityDB(t)
	org, users := seedOrgs(t, ctx, pool, 96121, 96122)
	t.Cleanup(func() { purgeUsers(context.Background(), pool, users) })
	when := time.Date(2026, 10, 17, 3, 4, 5, 0, time.UTC)
	mk := func(user int64, kind, key, payload string) NewJob {
		job := makeJob(org[user], user, kind, key, payload)
		job.RunAt = when
		job.CreatedAt = when
		return job
	}
	jobs := []NewJob{
		mk(96122, "listing.submit", "k1", `{}`),
		mk(96121, "media.render", "k2", `{"executor":"browser"}`),
		mk(96121, "listing.submit", "k3", `{}`),
		mk(96122, "ai.recognize", "k4", `{}`),
	}
	tr, traced := tracedPool(t, ctx)
	tx, err := traced.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if err := tenant.EnterWorker(ctx, tx); err != nil {
		t.Fatal(err)
	}
	tr.sql = nil
	tr.args = nil
	tr.batches = 0
	if _, err := EnqueueOn(ctx, tx, jobs, 256); err != nil {
		t.Fatal(err)
	}
	if tr.batches != 2 {
		t.Fatalf("batches %d\n%s", tr.batches, tr.sql)
	}
	headIdx := -1
	for i, sql := range tr.sql {
		if contains(sql, "INSERT INTO public.account_queue_head") {
			headIdx = i
			break
		}
	}
	if headIdx < 0 {
		t.Fatalf("no head upsert\n%v", tr.sql)
	}
	head := tr.sql[headIdx]
	if !contains(head, "($1, $2), ($3, $4), ($5, $6), ($7, $8)") {
		t.Fatalf("head sql %s", head)
	}
	if fmt.Sprint(tr.args[headIdx]) != "[96122 ai.recognize 96121 listing.submit 96122 listing.submit 96121 media.render]" {
		t.Fatalf("head args %v", tr.args[headIdx])
	}
	var locks []string
	for i, sql := range tr.sql {
		if contains(sql, "eq-user:") {
			locks = append(locks, fmt.Sprint(tr.args[i]))
		}
	}
	wantLocks := []string{"[ai_ocr 96121]", "[ai_ocr 96122]", "[all_execution 96121]", "[all_execution 96122]"}
	if !reflect.DeepEqual(locks, wantLocks) {
		t.Fatalf("locks %v", locks)
	}
	var inserts int
	for _, sql := range tr.sql {
		if contains(sql, "INSERT INTO public.jobs") {
			inserts++
			if contains(sql, "VALUES ($1") && contains(sql, ", ($") {
				t.Fatal("jobs insert must stay one row per statement")
			}
		}
	}
	if inserts != len(jobs) {
		t.Fatalf("job inserts %d", inserts)
	}
	// 1 head + 4 quotas * 3 locks + 3 counting*(exists+admit+insert)
	// + 1 browser*(exists+insert+delete) + reset
	if len(tr.sql) != 1+12+3*3+3+1 {
		t.Fatalf("statements %d\n%v", len(tr.sql), tr.sql)
	}
}

func TestEnqueueBatchClaimStillSkipsBrowser(t *testing.T) {
	pool, ctx := parityDB(t)
	org, users := seedOrgs(t, ctx, pool, 96131)
	t.Cleanup(func() { purgeUsers(context.Background(), pool, users) })
	browser := makeJob(org[96131], 96131, "media.render", "br", `{"executor":"browser"}`)
	cloud := makeJob(org[96131], 96131, "listing.submit", "cl", `{}`)
	if _, err := Enqueue(ctx, pool, []NewJob{browser, cloud}, 256); err != nil {
		t.Fatal(err)
	}
	if n := countHeads(t, ctx, pool, []int64{96131}); n != 1 {
		t.Fatalf("heads %d", n)
	}
	var lane string
	var queued int64
	if err := pool.QueryRow(ctx, `
		SELECT lane, queued_cost FROM account_queue_head WHERE user_id = $1`, 96131).Scan(&lane, &queued); err != nil {
		t.Fatal(err)
	}
	if lane != "listing.submit" || queued != 4 {
		t.Fatalf("head %s %d", lane, queued)
	}
	claimed, err := Claim(ctx, pool, "media.render", "batch-test", 2)
	if err != nil || len(claimed) != 0 {
		t.Fatalf("browser claim %+v %v", claimed, err)
	}
	claimed, err = Claim(ctx, pool, "listing.submit", "batch-test", 2)
	if err != nil || len(claimed) != 1 || claimed[0].ID != cloud.ID {
		t.Fatalf("claim %+v %v", claimed, err)
	}
}

func BenchmarkEnqueueBatch(b *testing.B) {
	benchEnqueue(b, EnqueueOn)
}

func BenchmarkEnqueueSequential(b *testing.B) {
	benchEnqueue(b, enqueueOnSequential)
}

func benchEnqueue(b *testing.B, fn func(context.Context, pgx.Tx, []NewJob, int64) ([]Queued, error)) {
	pool, ctx := parityDB(b)
	org, users := seedOrgs(b, ctx, pool, 96141)
	b.Cleanup(func() { purgeUsers(context.Background(), pool, users) })
	when := time.Date(2026, 10, 17, 3, 4, 5, 0, time.UTC)
	jobs := make([]NewJob, 32)
	for i := range jobs {
		jobs[i] = makeJob(org[96141], 96141, "listing.submit", fmt.Sprintf("bench-%d", i), `{}`)
		jobs[i].RunAt = when
		jobs[i].CreatedAt = when
		jobs[i].ID = uuid.New()
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		tx, err := pool.Begin(ctx)
		if err != nil {
			b.Fatal(err)
		}
		if err := tenant.EnterWorker(ctx, tx); err != nil {
			tx.Rollback(ctx)
			b.Fatal(err)
		}
		if _, err := fn(ctx, tx, jobs, 256); err != nil {
			tx.Rollback(ctx)
			b.Fatal(err)
		}
		if err := tx.Rollback(ctx); err != nil {
			b.Fatal(err)
		}
	}
}

func compareEnqueue(t *testing.T, ctx context.Context, pool *pgxpool.Pool, users []int64, jobs []NewJob, limit int64) (seq, bat []Queued) {
	t.Helper()
	seq, seqJobs, seqHeads, seqQuota, seqErr := runEnqueue(t, ctx, pool, users, enqueueOnSequential, jobs, limit)
	bat, batJobs, batHeads, batQuota, batErr := runEnqueue(t, ctx, pool, users, EnqueueOn, jobs, limit)
	if (seqErr == nil) != (batErr == nil) || !errors.Is(seqErr, ErrLaneFull) && seqErr != nil || !errors.Is(batErr, ErrLaneFull) && batErr != nil {
		if !sameErr(seqErr, batErr) {
			t.Fatalf("seq %v bat %v", seqErr, batErr)
		}
	}
	if seqErr != nil {
		return seq, bat
	}
	if len(seq) != len(bat) {
		t.Fatalf("len %d %d", len(seq), len(bat))
	}
	for i := range seq {
		if seq[i].ID != bat[i].ID || seq[i].State != bat[i].State || seq[i].Attempt != bat[i].Attempt || seq[i].Epoch != bat[i].Epoch || seq[i].Inserted != bat[i].Inserted || !jsonEqual(seq[i].Payload, bat[i].Payload) {
			t.Fatalf("queued[%d]\nseq %+v %s\nbat %+v %s", i, seq[i], seq[i].Payload, bat[i], bat[i].Payload)
		}
	}
	if !reflect.DeepEqual(seqJobs, batJobs) || !reflect.DeepEqual(seqHeads, batHeads) || !reflect.DeepEqual(seqQuota, batQuota) {
		t.Fatalf("jobs\n%+v\n%+v\nheads\n%+v\n%+v\nquota\n%+v\n%+v", seqJobs, batJobs, seqHeads, batHeads, seqQuota, batQuota)
	}
	return seq, bat
}

func sameErr(a, b error) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return errors.Is(a, b) || a.Error() == b.Error()
}

func runExpectErr(t *testing.T, ctx context.Context, pool *pgxpool.Pool, fn func(context.Context, pgx.Tx, []NewJob, int64) ([]Queued, error), jobs []NewJob, limit int64) error {
	t.Helper()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if err := tenant.EnterWorker(ctx, tx); err != nil {
		t.Fatal(err)
	}
	_, err = fn(ctx, tx, jobs, limit)
	if err == nil {
		t.Fatal("expected lane full")
	}
	return err
}

func runEnqueue(t *testing.T, ctx context.Context, pool *pgxpool.Pool, users []int64, fn func(context.Context, pgx.Tx, []NewJob, int64) ([]Queued, error), jobs []NewJob, limit int64) ([]Queued, []jobSnap, []headSnap, []quotaSnap, error) {
	t.Helper()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if err := tenant.EnterWorker(ctx, tx); err != nil {
		t.Fatal(err)
	}
	out, err := fn(ctx, tx, jobs, limit)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	return out, snapJobs(t, ctx, tx, users), snapHeads(t, ctx, tx, users), snapQuota(t, ctx, tx, users), nil
}

type jobSnap struct {
	ID, Kind, AggType, AggID, Key, State, Payload, Lane string
	Org, User, Rev, Epoch                               int64
	Priority                                            int16
	Attempt, Max, Cost                                  int32
	RunAt                                               time.Time
}

type headSnap struct {
	User, Queued, Running int64
	Lane                  string
}

type quotaSnap struct {
	Class      string
	User       int64
	Hard, Used int64
}

func snapJobs(t *testing.T, ctx context.Context, tx pgx.Tx, users []int64) []jobSnap {
	t.Helper()
	rows, err := tx.Query(ctx, `
		SELECT id::text, org_id, kind, aggregate_type, aggregate_id::text, input_revision,
		       idempotency_key, priority, state, run_at, attempt, max_attempts,
		       payload::text, submitter_user_id, cost_units, lane, lease_epoch
		  FROM public.jobs
		 WHERE submitter_user_id = ANY($1)
		 ORDER BY kind, idempotency_key, id`, users)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []jobSnap
	for rows.Next() {
		var row jobSnap
		if err := rows.Scan(&row.ID, &row.Org, &row.Kind, &row.AggType, &row.AggID, &row.Rev, &row.Key, &row.Priority, &row.State, &row.RunAt, &row.Attempt, &row.Max, &row.Payload, &row.User, &row.Cost, &row.Lane, &row.Epoch); err != nil {
			t.Fatal(err)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func snapHeads(t *testing.T, ctx context.Context, tx pgx.Tx, users []int64) []headSnap {
	t.Helper()
	rows, err := tx.Query(ctx, `
		SELECT user_id, lane, queued_cost, running_cost
		  FROM public.account_queue_head
		 WHERE user_id = ANY($1)
		 ORDER BY lane, user_id`, users)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []headSnap
	for rows.Next() {
		var row headSnap
		if err := rows.Scan(&row.User, &row.Lane, &row.Queued, &row.Running); err != nil {
			t.Fatal(err)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func snapQuota(t *testing.T, ctx context.Context, tx pgx.Tx, users []int64) []quotaSnap {
	t.Helper()
	rows, err := tx.Query(ctx, `
		SELECT class, user_id, hard_limit, used
		  FROM public.execution_quota
		 WHERE user_id = ANY($1)
		 ORDER BY class, user_id`, users)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []quotaSnap
	for rows.Next() {
		var row quotaSnap
		if err := rows.Scan(&row.Class, &row.User, &row.Hard, &row.Used); err != nil {
			t.Fatal(err)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func countJobs(t *testing.T, ctx context.Context, pool *pgxpool.Pool, users []int64) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM jobs WHERE submitter_user_id = ANY($1)`, users).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func countHeads(t *testing.T, ctx context.Context, pool *pgxpool.Pool, users []int64) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM account_queue_head WHERE user_id = ANY($1)`, users).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func makeJob(org, user int64, kind, key, payload string) NewJob {
	if payload == "" {
		payload = `{}`
	}
	return NewJob{
		ID: uuid.New(), OrgID: org, Kind: kind, AggregateType: "listing_row",
		AggregateID: uuid.New(), InputRevision: 1, IdempotencyKey: key,
		Payload: []byte(payload), SubmitterUserID: user,
	}
}

func jsonEqual(a, b []byte) bool {
	var x, y any
	if err := json.Unmarshal(a, &x); err != nil {
		return false
	}
	if err := json.Unmarshal(b, &y); err != nil {
		return false
	}
	return reflect.DeepEqual(x, y)
}

func contains(s, part string) bool {
	return strings.Contains(s, part)
}

// enqueueOnSequential is the pre-batch enqueue loop. The batch path must
// return the same rows.
func enqueueOnSequential(ctx context.Context, tx pgx.Tx, jobs []NewJob, laneLimit int64) ([]Queued, error) {
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
	if err := lockHeadsSequential(ctx, tx, keys, permitClasses(jobs)); err != nil {
		return nil, err
	}
	out := make([]Queued, 0, len(jobs))
	for _, job := range jobs {
		executor := payloadExecutor(job.Payload)
		var replay bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (
				SELECT 1 FROM public.jobs
				 WHERE org_id = $1 AND kind = $2 AND idempotency_key = $3)`,
			job.OrgID, job.Kind, job.IdempotencyKey).Scan(&replay); err != nil {
			return nil, err
		}
		if !replay {
			if err := admit(ctx, tx, job.SubmitterUserID, job.Kind, executor, laneLimit); err != nil {
				return nil, err
			}
		}
		row, err := insertJob(ctx, tx, job)
		if err != nil {
			return nil, err
		}
		out = append(out, row)
		if !replay && !CountsTowardHead(job.Kind, executor) {
			if err := dropEmptyHead(ctx, tx, job.SubmitterUserID, job.Kind); err != nil {
				return nil, err
			}
		}
	}
	return out, nil
}

func lockHeadsSequential(ctx context.Context, tx pgx.Tx, keys []headKey, classes []string) error {
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
	for _, key := range ordered {
		if _, err := tx.Exec(ctx, `
			INSERT INTO public.account_queue_head(user_id, lane)
			VALUES ($1, $2)
			ON CONFLICT (user_id, lane) DO UPDATE SET lane = public.account_queue_head.lane`,
			key.User, key.Lane); err != nil {
			return err
		}
	}
	classes = append([]string(nil), classes...)
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
	for _, q := range quotas {
		if err := lockQuota(ctx, tx, q.class, q.user); err != nil {
			return err
		}
	}
	return nil
}

func seedOrgs(tb testing.TB, ctx context.Context, pool *pgxpool.Pool, ids ...int64) (map[int64]int64, []int64) {
	tb.Helper()
	orgs := map[int64]int64{}
	for _, id := range ids {
		tag := fmt.Sprintf("bq%d", id)
		if _, err := pool.Exec(ctx, `
			INSERT INTO account_users (id, public_id, email, password_hash, role, name, target, supplier_id, plan, created_at, updated_at)
			VALUES ($1, $2, $3, 'x', 'user', 'Batch', '/workspace', '', 'lite', clock_timestamp(), clock_timestamp())
			ON CONFLICT (id) DO NOTHING`,
			id, tag, tag+"@example.invalid"); err != nil {
			tb.Fatal(err)
		}
		var orgID int64
		err := pool.QueryRow(ctx, `SELECT id FROM organizations WHERE owner_user_id = $1`, id).Scan(&orgID)
		if errors.Is(err, pgx.ErrNoRows) {
			if err := pool.QueryRow(ctx, `
				INSERT INTO organizations (owner_user_id, name, plan, created_at, updated_at)
				VALUES ($1, $2, 'lite', clock_timestamp(), clock_timestamp())
				RETURNING id`, id, "org-"+tag).Scan(&orgID); err != nil {
				tb.Fatal(err)
			}
		} else if err != nil {
			tb.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO organization_members (org_id, user_id, role, status, display_name, created_at, updated_at, join_order)
			VALUES ($1, $2, 'owner', 'active', 'Batch', clock_timestamp(), clock_timestamp(), 1)
			ON CONFLICT DO NOTHING`, orgID, id); err != nil {
			tb.Fatal(err)
		}
		orgs[id] = orgID
	}
	return orgs, ids
}

func clearQueue(ctx context.Context, pool *pgxpool.Pool, users []int64) {
	_, _ = pool.Exec(ctx, `DELETE FROM jobs WHERE submitter_user_id = ANY($1)`, users)
	_, _ = pool.Exec(ctx, `DELETE FROM execution_permits WHERE user_id = ANY($1)`, users)
	_, _ = pool.Exec(ctx, `DELETE FROM execution_quota WHERE user_id = ANY($1)`, users)
	_, _ = pool.Exec(ctx, `DELETE FROM execution_fairness WHERE user_id = ANY($1)`, users)
	_, _ = pool.Exec(ctx, `DELETE FROM account_queue_head WHERE user_id = ANY($1)`, users)
}

func purgeUsers(ctx context.Context, pool *pgxpool.Pool, users []int64) {
	_, _ = pool.Exec(ctx, `DELETE FROM jobs WHERE submitter_user_id = ANY($1)`, users)
	_, _ = pool.Exec(ctx, `DELETE FROM execution_permits WHERE user_id = ANY($1)`, users)
	_, _ = pool.Exec(ctx, `DELETE FROM execution_quota WHERE user_id = ANY($1)`, users)
	_, _ = pool.Exec(ctx, `DELETE FROM execution_fairness WHERE user_id = ANY($1)`, users)
	_, _ = pool.Exec(ctx, `DELETE FROM account_queue_head WHERE user_id = ANY($1)`, users)
	_, _ = pool.Exec(ctx, `DELETE FROM organization_members WHERE user_id = ANY($1)`, users)
	_, _ = pool.Exec(ctx, `DELETE FROM organizations WHERE owner_user_id = ANY($1)`, users)
	_, _ = pool.Exec(ctx, `DELETE FROM account_users WHERE id = ANY($1)`, users)
}

type queryTrace struct {
	sql     []string
	args    [][]any
	batches int
}

func (t *queryTrace) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	t.sql = append(t.sql, data.SQL)
	t.args = append(t.args, data.Args)
	return ctx
}

func (t *queryTrace) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func (t *queryTrace) TraceBatchStart(ctx context.Context, _ *pgx.Conn, _ pgx.TraceBatchStartData) context.Context {
	t.batches++
	return ctx
}

func (t *queryTrace) TraceBatchQuery(_ context.Context, _ *pgx.Conn, data pgx.TraceBatchQueryData) {
	t.sql = append(t.sql, data.SQL)
	t.args = append(t.args, data.Args)
}

func (t *queryTrace) TraceBatchEnd(context.Context, *pgx.Conn, pgx.TraceBatchEndData) {}

func tracedPool(t *testing.T, ctx context.Context) (*queryTrace, *pgxpool.Pool) {
	t.Helper()
	if parityURL == "" {
		t.Fatal("parity database was not started")
	}
	tr := &queryTrace{}
	cfg, err := pgxpool.ParseConfig(parityURL)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.Tracer = tr
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return tr, pool
}

var (
	parityOnce sync.Once
	parityPool *pgxpool.Pool
	parityURL  string
	parityErr  error
)

func parityDB(tb testing.TB) (*pgxpool.Pool, context.Context) {
	tb.Helper()
	parityOnce.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		dsn, err := startParityPostgres(ctx)
		if err != nil {
			parityErr = err
			return
		}
		cfg := config.Config{DatabaseURL: dsn}
		if err := cfg.CheckDatabase(); err != nil {
			parityErr = err
			return
		}
		_ = os.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "1")
		pool, err := db.Connect(ctx, cfg)
		if err != nil {
			parityErr = err
			return
		}
		if err := db.Migrate(ctx, pool); err != nil {
			pool.Close()
			parityErr = err
			return
		}
		parityURL = dsn
		parityPool = pool
	})
	if parityErr != nil {
		tb.Fatal(parityErr)
	}
	return parityPool, context.Background()
}

// startParityPostgres uses PODHUB_PARITY_DSN when set. Otherwise it starts
// the same postgres:16-alpine container as the other parity tests. Missing
// Docker is a failure, not a skip.
func startParityPostgres(ctx context.Context) (string, error) {
	if dsn := os.Getenv("PODHUB_PARITY_DSN"); dsn != "" {
		return dsn, nil
	}
	if !testkit.DockerAvailable() {
		return "", errors.New("docker daemon is not available")
	}
	container, err := postgres.Run(ctx, "postgres:16-alpine",
		postgres.WithDatabase("podhub"),
		postgres.WithUsername("postgres"),
		postgres.WithPassword("postgres"),
		postgres.BasicWaitStrategies(),
	)
	if err != nil {
		return "", err
	}
	return container.ConnectionString(ctx, "sslmode=disable")
}
