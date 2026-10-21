package submit

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
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
	queue "github.com/xxww0098/podhub-go/internal/platform/jobsched"
	_ "github.com/xxww0098/podhub-go/internal/queue"
	"github.com/xxww0098/podhub-go/tests/testkit"
)

func TestEnqueueDraftsBatchMatchesSequential(t *testing.T) {
	pool, ctx := draftParityDB(t)
	orgID, userID := seedDraftOrg(t, ctx, pool, 96211)
	storeID := "11111111-1111-4111-8111-111111111111"
	cardID := "22222222-2222-4222-8222-222222222222"
	if _, err := pool.Exec(ctx, `INSERT INTO organization_stores(org_id,uuid,create_order,name) VALUES($1,$2,1,'Draft')`, orgID, storeID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { purgeDraft(context.Background(), pool, orgID, userID) })

	t.Run("created and replayed", func(t *testing.T) {
		ready := draftRows(t, ctx, pool, orgID, storeID, cardID, 4)
		seedIntent(t, ctx, pool, orgID, storeID, cardID, ready[1], "accepted", time.Date(2020, 1, 2, 3, 4, 5, 0, time.UTC))
		seedIntent(t, ctx, pool, orgID, storeID, cardID, ready[3], "queued", time.Date(2020, 1, 2, 3, 4, 6, 0, time.UTC))
		seq, bat := compareDrafts(t, ctx, pool, orgID, userID, storeID, cardID, ready)
		if seq[0].Outcome != "created" || seq[1].Outcome != "replayed" || seq[2].Outcome != "created" || seq[3].Outcome != "replayed" {
			t.Fatalf("outcomes %+v", outcomes(seq))
		}
		if bat[1].Intent.State != "accepted" || bat[3].Intent.State != "queued" {
			t.Fatalf("replay states %s %s", bat[1].Intent.State, bat[3].Intent.State)
		}
		if bat[1].Intent.UpdatedAtMS != 1577934245000 || bat[3].Intent.UpdatedAtMS != 1577934246000 {
			t.Fatalf("replay times %d %d", bat[1].Intent.UpdatedAtMS, bat[3].Intent.UpdatedAtMS)
		}
		if bat[1].Intent.ID == bat[0].Intent.ID {
			t.Fatal("replay id collided with a create")
		}
	})

	t.Run("same batch client operation id", func(t *testing.T) {
		ready := draftRows(t, ctx, pool, orgID, storeID, cardID, 2)
		ready[1].clientOp = ready[0].clientOp
		seq, bat := compareDrafts(t, ctx, pool, orgID, userID, storeID, cardID, ready)
		if seq[0].Outcome != "created" || seq[1].Outcome != "replayed" || seq[1].Intent.ID != seq[0].Intent.ID {
			t.Fatalf("seq %+v", outcomes(seq))
		}
		if bat[0].Outcome != "created" || bat[1].Outcome != "replayed" || bat[1].Intent.ID != bat[0].Intent.ID {
			t.Fatalf("bat %+v", outcomes(bat))
		}
		if bat[1].Intent.State != "queued" {
			t.Fatalf("state %s", bat[1].Intent.State)
		}
	})

	t.Run("thirty rows ten replays", func(t *testing.T) {
		if _, err := pool.Exec(ctx, `DELETE FROM jobs WHERE org_id = $1`, orgID); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `DELETE FROM submission_intents WHERE org_id = $1`, orgID); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `DELETE FROM listing_rows WHERE org_id = $1`, orgID); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `DELETE FROM account_queue_head WHERE user_id = $1`, userID); err != nil {
			t.Fatal(err)
		}
		ready := draftRows(t, ctx, pool, orgID, storeID, cardID, 30)
		replayAt := time.Date(2020, 6, 1, 0, 0, 0, 0, time.UTC)
		var replayN int
		for i := range ready {
			if i%3 != 2 {
				continue
			}
			state := "queued"
			if replayN == 0 {
				state = "accepted"
			}
			seedIntent(t, ctx, pool, orgID, storeID, cardID, ready[i], state, replayAt.Add(time.Duration(i)*time.Second))
			replayN++
		}
		if replayN != 10 {
			t.Fatalf("replays %d", replayN)
		}
		seq, bat := compareDrafts(t, ctx, pool, orgID, userID, storeID, cardID, ready)
		if len(seq) != 30 || len(bat) != 30 {
			t.Fatalf("len %d %d", len(seq), len(bat))
		}
		created := 0
		for i := range bat {
			if bat[i].Outcome == "created" {
				created++
			}
		}
		if created != 20 {
			t.Fatalf("created %d", created)
		}

		tr, traced := draftTracedPool(t, ctx)
		reset := pinDraftIDs(t)
		reset()
		tx, err := traced.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		if err := tenant.EnterApp(ctx, tx, orgID); err != nil {
			t.Fatal(err)
		}
		tr.sql = nil
		tr.batches = 0
		views, err := enqueueDrafts(ctx, tx, orgID, userID, storeID, ready, time.Now())
		if err != nil {
			t.Fatal(err)
		}
		inserts, reads, states := 0, 0, 0
		for _, sql := range tr.sql {
			switch {
			case strings.Contains(sql, "INSERT INTO public.submission_intents"):
				inserts++
			case strings.Contains(sql, "client_operation_id = $3"):
				reads++
			case strings.Contains(sql, "SELECT state FROM public.submission_intents"):
				states++
			}
		}
		if inserts != 30 || reads != 30 || states != 10 {
			t.Fatalf("inserts %d reads %d states %d batches %d\n%v", inserts, reads, states, tr.batches, tr.sql)
		}
		// 30 insert+read, 10 state reads, subscription gate, worker, head+3 locks, exists+admit+insert+reset, app.
		if len(tr.sql) != 1+60+10+1+4+4+1 || tr.batches != 4 {
			t.Fatalf("statements %d batches %d\n%v", len(tr.sql), tr.batches, tr.sql)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		var queued, accepted, total int
		if err := pool.QueryRow(ctx, `
			SELECT count(*) FILTER (WHERE state = 'queued'),
			       count(*) FILTER (WHERE state = 'accepted'),
			       count(*)
			  FROM submission_intents
			 WHERE org_id = $1 AND store_id = $2::uuid`, orgID, storeID).Scan(&queued, &accepted, &total); err != nil {
			t.Fatal(err)
		}
		if total != 30 || accepted != 1 || queued != 29 {
			t.Fatalf("states total %d queued %d accepted %d", total, queued, accepted)
		}
		var jobs int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM jobs WHERE org_id = $1 AND kind = 'listing.submit.batch'`, orgID).Scan(&jobs); err != nil {
			t.Fatal(err)
		}
		if jobs != 1 {
			t.Fatalf("jobs %d", jobs)
		}
		if views[2].Outcome != "replayed" || views[2].Intent.State != "accepted" {
			t.Fatalf("row 2 %+v", views[2])
		}
	})
}

func TestEnqueueDraftsRefusesPausedStore(t *testing.T) {
	pool, ctx := draftParityDB(t)
	orgID, userID := seedDraftOrg(t, ctx, pool, 96212)
	storeA := "33333333-3333-4333-8333-333333333331"
	storeB := "33333333-3333-4333-8333-333333333332"
	cardID := "44444444-4444-4444-8444-444444444444"
	if _, err := pool.Exec(ctx, `
			INSERT INTO organization_stores(org_id, uuid, create_order, name) VALUES
			($1, $2, 1, 'Kept'), ($1, $3, 2, 'Paused')`, orgID, storeA, storeB); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { purgeDraft(context.Background(), pool, orgID, userID) })
	// The paid window covers wall-clock now, so time.Now() would admit store B.
	// A caller clock outside that window drops it out of the free slot.
	wall := time.Now().UTC()
	start, end := wall.Add(-time.Hour), wall.Add(time.Hour)

	t.Run("paused", func(t *testing.T) {
		seedDraftPeriod(t, ctx, pool, orgID, start, end, nil)
		refuseDraftEnqueue(t, ctx, pool, orgID, userID, storeB, cardID, start.Add(-time.Minute))
	})
	t.Run("not on keep list", func(t *testing.T) {
		seedDraftPeriod(t, ctx, pool, orgID, start, end, []string{storeA})
		refuseDraftEnqueue(t, ctx, pool, orgID, userID, storeB, cardID, wall)
	})
}

func seedDraftPeriod(t *testing.T, ctx context.Context, pool *pgxpool.Pool, orgID int64, start, end time.Time, keep []string) {
	t.Helper()
	if _, err := pool.Exec(ctx, `DELETE FROM subscription_periods WHERE org_id = $1`, orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
			INSERT INTO subscriptions (org_id, status, plan_key, term_start, term_end, updated_at)
			VALUES ($1, 'active', 'lite', $2, $3, clock_timestamp())
			ON CONFLICT (org_id) DO UPDATE
			    SET status = 'active', plan_key = 'lite', term_start = $2, term_end = $3, updated_at = clock_timestamp()`,
		orgID, start, end); err != nil {
		t.Fatal(err)
	}
	var keepArg any
	if keep != nil {
		keepArg = keep
	}
	if _, err := pool.Exec(ctx, `
			INSERT INTO subscription_periods (
				org_id, starts_at, ends_at, plan_key, plan_stores, plan_members,
				plan_monthly_cents, store_monthly_cents, member_monthly_cents,
				extra_stores, extra_members, keep_store_ids
			) VALUES ($1, $2, $3, 'lite', 5, 1, 10000, 2000, 3000, 0, 0, $4)`,
		orgID, start, end, keepArg); err != nil {
		t.Fatal(err)
	}
}

