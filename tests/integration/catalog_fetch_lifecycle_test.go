package integration

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/internal/catalog/service"
)

func TestCatalogFetchLifecycle(t *testing.T) {
	f := newAdminContentFixture(t)
	for _, kind := range []string{"panic", "process_cancel", "client_disconnect"} {
		t.Run(kind, func(t *testing.T) {
			_, err := f.fixture.Exec(f.ctx, `INSERT INTO platform_catalog_fetch_config(singleton,enabled,next_run_at_ms) VALUES(true,true,1)
ON CONFLICT(singleton) DO UPDATE SET enabled=true,next_run_at_ms=1,lease_until_ms=NULL,lease_epoch=platform_catalog_fetch_config.lease_epoch+1,last_status=NULL,last_error='',failure_streak=0`)
			if err != nil {
				t.Fatal(err)
			}
			processCtx, stop := context.WithCancel(f.ctx)
			defer stop()
			requestCtx, disconnect := context.WithCancel(f.ctx)
			defer disconnect()
			entered, release := make(chan struct{}), make(chan struct{})
			fetcher := &service.Fetcher{Pool: f.runtime, Context: processCtx, Execute: func(ctx context.Context, _ service.FetchClaim) (service.FetchResult, error) {
				close(entered)
				switch kind {
				case "panic":
					panic("synthetic catalog lifecycle panic")
				case "process_cancel":
					<-ctx.Done()
					return service.FetchResult{}, ctx.Err()
				default:
					select {
					case <-release:
						return service.FetchResult{RootNodes: 7}, ctx.Err()
					case <-ctx.Done():
						return service.FetchResult{}, ctx.Err()
					}
				}
			}}
			defer func() { stop(); fetcher.Wait() }()
			started, err := fetcher.Start(requestCtx, false)
			if err != nil || !started {
				t.Fatalf("start=%v err=%v", started, err)
			}
			waitCatalogSignal(t, entered, "accepted work to enter")
			if kind == "process_cancel" {
				stop()
			}
			if kind == "client_disconnect" {
				disconnect()
				close(release)
			}
			done := make(chan struct{})
			go func() { fetcher.Wait(); close(done) }()
			waitCatalogSignal(t, done, "completion to persist")
			var lease *int64
			var status, message string
			var roots, streak int
			if err := f.fixture.QueryRow(f.ctx, `SELECT lease_until_ms,last_status,last_error,last_root_nodes,failure_streak FROM platform_catalog_fetch_config WHERE singleton`).Scan(&lease, &status, &message, &roots, &streak); err != nil {
				t.Fatal(err)
			}
			wantStatus, wantMessage, wantRoots, wantStreak := "failed", "fetch_panicked", 0, 1
			if kind == "process_cancel" {
				wantMessage = "cancelled"
			}
			if kind == "client_disconnect" {
				wantStatus, wantMessage, wantRoots, wantStreak = "ok", "", 7, 0
			}
			if lease != nil || status != wantStatus || message != wantMessage || roots != wantRoots || streak != wantStreak {
				t.Fatalf("completion lease=%v status=%s message=%s roots=%d streak=%d", lease, status, message, roots, streak)
			}
		})
	}
	f.assertClean(t)
}

func TestCatalogFetchClaimCancellationUnblocksShutdown(t *testing.T) {
	f := newAdminContentFixture(t)
	if _, err := f.fixture.Exec(f.ctx, `INSERT INTO platform_catalog_fetch_config(singleton,enabled,next_run_at_ms) VALUES(true,true,1)`); err != nil {
		t.Fatal(err)
	}
	lock, err := f.fixture.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Rollback(f.ctx)
	if _, err := lock.Exec(f.ctx, `SELECT singleton FROM platform_catalog_fetch_config WHERE singleton FOR UPDATE`); err != nil {
		t.Fatal(err)
	}
	processCtx, stop := context.WithCancel(f.ctx)
	defer stop()
	requestCtx, disconnect := context.WithCancel(f.ctx)
	defer disconnect()
	var executed atomic.Bool
	fetcher := &service.Fetcher{Pool: f.runtime, Context: processCtx, Execute: func(context.Context, service.FetchClaim) (service.FetchResult, error) {
		executed.Store(true)
		return service.FetchResult{}, nil
	}}
	defer func() { disconnect(); stop(); lock.Rollback(f.ctx); fetcher.Wait() }()
	result := make(chan error, 1)
	go func() {
		claimed, err := fetcher.Start(requestCtx, false)
		if claimed || err == nil {
			result <- errors.New("blocked claim was accepted after process cancellation")
			return
		}
		result <- err
	}()
	deadline := time.Now().Add(3 * time.Second)
	blocked := false
	for time.Now().Before(deadline) {
		// Observe from the locking transaction, without a second privileged pool connection.
		if _, err := lock.Exec(f.ctx, `SELECT pg_stat_clear_snapshot()`); err != nil {
			t.Fatal(err)
		}
		var count int
		if err := lock.QueryRow(f.ctx, `SELECT count(*) FROM pg_stat_activity WHERE usename='podhub_login_api' AND wait_event_type='Lock' AND query LIKE '%FOR UPDATE%'`).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count > 0 {
			blocked = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !blocked {
		t.Fatal("ordinary-role claim never reached the actual database row lock")
	}
	stop()
	done := make(chan struct{})
	go func() { fetcher.Wait(); close(done) }()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("process cancellation returned %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("process cancellation did not stop the locked claim")
	}
	waitCatalogSignal(t, done, "shutdown while the database row remains locked")
	if requestCtx.Err() != nil || executed.Load() {
		t.Fatal("claim was released by the client or executed after shutdown")
	}
	lock.Rollback(f.ctx)
	f.assertClean(t)
}

func waitCatalogSignal(t *testing.T, signal <-chan struct{}, operation string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(3 * time.Second):
		t.Fatalf("timed out waiting for %s", operation)
	}
}
