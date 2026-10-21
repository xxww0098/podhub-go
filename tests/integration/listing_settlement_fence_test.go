package integration

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/listing/submit"
	queue "github.com/xxww0098/podhub-go/internal/platform/jobsched"
	queuecontract "github.com/xxww0098/podhub-go/internal/queue/contract"
	queuerepo "github.com/xxww0098/podhub-go/internal/queue/repo"
)

func TestListingSettlementRejectsReclaimedLease(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	for _, kind := range []string{"listing.submit", "listing.submit.batch"} {
		t.Run(kind, func(t *testing.T) {
			job, rows := settlementJob(t, ctx, pool, kind, 1)
			tr := &heldNotSent{entered: make(chan struct{}), release: make(chan struct{})}
			var release sync.Once
			defer release.Do(func() { close(tr.release) })
			result := make(chan error, 1)
			go func() { result <- submit.Work(ctx, pool, job, tr) }()
			select {
			case <-tr.entered:
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			reclaimSettlementJob(t, ctx, pool, job)
			release.Do(func() { close(tr.release) })
			err := settlementResult(t, ctx, result)
			if err == nil || !strings.Contains(err.Error(), "lease was lost") {
				t.Fatalf("stale callback: %v", err)
			}
			assertRow(t, ctx, pool, rows[0], rowWant{intent: "queued", listing: "queued"})
			if tr.writes.Load() != 0 {
				t.Fatalf("pre-dispatch refusal sent %d requests", tr.writes.Load())
			}
			assertReclaimedJob(t, ctx, pool, job)
		})
	}
}

func TestListingLateReceiptSurvivesReclaimedLease(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	for _, kind := range []string{"listing.submit", "listing.submit.batch"} {
		t.Run(kind, func(t *testing.T) {
			n := 1
			if kind == "listing.submit.batch" {
				n = 2
			}
			job, rows := settlementJob(t, ctx, pool, kind, n)
			entered, release := make(chan struct{}), make(chan struct{})
			var once sync.Once
			var posts atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/v3/product/import" || r.Method != http.MethodPost {
					http.Error(w, "unexpected request", http.StatusBadRequest)
					return
				}
				if posts.Add(1) == 1 {
					close(entered)
				}
				select {
				case <-release:
					_, _ = w.Write([]byte(`{"result":{"task_id":777}}`))
				case <-r.Context().Done():
				}
			}))
			defer server.Close()
			defer once.Do(func() { close(release) })
			tr := egress(t, server.URL, false).Port()
			result := make(chan error, 1)
			go func() { result <- submit.Work(ctx, pool, job, tr) }()
			select {
			case <-entered:
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			reclaimSettlementJob(t, ctx, pool, job)
			once.Do(func() { close(release) })
			if err := settlementResult(t, ctx, result); !errors.Is(err, queue.ErrReceiptHeld) {
				t.Fatalf("late receipt: %v", err)
			}
			for _, row := range rows {
				assertRow(t, ctx, pool, row, rowWant{
					intent: "submitting", task: "777", listing: "submitting", write: "dispatching", occ: "held",
				})
				// Make this failed job eligible for the existing recovery pass;
				// the receipt has already committed independently of settlement.
				if _, err := pool.Exec(ctx, `UPDATE submission_intents SET updated_at = timestamptz '2000-01-01' WHERE id = $1::uuid`, row.IntentID); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := submit.ProbeDue(ctx, pool, tr, 64); err != nil {
				t.Fatal(err)
			}
			for _, row := range rows {
				assertRow(t, ctx, pool, row, rowWant{
					intent: "accepted", task: "777", listing: "accepted", write: "dispatching", occ: "held",
				})
			}
			if posts.Load() != 1 {
				t.Fatalf("receipt recovery sent another import: %d", posts.Load())
			}
			assertReclaimedJob(t, ctx, pool, job)
		})
	}
}