func refuseDraftEnqueue(t *testing.T, ctx context.Context, pool *pgxpool.Pool, orgID, userID int64, storeID, cardID string, now time.Time) {
	t.Helper()
	ready := draftRows(t, ctx, pool, orgID, storeID, cardID, 2)
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if err := tenant.EnterApp(ctx, tx, orgID); err != nil {
		t.Fatal(err)
	}
	_, err = enqueueDrafts(ctx, tx, orgID, userID, storeID, ready, now)
	var st Status
	if !errors.As(err, &st) || st.Code != 402 || st.Kind != "SUBSCRIPTION_STORE_PAUSED" {
		t.Fatalf("got code %d kind %s err %v", st.Code, st.Kind, err)
	}
	var intents, jobs int
	if err := tx.QueryRow(ctx, `
			SELECT count(*) FROM public.submission_intents
			 WHERE org_id = $1 AND store_id = $2::uuid`, orgID, storeID).Scan(&intents); err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(ctx, `
			SELECT count(*) FROM public.jobs
			 WHERE org_id = $1 AND kind = 'listing.submit.batch'`, orgID).Scan(&jobs); err != nil {
		t.Fatal(err)
	}
	var queued int
	if err := tx.QueryRow(ctx, `
			SELECT count(*) FROM public.listing_rows
			 WHERE org_id = $1 AND id = ANY($2::uuid[]) AND submission_state = 'queued'`,
		orgID, []string{ready[0].rowID, ready[1].rowID}).Scan(&queued); err != nil {
		t.Fatal(err)
	}
	if intents != 0 || jobs != 0 || queued != 0 {
		t.Fatalf("intents %d jobs %d queued rows %d", intents, jobs, queued)
	}
}

