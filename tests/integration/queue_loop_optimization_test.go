package integration

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	queuecontract "github.com/xxww0098/podhub-go/internal/queue/contract"
	queuedomain "github.com/xxww0098/podhub-go/internal/queue/domain"
	queuerepo "github.com/xxww0098/podhub-go/internal/queue/repo"
	queueservice "github.com/xxww0098/podhub-go/internal/queue/service"
)

// Exercise the real claim loop, SQL leases and settlement. Channel barriers
// hold callbacks open so concurrency is observed rather than inferred from
// wall-clock throughput or a replacement scheduler.
func TestQueueLoopExecution(t *testing.T) {
	ctx := context.Background()
	pool := migratedPool(t, ctx)
	const userID int64 = 94980
	reset := func(t *testing.T, count int) []queuecontract.NewJob {
		t.Helper()
		if err := purgeParityFixtures(ctx, pool); err != nil {
			t.Fatal(err)
		}
		org := seedTenant(t, ctx, pool, userID)
		jobs := make([]queuecontract.NewJob, count)
		for i := range jobs {
			jobs[i] = jobInput(org, userID, "listing.submit", fmt.Sprintf("loop-%d", i), `{}`)
			jobs[i].CreatedAt = time.Now().Add(time.Duration(i-count) * time.Second)
		}
		if _, err := queuerepo.Enqueue(ctx, pool, jobs, 256); err != nil {
			t.Fatal(err)
		}
		return jobs
	}
	t.Cleanup(func() {
		if err := purgeParityFixtures(ctx, pool); err != nil {
			t.Error(err)
		}
	})

	t.Run("bounded parallel execution and refill", func(t *testing.T) {
		reset(t, 3)
		started := make(chan uuid.UUID, 3)
		release := make(chan struct{})
		_, _ = startQueueLoop(t, pool, queueservice.Options{
			Owner: "loop-concurrency", Kinds: []string{"listing.submit"}, Limit: 2,
			Work: func(ctx context.Context, pool *pgxpool.Pool, job queuecontract.Claimed) error {
				// Business settlement can precede callback cleanup or post-work
				// hooks. A freed DB row must not free the local execution slot.
				ok, err := queuerepo.Settle(ctx, pool, job.Lease(), queuecontract.StateSucceeded, nil)
				if err != nil || !ok {
					return fmt.Errorf("settle %s: matched=%t: %w", job.ID, ok, err)
				}
				started <- job.ID
				select {
				case <-release:
				case <-ctx.Done():
				}
				return nil
			},
		})
		first := queueLoopStarted(t, started, 3*time.Second)
		second := queueLoopStarted(t, started, 3*time.Second)
		if first == second {
			t.Fatal("same job executed twice")
		}
		// Both jobs are settled in SQL, but their callbacks still occupy
		// both slots. Cross two poll ticks before releasing either one.
		select {
		case id := <-started:
			t.Fatalf("job %s exceeded the two live callback slots", id)
		case <-time.After(2 * queuedomain.WakePollInterval):
		}
		release <- struct{}{}
		third := queueLoopStarted(t, started, 3*time.Second)
		if third == first || third == second {
			t.Fatal("refill executed an already completed job")
		}
	})

	t.Run("batch order stays within org while other orgs progress", func(t *testing.T) {
		if err := purgeParityFixtures(ctx, pool); err != nil {
			t.Fatal(err)
		}
		orgA := seedTenant(t, ctx, pool, userID)
		orgB := seedTenant(t, ctx, pool, userID+1)
		jobs := []queuecontract.NewJob{
			jobInput(orgA, userID, "listing.submit.batch", "a-first", `{}`),
			jobInput(orgA, userID, "listing.submit.batch", "a-second", `{}`),
			jobInput(orgB, userID+1, "listing.submit.batch", "b-first", `{}`),
			jobInput(orgB, userID+1, "listing.submit.batch", "b-second", `{}`),
		}
		for i := range jobs {
			jobs[i].CreatedAt = time.Now().Add(time.Duration(i-len(jobs)) * time.Second)
		}
		if _, err := queuerepo.Enqueue(ctx, pool, jobs, 256); err != nil {
			t.Fatal(err)
		}
		started := make(chan uuid.UUID, len(jobs))
		releaseA := make(chan struct{})
		cancel, stopped := startQueueLoop(t, pool, queueservice.Options{
			Owner: "loop-org-order", Kinds: []string{"listing.submit.batch"}, Limit: 4,
			Work: func(ctx context.Context, pool *pgxpool.Pool, job queuecontract.Claimed) error {
				started <- job.ID
				if job.OrgID == orgA {
					select {
					case <-releaseA:
						_, err := queuerepo.Settle(ctx, pool, job.Lease(), queuecontract.StateSucceeded, nil)
						return err
					case <-ctx.Done():
					}
				} else {
					<-ctx.Done()
				}
				return nil
			},
		})
		seen := map[uuid.UUID]bool{
			queueLoopStarted(t, started, 3*time.Second): true,
			queueLoopStarted(t, started, 3*time.Second): true,
		}
		if !seen[jobs[0].ID] || !seen[jobs[2].ID] {
			t.Fatalf("first callbacks=%v, want first claim of each org", seen)
		}
		releaseA <- struct{}{}
		if id := queueLoopStarted(t, started, 3*time.Second); id != jobs[1].ID {
			t.Fatalf("org A successor=%s, want %s", id, jobs[1].ID)
		}
		cancel()
		select {
		case <-stopped:
		case <-time.After(3 * time.Second):
			t.Fatal("cancelled org batch chain did not drain")
		}
		select {
		case id := <-started:
			t.Fatalf("cancelled queued callback started: %s", id)
		default:
		}
	})

	t.Run("heartbeat and sweep continue during work", func(t *testing.T) {
		jobs := reset(t, 2)
		// Leave one expired claim for the live loop's sweep to recover.
		abandoned, err := queuerepo.Claim(ctx, pool, "listing.submit", "loop-abandoned", 1)
		if err != nil || len(abandoned) != 1 {
			t.Fatalf("abandoned claim=%v: %v", abandoned, err)
		}
		if _, err := pool.Exec(ctx, `UPDATE jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`, abandoned[0].ID); err != nil {
			t.Fatal(err)
		}
		started := make(chan queuecontract.Claimed, 1)
		_, _ = startQueueLoop(t, pool, queueservice.Options{
			Owner: "loop-heartbeat", Kinds: []string{"listing.submit"}, Limit: 1,
			Work: func(ctx context.Context, _ *pgxpool.Pool, job queuecontract.Claimed) error {
				started <- job
				<-ctx.Done()
				return nil
			},
		})
		var job queuecontract.Claimed
		select {
		case job = <-started:
		case <-time.After(3 * time.Second):
			t.Fatal("live callback did not start")
		}
		if job.ID != jobs[1].ID {
			t.Fatalf("running job=%s, want second job=%s", job.ID, jobs[1].ID)
		}
		deadline := time.NewTimer(queuedomain.HeartbeatInterval + 5*time.Second)
		defer deadline.Stop()
		poll := time.NewTicker(50 * time.Millisecond)
		defer poll.Stop()
		for {
			live := readJob(t, ctx, pool, job.ID)
			expired := readJob(t, ctx, pool, abandoned[0].ID)
			if live.until != nil && live.until.After(job.Until.Add(time.Second)) && expired.state == "failed" {
				if live.state != "running" || live.epoch != job.Epoch || live.attempt != job.Attempt {
					t.Fatalf("heartbeat changed execution identity: %+v", live)
				}
				return
			}
			select {
			case <-deadline.C:
				t.Fatalf("blocked callback starved maintenance: live=%+v expired=%+v", live, expired)
			case <-poll.C:
			}
		}
	})

	t.Run("callback error requeues and releases the local slot", func(t *testing.T) {
		jobs := reset(t, 2)
		started := make(chan uuid.UUID, 2)
		_, _ = startQueueLoop(t, pool, queueservice.Options{
			Owner: "loop-error", Kinds: []string{"listing.submit"}, Limit: 1,
			Work: func(ctx context.Context, pool *pgxpool.Pool, job queuecontract.Claimed) error {
				started <- job.ID
				if job.ID == jobs[0].ID {
					return errors.New("synthetic pre-dispatch failure")
				}
				_, err := queuerepo.Settle(ctx, pool, job.Lease(), queuecontract.StateSucceeded, nil)
				return err
			},
		})
		if id := queueLoopStarted(t, started, 3*time.Second); id != jobs[0].ID {
			t.Fatalf("first=%s, want %s", id, jobs[0].ID)
		}
		if id := queueLoopStarted(t, started, 3*time.Second); id != jobs[1].ID {
			t.Fatalf("next=%s, want queued job=%s", id, jobs[1].ID)
		}
		if failed := readJob(t, ctx, pool, jobs[0].ID); failed.state != "retry_wait" || failed.attempt != 1 || failed.errCode == nil || *failed.errCode != "safe_to_retry" {
			t.Fatalf("callback error changed the requeue contract: %+v", failed)
		}
	})

	t.Run("cancellation waits for active cleanup and stops claims", func(t *testing.T) {
		jobs := reset(t, 2)
		started := make(chan uuid.UUID, 2)
		cancelled := make(chan struct{})
		finish := make(chan struct{})
		// A failed assertion must also release the cleanup barrier before
		// startQueueLoop's registered cleanup waits for the worker.
		var finishClosed bool
		defer func() {
			if !finishClosed {
				close(finish)
			}
		}()
		cancel, stopped := startQueueLoop(t, pool, queueservice.Options{
			Owner: "loop-cancel", Kinds: []string{"listing.submit"}, Limit: 1,
			Work: func(ctx context.Context, _ *pgxpool.Pool, job queuecontract.Claimed) error {
				started <- job.ID
				<-ctx.Done()
				close(cancelled)
				<-finish
				return nil
			},
		})
		if id := queueLoopStarted(t, started, 3*time.Second); id != jobs[0].ID {
			t.Fatalf("first=%s, want %s", id, jobs[0].ID)
		}
		cancel()
		select {
		case <-cancelled:
		case <-time.After(3 * time.Second):
			t.Fatal("callback did not receive cancellation")
		}
		select {
		case <-stopped:
			t.Fatal("claim loop returned before callback cleanup")
		default:
		}
		close(finish)
		finishClosed = true
		select {
		case <-stopped:
		case <-time.After(3 * time.Second):
			t.Fatal("claim loop did not stop after callback cleanup")
		}
		if next := readJob(t, ctx, pool, jobs[1].ID); next.state != "queued" || next.attempt != 0 {
			t.Fatalf("cancelled loop claimed another job: %+v", next)
		}
	})
}

func startQueueLoop(t *testing.T, pool *pgxpool.Pool, opts queueservice.Options) (context.CancelFunc, <-chan struct{}) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		if err := queueservice.Run(ctx, pool, opts); err != nil {
			t.Errorf("claim loop: %v", err)
		}
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-stopped:
		case <-time.After(5 * time.Second):
			t.Error("claim loop leaked a callback after cancellation")
		}
	})
	return cancel, stopped
}

func queueLoopStarted(t *testing.T, started <-chan uuid.UUID, timeout time.Duration) uuid.UUID {
	t.Helper()
	select {
	case id := <-started:
		return id
	case <-time.After(timeout):
		t.Fatal("callback did not start while another callback was blocked")
		return uuid.Nil
	}
}
