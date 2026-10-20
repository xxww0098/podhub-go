package service

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/platform/config"
	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

// Options is one worker process's claim loop.
type Options struct {
	Role    string
	Owner   string
	Kinds   []string
	Limit   int
	LaneCap int64
	Config  config.Config
	// Seat means this process is the reconciler and must hold the advisory
	// lock before it claims or scans. A missed seat waits until ctx ends.
	Seat bool
	// Work owns one claimed job, including its jobs-row settlement. Nil
	// keeps Execute, which does not dial. Listing submit sets this.
	Work func(context.Context, *pgxpool.Pool, Claimed) error
	// PrepareScans replaces idle ticks on the seven due scans. Nil leaves
	// every tick idle. The reconciler sets this.
	PrepareScans func([]DueScan)
}

// KindsForRole is the worker split by role. Browser kinds
// are not here; the claim predicate also skips executor browser and http.
func KindsForRole(role string) []string {
	switch role {
	case "listing":
		return []string{"listing.submit", "listing.submit.batch"}
	case "sync":
		return []string{"store.product_sync"}
	case "reconcile":
		return []string{"listing.reconcile", "delegate.posting_sync"}
	default:
		return nil
	}
}

// Run claims, renews, and sweeps until ctx is cancelled.
//
// The job body is Work when set, and Execute otherwise. Execute does not
// dial. A not-ported or writes-disabled result from Execute is requeued
// with admission_unavailable, which withdraws the attempt. Work settles
// the jobs row itself and must return nil after it has done so.
func Run(ctx context.Context, pool *pgxpool.Pool, opts Options) error {
	if opts.Owner == "" {
		opts.Owner = FormatOwner(opts.Role, "")
	}
	if opts.Limit <= 0 {
		opts.Limit = 1
	}
	if opts.LaneCap <= 0 {
		opts.LaneCap = AccountLaneQueuedCostLimit
	}
	if opts.Seat {
		conn, err := pool.Acquire(ctx)
		if err != nil {
			return err
		}
		defer conn.Release()
		ok, err := TrySeat(ctx, conn)
		if err != nil {
			return err
		}
		if !ok {
			slog.Info("reconciler seat is held; this process will not claim or scan")
			<-ctx.Done()
			return nil
		}
		defer func() {
			_, _ = conn.Exec(context.Background(), "SELECT pg_advisory_unlock($1)", ReconcilerAdvisoryLock)
		}()
		scans := Schedules(opts.Config)
		if opts.PrepareScans != nil {
			opts.PrepareScans(scans)
		}
		RunScans(ctx, scans)
		return runLoop(ctx, pool, opts)
	}
	return runLoop(ctx, pool, opts)
}

func runLoop(ctx context.Context, pool *pgxpool.Pool, opts Options) error {
	wake := make(chan struct{}, 1)
	go listenWake(ctx, pool, wake)
	poll := time.NewTicker(WakePollInterval)
	sweep := time.NewTicker(LeaseSweepInterval)
	heart := time.NewTicker(HeartbeatInterval)
	defer poll.Stop()
	defer sweep.Stop()
	defer heart.Stop()
	poke(wake)
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-wake:
			claimReady(ctx, pool, opts)
		case <-poll.C:
			poke(wake)
		case <-sweep.C:
			for _, kind := range opts.Kinds {
				if _, err := ReclaimExpiredRows(ctx, pool, kind); err != nil && ctx.Err() == nil {
					slog.Error("lease sweep", "kind", kind, "err", err)
				}
			}
		case <-heart.C:
			if err := renewOwned(ctx, pool, opts.Owner); err != nil && ctx.Err() == nil {
				slog.Error("lease renew", "err", err)
			}
		}
	}
}

func poke(wake chan struct{}) {
	select {
	case wake <- struct{}{}:
	default:
	}
}

func listenWake(ctx context.Context, pool *pgxpool.Pool, wake chan struct{}) {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		if ctx.Err() == nil {
			slog.Error("listen ozon_jobs_wake", "err", err)
		}
		return
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, "LISTEN "+WakeChannel); err != nil {
		if ctx.Err() == nil {
			slog.Error("listen ozon_jobs_wake", "err", err)
		}
		return
	}
	for ctx.Err() == nil {
		if _, err := conn.Conn().WaitForNotification(ctx); err != nil {
			return
		}
		poke(wake)
	}
}

func claimReady(ctx context.Context, pool *pgxpool.Pool, opts Options) {
	running, err := RunningOwned(ctx, pool, opts.Owner, opts.Kinds)
	if err != nil {
		if ctx.Err() == nil {
			slog.Error("running count", "err", err)
		}
		return
	}
	space := opts.Limit - running
	for _, kind := range opts.Kinds {
		if space <= 0 {
			return
		}
		claimed, err := Claim(ctx, pool, kind, opts.Owner, space)
		if err != nil {
			if ctx.Err() == nil {
				slog.Error("claim", "kind", kind, "err", err)
			}
			return
		}
		for _, job := range claimed {
			finishClaimed(ctx, pool, opts, job)
		}
		space -= len(claimed)
	}
}

func finishClaimed(ctx context.Context, pool *pgxpool.Pool, opts Options, job Claimed) {
	if opts.Work != nil {
		err := opts.Work(ctx, pool, job)
		if err != nil && ctx.Err() == nil {
			slog.Error("job body", "kind", job.Kind, "id", job.ID.String(), "err", err)
			if _, rerr := RequeueJob(ctx, pool, job.Lease(), WorkRequeue(err), 0); rerr != nil {
				slog.Error("requeue", "kind", job.Kind, "id", job.ID.String(), "err", rerr)
			}
		}
		return
	}
	err := Execute(opts.Config, job.Kind)
	if err == nil {
		if _, rerr := Settle(ctx, pool, job.Lease(), StateSucceeded, nil); rerr != nil && ctx.Err() == nil {
			slog.Error("settle", "kind", job.Kind, "id", job.ID.String(), "err", rerr)
		}
		return
	}
	reason := ReasonSafeToRetry
	if NotPorted(err) {
		reason = ReasonAdmissionUnavailable
	} else if ctx.Err() == nil {
		slog.Error("job body", "kind", job.Kind, "id", job.ID.String(), "err", err)
	}
	if _, rerr := RequeueJob(ctx, pool, job.Lease(), reason, 0); rerr != nil && ctx.Err() == nil {
		slog.Error("requeue", "kind", job.Kind, "id", job.ID.String(), "err", rerr)
	}
}

func renewOwned(ctx context.Context, pool *pgxpool.Pool, owner string) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := tenant.EnterWorker(ctx, tx); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE public.jobs
		   SET lease_until = clock_timestamp() + ($2::bigint * interval '1 second'),
		       updated_at = clock_timestamp()
		 WHERE lease_owner = $1 AND state = 'running' AND lease_until > clock_timestamp()`,
		owner, DefaultLeaseSeconds); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