func compareDrafts(t *testing.T, ctx context.Context, pool *pgxpool.Pool, orgID, userID int64, storeID, cardID string, ready []frozen) (seq, bat []DraftItem) {
	t.Helper()
	// Keep the old single-card sequential oracle unchanged. The production
	// enqueue now takes each row's card rather than a batch-wide card.
	batched := func(ctx context.Context, tx pgx.Tx, orgID, userID int64, storeID, _ string, ready []frozen) ([]DraftItem, error) {
		return enqueueDrafts(ctx, tx, orgID, userID, storeID, ready, time.Now())
	}
	reset := pinDraftIDs(t)
	seq = runDrafts(t, ctx, pool, orgID, userID, storeID, cardID, ready, enqueueDraftsSequential, reset)
	bat = runDrafts(t, ctx, pool, orgID, userID, storeID, cardID, ready, batched, reset)
	if len(seq) != len(bat) {
		t.Fatalf("len %d %d", len(seq), len(bat))
	}
	seqCreated := intentTimes(seq)
	batCreated := intentTimes(bat)
	for i := range seq {
		if seq[i].Outcome != bat[i].Outcome || seq[i].RowID != bat[i].RowID {
			t.Fatalf("item %d seq %+v bat %+v", i, seq[i], bat[i])
		}
		if seq[i].Intent == nil || bat[i].Intent == nil {
			t.Fatalf("nil intent %d", i)
		}
		if seq[i].Intent.ID != bat[i].Intent.ID || seq[i].Intent.State != bat[i].Intent.State {
			t.Fatalf("intent %d\nseq %+v\nbat %+v", i, seq[i].Intent, bat[i].Intent)
		}
		if seq[i].Outcome != "replayed" {
			continue
		}
		// A same-batch replay reads the row this call just inserted. That
		// clock_timestamp differs between the two transactions; it must
		// equal the created item in the same result. A seeded replay has
		// a stable timestamp, so the two runs match each other.
		if ms, ok := seqCreated[seq[i].Intent.ID]; ok {
			if seq[i].Intent.UpdatedAtMS != ms || bat[i].Intent.UpdatedAtMS != batCreated[bat[i].Intent.ID] {
				t.Fatalf("same-batch replay time %d seq %d/%d bat %d/%d", i, seq[i].Intent.UpdatedAtMS, ms, bat[i].Intent.UpdatedAtMS, batCreated[bat[i].Intent.ID])
			}
			continue
		}
		if seq[i].Intent.UpdatedAtMS != bat[i].Intent.UpdatedAtMS {
			t.Fatalf("replay time %d %d %d", i, seq[i].Intent.UpdatedAtMS, bat[i].Intent.UpdatedAtMS)
		}
	}
	seqJobs := runDraftPayloads(t, ctx, pool, orgID, userID, storeID, cardID, ready, enqueueDraftsSequential, reset)
	batJobs := runDraftPayloads(t, ctx, pool, orgID, userID, storeID, cardID, ready, batched, reset)
	if len(seqJobs) != len(batJobs) {
		t.Fatalf("jobs %d %d", len(seqJobs), len(batJobs))
	}
	for i := range seqJobs {
		if seqJobs[i] != batJobs[i] {
			t.Fatalf("payload %d\n%s\n%s", i, seqJobs[i], batJobs[i])
		}
	}
	return seq, bat
}