func TestListingBatchSettlementRollsBackOnLaterFailure(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	job, rows := settlementJob(t, ctx, pool, "listing.submit.batch", 2)
	// Inject a failure on the second item. A persisted batch with a missing
	// intent must not commit a terminal outcome for just its first item.
	if _, err := pool.Exec(ctx, `DELETE FROM submission_intents WHERE id = $1::uuid`, rows[1].IntentID); err != nil {
		t.Fatal(err)
	}
	if err := submit.Work(ctx, pool, job, nil); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("missing second intent: %v", err)
	}
	assertRow(t, ctx, pool, rows[0], rowWant{intent: "queued", listing: "queued"})
	got := readJob(t, ctx, pool, job.ID)
	if got.state != "running" || got.owner == nil || *got.owner != job.Owner || got.epoch != job.Epoch {
		t.Fatalf("partial settlement changed job: %+v", got)
	}
}

func TestListingBatchSettlementSkipsPastEdges(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	job, rows := settlementJob(t, ctx, pool, "listing.submit.batch", 2)
	if err := submit.ApplyStored(ctx, pool, job.OrgID, rows[0].IntentID, submit.CancelBeforeDispatch); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE listing_rows SET submission_state = 'cancelled' WHERE id = $1::uuid`, rows[0].RowID); err != nil {
		t.Fatal(err)
	}
	var before time.Time
	if err := pool.QueryRow(ctx, `SELECT updated_at FROM submission_intents WHERE id = $1::uuid`, rows[0].IntentID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err := submit.Work(ctx, pool, job, nil); err != nil {
		t.Fatal(err)
	}
	assertRow(t, ctx, pool, rows[0], rowWant{intent: "cancelled", listing: "cancelled"})
	assertRow(t, ctx, pool, rows[1], rowWant{intent: "rejected", intentErr: submit.CodeWritesDisabled, listing: "rejected"})
	var after time.Time
	if err := pool.QueryRow(ctx, `SELECT updated_at FROM submission_intents WHERE id = $1::uuid`, rows[0].IntentID).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if !after.Equal(before) {
		t.Fatal("settlement rewrote the cancelled intent")
	}
	if got := readJob(t, ctx, pool, job.ID); got.state != "failed" || got.owner != nil {
		t.Fatalf("batch did not finish: %+v", got)
	}
}

func TestListingSettlementKeepsExistingJobSemantics(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	server := serve(t, func(w http.ResponseWriter, _ string) {
		_, _ = w.Write([]byte(`{"result":{"task_id":778}}`))
	})
	for _, kind := range []string{"listing.submit", "listing.submit.batch"} {
		t.Run(kind, func(t *testing.T) {
			job, _ := settlementJob(t, ctx, pool, kind, 1)
			if _, err := pool.Exec(ctx, `UPDATE jobs SET last_error_code = 'store_busy' WHERE id = $1`, job.ID); err != nil {
				t.Fatal(err)
			}
			if err := submit.Work(ctx, pool, job, egress(t, server.URL, false).Port()); err != nil {
				t.Fatal(err)
			}
			got := readJob(t, ctx, pool, job.ID)
			if got.state != "succeeded" || got.owner != nil {
				t.Fatalf("successful job: %+v", got)
			}
			if kind == "listing.submit" && got.errCode != nil {
				t.Fatalf("single settlement did not clear its error: %v", got.errCode)
			}
			if kind == "listing.submit.batch" && (got.errCode == nil || *got.errCode != "store_busy") {
				t.Fatalf("batch settlement did not preserve its error: %v", got.errCode)
			}
		})
	}
	t.Run("single_illegal_edge", func(t *testing.T) {
		job, rows := settlementJob(t, ctx, pool, "listing.submit", 1)
		if err := submit.ApplyStored(ctx, pool, job.OrgID, rows[0].IntentID, submit.CancelBeforeDispatch); err != nil {
			t.Fatal(err)
		}
		if _, err := submit.RunAttempt(ctx, pool, nil, attempt(rows[0], job.Lease(), false)); !errors.Is(err, submit.ErrIllegalEdge) {
			t.Fatalf("single settlement skipped an illegal edge: %v", err)
		}
		if got := readJob(t, ctx, pool, job.ID); got.state != "running" || got.owner == nil || *got.owner != job.Owner {
			t.Fatalf("illegal edge changed job: %+v", got)
		}
	})
}

func settlementJob(t *testing.T, ctx context.Context, pool *pgxpool.Pool, kind string, n int) (queuecontract.Claimed, []submit.Seed) {
	t.Helper()
	userID, orgID := insertWorkspace(t, ctx, pool, "fence-"+uuid.NewString()+"@example.com", "Settlement fence")
	insertMember(t, ctx, pool, orgID, userID, "owner", 1)
	storePK, storeID := insertStore(t, ctx, pool, orgID)
	rows := make([]submit.Seed, n)
	items := make([]map[string]any, n)
	for i := range rows {
		offer := "fence-" + uuid.NewString()
		rows[i] = submit.Seed{
			OrgID: orgID, StorePK: storePK, StoreID: storeID, RowRevision: 1,
			IntentID: uuid.NewString(), RowID: uuid.NewString(), CardID: uuid.NewString(),
			OfferID: offer, ClientOp: uuid.NewString(), RequestHash: "import",
			Import: []byte(`{"items":[{"offer_id":"` + offer + `"}]}`),
		}
		row := rows[i]
		if err := submit.InsertQueued(ctx, pool, row); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE listing_rows SET submission_state = 'queued' WHERE id = $1::uuid`, row.RowID); err != nil {
			t.Fatal(err)
		}
		items[i] = map[string]any{
			"intentId": row.IntentID, "rowId": row.RowID, "rowRevision": row.RowRevision,
			"requestHash": row.RequestHash, "import": json.RawMessage(row.Import),
		}
	}
	first := rows[0]
	var body any = submit.JobBody{
		IntentID: first.IntentID, RowID: first.RowID, RowRevision: first.RowRevision,
		StorePK: storePK, OfferID: first.OfferID, RequestHash: first.RequestHash, Import: first.Import,
	}
	if kind == "listing.submit.batch" {
		body = map[string]any{"storeId": storeID, "intents": items}
	}
	payload, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	input := jobInput(orgID, userID, kind, "settlement-"+first.IntentID, string(payload))
	input.AggregateID = uuid.MustParse(first.RowID)
	if kind == "listing.submit.batch" {
		input.AggregateType, input.InputRevision = "submission_batch", 0
	}
	if _, err := queuerepo.Enqueue(ctx, pool, []queuecontract.NewJob{input}, 256); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM jobs WHERE id = $1`, input.ID) })
	claimed, err := queuerepo.Claim(ctx, pool, kind, "settlement-"+uuid.NewString(), 1)
	if err != nil || len(claimed) != 1 || claimed[0].ID != input.ID {
		t.Fatalf("Claim: jobs=%+v err=%v", claimed, err)
	}
	return claimed[0], rows
}

func reclaimSettlementJob(t *testing.T, ctx context.Context, pool *pgxpool.Pool, job queuecontract.Claimed) {
	t.Helper()
	if _, err := pool.Exec(ctx, `UPDATE jobs SET lease_until = clock_timestamp() - interval '1 second' WHERE id = $1`, job.ID); err != nil {
		t.Fatal(err)
	}
	if n, err := queuerepo.ReclaimExpiredRows(ctx, pool, job.Kind); err != nil || n < 1 {
		t.Fatalf("ReclaimExpiredRows: n=%d err=%v", n, err)
	}
	assertReclaimedJob(t, ctx, pool, job)
}

func assertReclaimedJob(t *testing.T, ctx context.Context, pool *pgxpool.Pool, job queuecontract.Claimed) {
	t.Helper()
	got := readJob(t, ctx, pool, job.ID)
	if got.state != "failed" || got.owner != nil || got.until != nil || got.epoch != job.Epoch {
		t.Fatalf("reclaimed job changed: %+v", got)
	}
}

func settlementResult(t *testing.T, ctx context.Context, result <-chan error) error {
	t.Helper()
	select {
	case err := <-result:
		return err
	case <-ctx.Done():
		t.Fatal(ctx.Err())
		return ctx.Err()
	}
}

type heldNotSent struct {
	entered chan struct{}
	release chan struct{}
	writes  atomic.Int32
}

func (*heldNotSent) WritesDisabled() bool { return false }
func (tr *heldNotSent) Ready(ctx context.Context) error {
	close(tr.entered)
	select {
	case <-tr.release:
		return submit.ErrNotSent
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (tr *heldNotSent) Write(context.Context, string, []byte) (int, string, error) {
	tr.writes.Add(1)
	return 0, "", errors.New("unexpected Write after ErrNotSent")
}
func (*heldNotSent) Read(context.Context, string, []byte) (int, string, error) {
	return 0, "", errors.New("unexpected Read")
}
