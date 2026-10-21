package integration

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/listing/submit"
	queuecontract "github.com/xxww0098/podhub-go/internal/queue/contract"
	queuedomain "github.com/xxww0098/podhub-go/internal/queue/domain"
	queuerepo "github.com/xxww0098/podhub-go/internal/queue/repo"
	queueservice "github.com/xxww0098/podhub-go/internal/queue/service"
)

func TestListingBatchLoopSerializesOneOrgAndMakesProgress(t *testing.T) {
	ctx := context.Background()
	pool := migratedPool(t, ctx)
	userA, orgID := insertWorkspace(t, ctx, pool, "batch-loop-a-"+uuid.NewString()+"@example.com", "Batch loop A")
	userB, _ := insertWorkspace(t, ctx, pool, "batch-loop-b-"+uuid.NewString()+"@example.com", "Batch loop B")
	storePK, storeID := insertStore(t, ctx, pool, orgID)
	// Claim permits at most two jobs per user in one pass. Two submitters
	// in one org make four simultaneously claimed batch jobs reachable.
	if _, err := pool.Exec(ctx, `
		INSERT INTO organization_members (org_id, user_id, role, status, display_name, created_at, updated_at, join_order)
		VALUES ($1, $2, 'owner', 'active', 'Batch owner', clock_timestamp(), clock_timestamp(), 1),
		       ($1, $3, 'member', 'active', 'Batch member', clock_timestamp(), clock_timestamp(), 2)`, orgID, userA, userB); err != nil {
		t.Fatal(err)
	}
	jobs := make([]queuecontract.NewJob, 4)
	intentIDs := make([]string, len(jobs))
	jobIDs := make([]uuid.UUID, len(jobs))
	for i := range jobs {
		row := seed(t, ctx, pool, orgID, storePK, storeID, fmt.Sprintf("loop-batch-%d", i))
		intentIDs[i] = row.IntentID
		payload, err := json.Marshal(map[string]any{
			"storeId": storeID,
			"intents": []map[string]any{{
				"intentId": row.IntentID, "rowId": row.RowID, "rowRevision": row.RowRevision,
				"requestHash": row.RequestHash, "import": json.RawMessage(row.Import),
			}},
		})
		if err != nil {
			t.Fatal(err)
		}
		userID := userA
		if i >= 2 {
			userID = userB
		}
		jobs[i] = jobInput(orgID, userID, "listing.submit.batch", "batch-loop-"+row.IntentID, string(payload))
		jobs[i].CreatedAt = time.Now().Add(time.Duration(i-len(jobs)) * time.Second)
		jobIDs[i] = jobs[i].ID
	}
	if _, err := queuerepo.Enqueue(ctx, pool, jobs, 256); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM jobs WHERE id = ANY($1::uuid[])`, jobIDs)
	})
	var posts atomic.Int32
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v3/product/import" {
			http.Error(w, "unexpected endpoint", http.StatusBadRequest)
			return
		}
		task := posts.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"result":{"task_id":%d}}`, task)
	}))
	t.Cleanup(mock.Close)
	eg := egress(t, mock.URL, false)
	started := make(chan uuid.UUID, 16)
	release := make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(release) })
	var active, peak atomic.Int32
	cancel, stopped := startQueueLoop(t, pool, queueservice.Options{
		Owner: "batch-loop-" + uuid.NewString(), Kinds: []string{"listing.submit.batch"}, Limit: 4,
		Work: func(ctx context.Context, pool *pgxpool.Pool, job queuecontract.Claimed) error {
			n := active.Add(1)
			defer active.Add(-1)
			for previous := peak.Load(); n > previous && !peak.CompareAndSwap(previous, n); previous = peak.Load() {
			}
			select {
			case started <- job.ID:
			case <-ctx.Done():
				return ctx.Err()
			}
			select {
			case <-release:
			case <-ctx.Done():
				return ctx.Err()
			}
			return submit.Work(ctx, pool, job, eg.Port())
		},
	})
	queueLoopStarted(t, started, 3*time.Second)
	select {
	case id := <-started:
		t.Fatalf("same-org batch %s overlapped the first callback", id)
	case <-time.After(2 * queuedomain.WakePollInterval):
	}
	var claimed int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM jobs WHERE id = ANY($1::uuid[]) AND state = 'running'`, jobIDs).Scan(&claimed); err != nil {
		t.Fatal(err)
	}
	if claimed != len(jobs) {
		t.Fatalf("fixture did not exercise four same-org claims: %d", claimed)
	}
	once.Do(func() { close(release) })
	deadline := time.NewTimer(15 * time.Second)
	defer deadline.Stop()
	poll := time.NewTicker(20 * time.Millisecond)
	defer poll.Stop()
	for {
		var succeeded, accepted int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM jobs WHERE id = ANY($1::uuid[]) AND state = 'succeeded'`, jobIDs).Scan(&succeeded); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM submission_intents WHERE id = ANY($1::uuid[]) AND state = 'accepted'`, intentIDs).Scan(&accepted); err != nil {
			t.Fatal(err)
		}
		if succeeded == len(jobs) && accepted == len(jobs) {
			break
		}
		select {
		case <-deadline.C:
			t.Fatalf("same-org batch queue did not progress: succeeded=%d accepted=%d posts=%d", succeeded, accepted, posts.Load())
		case <-poll.C:
		}
	}
	cancel()
	select {
	case <-stopped:
	case <-time.After(3 * time.Second):
		t.Fatal("batch loop did not stop")
	}
	if posts.Load() != int32(len(jobs)) || peak.Load() != 1 {
		t.Fatalf("batch execution: posts=%d (want %d) callback peak=%d (want 1)", posts.Load(), len(jobs), peak.Load())
	}
}