func runDrafts(t *testing.T, ctx context.Context, pool *pgxpool.Pool, orgID, userID int64, storeID, cardID string, ready []frozen, fn func(context.Context, pgx.Tx, int64, int64, string, string, []frozen) ([]DraftItem, error), reset func()) []DraftItem {
	t.Helper()
	reset()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if err := tenant.EnterApp(ctx, tx, orgID); err != nil {
		t.Fatal(err)
	}
	views, err := fn(ctx, tx, orgID, userID, storeID, cardID, cloneFrozen(ready))
	if err != nil {
		t.Fatal(err)
	}
	out := make([]DraftItem, len(views))
	copy(out, views)
	for i := range out {
		if out[i].Intent == nil || out[i].Outcome != "created" {
			continue
		}
		var ms int64
		if err := tx.QueryRow(ctx, `SELECT (extract(epoch FROM updated_at) * 1000)::bigint FROM public.submission_intents WHERE id = $1::uuid`, out[i].Intent.ID).Scan(&ms); err != nil {
			t.Fatal(err)
		}
		if out[i].Intent.UpdatedAtMS != ms {
			t.Fatalf("returning %d row %d", out[i].Intent.UpdatedAtMS, ms)
		}
	}
	var role, guc string
	if err := tx.QueryRow(ctx, `SELECT current_setting('role', true), current_setting('app.current_org_id', true)`).Scan(&role, &guc); err != nil {
		t.Fatal(err)
	}
	if role != "podhub_app" || guc != fmt.Sprint(orgID) {
		t.Fatalf("role %s org %s", role, guc)
	}
	return out
}

func runDraftPayloads(t *testing.T, ctx context.Context, pool *pgxpool.Pool, orgID, userID int64, storeID, cardID string, ready []frozen, fn func(context.Context, pgx.Tx, int64, int64, string, string, []frozen) ([]DraftItem, error), reset func()) []string {
	t.Helper()
	reset()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if err := tenant.EnterApp(ctx, tx, orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := fn(ctx, tx, orgID, userID, storeID, cardID, cloneFrozen(ready)); err != nil {
		t.Fatal(err)
	}
	rows, err := tx.Query(ctx, `
		SELECT idempotency_key, payload::text
		  FROM public.jobs
		 WHERE org_id = $1 AND kind = 'listing.submit.batch'
		 ORDER BY idempotency_key`, orgID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var key, payload string
		if err := rows.Scan(&key, &payload); err != nil {
			t.Fatal(err)
		}
		out = append(out, key+"\n"+payload)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func enqueueDraftsNow(ctx context.Context, tx pgx.Tx, orgID, userID int64, storeID, _ string, ready []frozen) ([]DraftItem, error) {
	return enqueueDrafts(ctx, tx, orgID, userID, storeID, ready, time.Now())
}

func enqueueDraftsSequential(ctx context.Context, tx pgx.Tx, orgID, userID int64, storeID, cardID string, ready []frozen) ([]DraftItem, error) {
	digests := make([]string, len(ready))
	for i, row := range ready {
		digests[i] = row.digest
	}
	batchOp := batchClientOperationID(storeID, digests)
	views := make([]DraftItem, len(ready))
	queued := make([]frozen, 0, len(ready))
	for i, row := range ready {
		id := newID()
		var updated int64
		err := tx.QueryRow(ctx, insertIntentSQL,
			id, orgID, storeID, row.rowID, row.revision, row.clientOp, row.digest, row.offerID, cardID).Scan(&updated)
		outcome := "created"
		if errors.Is(err, pgx.ErrNoRows) {
			err = tx.QueryRow(ctx, readIntentSQL, orgID, storeID, row.clientOp).Scan(&id, &updated)
			outcome = "replayed"
		}
		if err != nil {
			return nil, err
		}
		view := IntentView{
			SubmissionIssues: []struct{}{}, CurrentIssueStatus: "absent", CanResume: false,
			ID: id, StoreID: storeID, ListingRowID: row.rowID, RowRevision: row.revision,
			ClientOperationID: row.clientOp, State: "queued", SubmissionReceiptStatus: "absent",
			UpdatedAtMS: updated,
		}
		if outcome == "replayed" {
			if err := tx.QueryRow(ctx, `SELECT state FROM public.submission_intents WHERE id = $1::uuid`, id).Scan(&view.State); err != nil {
				return nil, err
			}
		}
		views[i] = DraftItem{RowID: row.rowID, Outcome: outcome, Intent: &view}
		if outcome == "created" {
			row.intentID = id
			queued = append(queued, row)
		}
	}
	if len(queued) == 0 {
		return views, nil
	}
	plans := PlanImportJobs(newID(), newID(), len(queued))
	jobs := make([]queue.NewJob, 0, len(plans))
	for _, plan := range plans {
		chunk := make([]batchIntent, 0, len(plan.Intents))
		for _, index := range plan.Intents {
			row := queued[index]
			chunk = append(chunk, batchIntent{
				IntentID: row.intentID, RowID: row.rowID, RowRevision: row.revision,
				RequestHash: row.digest, Import: row.importBody,
			})
		}
		payload, err := json.Marshal(batchJob{
			BatchID: plan.BatchID, BatchClientOperationID: batchOp, StoreID: storeID,
			Intents: chunk, SkipMediaLeaseRenewal: true,
		})
		if err != nil {
			return nil, err
		}
		jobUUID, err := uuid.Parse(plan.JobID)
		if err != nil {
			return nil, err
		}
		agg, err := uuid.Parse(plan.BatchID)
		if err != nil {
			return nil, err
		}
		jobs = append(jobs, queue.NewJob{
			ID: jobUUID, OrgID: orgID, Kind: "listing.submit.batch",
			AggregateType: "submission_batch", AggregateID: agg, InputRevision: 0,
			IdempotencyKey: plan.IdempotencyKey, Payload: payload,
			SubmitterUserID: userID, MaxAttempts: 8, Priority: 50,
		})
	}
	if err := tenant.EnterWorker(ctx, tx); err != nil {
		return nil, err
	}
	if _, err := queue.EnqueueOn(ctx, tx, jobs, 0); err != nil {
		return nil, err
	}
	if err := tenant.EnterApp(ctx, tx, orgID); err != nil {
		return nil, err
	}
	return views, nil
}

func pinDraftIDs(t *testing.T) func() {
	t.Helper()
	n := 0
	prev := newID
	newID = func() string {
		n++
		return fmt.Sprintf("00000000-0000-4000-8000-%012d", n)
	}
	t.Cleanup(func() { newID = prev })
	return func() { n = 0 }
}

func draftRows(t *testing.T, ctx context.Context, pool *pgxpool.Pool, orgID int64, storeID, cardID string, n int) []frozen {
	t.Helper()
	out := make([]frozen, n)
	for i := range out {
		rowID := uuid.NewString()
		if _, err := pool.Exec(ctx, `
			INSERT INTO listing_rows (id, org_id, card_id, store_id)
			VALUES ($1::uuid, $2, $3::uuid, $4::uuid)`, rowID, orgID, cardID, storeID); err != nil {
			t.Fatal(err)
		}
		out[i] = frozen{
			rowID: rowID, revision: 1, cardID: cardID, clientOp: "op-" + rowID, digest: "hash-" + rowID,
			offerID: "offer-" + rowID, importBody: json.RawMessage(fmt.Sprintf(`{"i":%d}`, i)),
		}
	}
	return out
}

func seedIntent(t *testing.T, ctx context.Context, pool *pgxpool.Pool, orgID int64, storeID, cardID string, row frozen, state string, updated time.Time) {
	t.Helper()
	if _, err := pool.Exec(ctx, `
		INSERT INTO submission_intents (
			id, org_id, store_id, listing_row_id, row_revision, client_operation_id,
			request_hash, state, offer_id, card_id, updated_at
		) VALUES (
			$1::uuid, $2, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10::uuid, $11
		)`, uuid.NewString(), orgID, storeID, row.rowID, row.revision, row.clientOp, row.digest, state, row.offerID, cardID, updated); err != nil {
		t.Fatal(err)
	}
}

func cloneFrozen(in []frozen) []frozen {
	out := make([]frozen, len(in))
	copy(out, in)
	return out
}

func intentTimes(items []DraftItem) map[string]int64 {
	out := map[string]int64{}
	for _, item := range items {
		if item.Outcome == "created" && item.Intent != nil {
			out[item.Intent.ID] = item.Intent.UpdatedAtMS
		}
	}
	return out
}

func outcomes(items []DraftItem) []string {
	out := make([]string, len(items))
	for i, item := range items {
		out[i] = item.Outcome
		if item.Intent != nil {
			out[i] += ":" + item.Intent.ID + ":" + item.Intent.State
		}
	}
	return out
}

func seedDraftOrg(t *testing.T, ctx context.Context, pool *pgxpool.Pool, userID int64) (int64, int64) {
	t.Helper()
	tag := fmt.Sprintf("dr%d", userID)
	if _, err := pool.Exec(ctx, `
		INSERT INTO account_users (id, public_id, email, password_hash, role, name, target, supplier_id, plan, created_at, updated_at)
		VALUES ($1, $2, $3, 'x', 'user', 'Draft', '/workspace', '', 'lite', clock_timestamp(), clock_timestamp())`,
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
		VALUES ($1, $2, 'owner', 'active', 'Draft', clock_timestamp(), clock_timestamp(), 1)`,
		orgID, userID); err != nil {
		t.Fatal(err)
	}
	return orgID, userID
}

func purgeDraft(ctx context.Context, pool *pgxpool.Pool, orgID, userID int64) {
	_, _ = pool.Exec(ctx, `DELETE FROM jobs WHERE org_id = $1`, orgID)
	_, _ = pool.Exec(ctx, `DELETE FROM submission_intents WHERE org_id = $1`, orgID)
	_, _ = pool.Exec(ctx, `DELETE FROM subscription_periods WHERE org_id = $1`, orgID)
	_, _ = pool.Exec(ctx, `DELETE FROM subscriptions WHERE org_id = $1`, orgID)
	_, _ = pool.Exec(ctx, `DELETE FROM listing_rows WHERE org_id = $1`, orgID)
	_, _ = pool.Exec(ctx, `DELETE FROM execution_quota WHERE user_id = $1`, userID)
	_, _ = pool.Exec(ctx, `DELETE FROM account_queue_head WHERE user_id = $1`, userID)
	_, _ = pool.Exec(ctx, `DELETE FROM organization_members WHERE user_id = $1`, userID)
	_, _ = pool.Exec(ctx, `DELETE FROM organization_stores WHERE org_id = $1`, orgID)
	_, _ = pool.Exec(ctx, `DELETE FROM organizations WHERE id = $1`, orgID)
	_, _ = pool.Exec(ctx, `DELETE FROM account_users WHERE id = $1`, userID)
}

type draftTrace struct {
	sql     []string
	batches int
}

func (t *draftTrace) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	t.sql = append(t.sql, data.SQL)
	return ctx
}
func (t *draftTrace) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}
func (t *draftTrace) TraceBatchStart(ctx context.Context, _ *pgx.Conn, _ pgx.TraceBatchStartData) context.Context {
	t.batches++
	return ctx
}
func (t *draftTrace) TraceBatchQuery(_ context.Context, _ *pgx.Conn, data pgx.TraceBatchQueryData) {
	t.sql = append(t.sql, data.SQL)
}
func (t *draftTrace) TraceBatchEnd(context.Context, *pgx.Conn, pgx.TraceBatchEndData) {}

func draftTracedPool(t *testing.T, ctx context.Context) (*draftTrace, *pgxpool.Pool) {
	t.Helper()
	if draftURL == "" {
		t.Fatal("parity database was not started")
	}
	tr := &draftTrace{}
	cfg, err := pgxpool.ParseConfig(draftURL)
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
	draftOnce sync.Once
	draftPool *pgxpool.Pool
	draftURL  string
	draftErr  error
)

func draftParityDB(t *testing.T) (*pgxpool.Pool, context.Context) {
	t.Helper()
	draftOnce.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		dsn, err := startDraftPostgres(ctx)
		if err != nil {
			draftErr = err
			return
		}
		cfg := config.Config{DatabaseURL: dsn}
		if err := cfg.CheckDatabase(); err != nil {
			draftErr = err
			return
		}
		_ = os.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "1")
		pool, err := db.Connect(ctx, cfg)
		if err != nil {
			draftErr = err
			return
		}
		if err := db.Migrate(ctx, pool); err != nil {
			pool.Close()
			draftErr = err
			return
		}
		draftURL = dsn
		draftPool = pool
	})
	if draftErr != nil {
		t.Fatal(draftErr)
	}
	return draftPool, context.Background()
}

// startDraftPostgres uses PODHUB_PARITY_DSN when set. Otherwise it starts
// the same postgres:16-alpine container as the other parity tests. Missing
// Docker is a failure, not a skip.
func startDraftPostgres(ctx context.Context) (string, error) {
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
