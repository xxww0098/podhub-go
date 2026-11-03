package service

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/writer"
)

var (
	ErrFetchRunning     = errors.New("catalog fetch already running")
	ErrNoFetchKey       = errors.New("no_available_key")
	ErrFetchUnavailable = errors.New("fetch_unavailable")
	ErrFetchLeaseLost   = errors.New("catalog fetch lease lost")
	errFetchPanicked    = errors.New("fetch_panicked")
)

// maxErrorMessage bounds what a completed run writes to last_error.
const maxErrorMessage = 500

const fetchLease = 90 * time.Second

// Fetcher is shared by manual requests and the process's scheduled timer.
type Fetcher struct {
	Pool    *pgxpool.Pool
	Execute FetchWork
	Context context.Context
	Now     func() time.Time
	wg      sync.WaitGroup
	mu      sync.Mutex
	closed  bool
}

func (f *Fetcher) now() time.Time {
	if f.Now != nil {
		return f.Now()
	}
	return time.Now()
}
func (f *Fetcher) Wait() { f.mu.Lock(); f.closed = true; f.mu.Unlock(); f.wg.Wait() }

// Work follows the process lifetime after its claim commits, not the browser.
func (f *Fetcher) Start(ctx context.Context, manual bool) (bool, error) {
	if f == nil || f.Pool == nil || f.Execute == nil {
		return false, ErrFetchUnavailable
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return false, ErrFetchUnavailable
	}
	parent := f.Context
	if parent == nil {
		parent = context.Background()
	}
	if err := parent.Err(); err != nil {
		return false, err
	}
	claimCtx, cancelClaim := context.WithCancel(ctx)
	stop := context.AfterFunc(parent, cancelClaim)
	defer func() { stop(); cancelClaim() }()
	claim, claimed, err := f.claim(claimCtx, manual)
	if err != nil || !claimed {
		return false, err
	}
	f.wg.Add(1)
	go func() { defer f.wg.Done(); f.run(parent, claim) }()
	return true, nil
}

func (f *Fetcher) claim(ctx context.Context, manual bool) (FetchClaim, bool, error) {
	var claim FetchClaim
	claimed := false
	err := db.InTx(ctx, f.Pool, db.AppRole(), func(tx pgx.Tx) error {
		defer writer.Forget(tx)
		now := f.now()
		nowMS := now.UnixMilli()
		var scheduled bool
		var pinned, active *int64
		preflight := tx.QueryRow(ctx, `SELECT enabled,next_run_at_ms,lease_until_ms FROM platform_catalog_fetch_config WHERE singleton`).Scan(&scheduled, &pinned, &active)
		if errors.Is(preflight, pgx.ErrNoRows) {
			if manual {
				return ErrNoFetchKey
			}
			return nil
		}
		if preflight != nil {
			return preflight
		}
		if !manual && !scheduled && active == nil {
			return nil
		}
		if active != nil && *active > nowMS {
			if manual {
				return ErrFetchRunning
			}
			return nil
		}
		if !manual && active == nil && pinned != nil && *pinned > nowMS {
			return nil
		}
		if _, err := writer.Assert(ctx, tx, "admin", writer.ProcessIdentity(), nowMS, "类目抓取写入未启用"); err != nil {
			return err
		}
		var enabled bool
		var mode string
		var at, start, end, offset int
		var next, lease *int64
		err := tx.QueryRow(ctx, `SELECT enabled,schedule_mode,at_minute,window_start_minute,window_end_minute,utc_offset_minutes,next_run_at_ms,lease_until_ms,lease_epoch FROM platform_catalog_fetch_config WHERE singleton FOR UPDATE`).Scan(&enabled, &mode, &at, &start, &end, &offset, &next, &lease, &claim.Epoch)
		if errors.Is(err, pgx.ErrNoRows) {
			if manual {
				return ErrNoFetchKey
			}
			return nil
		}
		if err != nil {
			return err
		}
		if !manual && !enabled && lease == nil {
			return nil
		}
		if lease != nil && *lease > nowMS {
			if manual {
				return ErrFetchRunning
			}
			return nil
		}
		abandoned := lease != nil
		if !manual && !abandoned && next != nil && *next > nowMS {
			return nil
		}
		if manual {
			var available bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM platform_catalog_fetch_keys WHERE disabled_at_ms IS NULL AND api_key_nonce IS NOT NULL AND api_key_ciphertext IS NOT NULL)`).Scan(&available); err != nil {
				return err
			}
			if !available {
				return ErrNoFetchKey
			}
		}
		initial := next == nil && !abandoned
		if enabled {
			var due time.Time
			if mode == "random" {
				due, err = NextRandom(start, end, offset, now, !initial)
			} else {
				due = NextFixed(at, offset, now)
			}
			if err != nil {
				return err
			}
			v := due.UnixMilli()
			next = &v
		} else {
			next = nil
		}
		if !manual && initial {
			_, err := tx.Exec(ctx, `UPDATE platform_catalog_fetch_config SET next_run_at_ms=$1 WHERE singleton`, next)
			return err
		}
		claim.StartedAt = nowMS
		err = tx.QueryRow(ctx, `UPDATE platform_catalog_fetch_config SET lease_epoch=lease_epoch+1,lease_until_ms=$1,next_run_at_ms=$2,updated_at=clock_timestamp() WHERE singleton RETURNING lease_epoch`, now.Add(fetchLease).UnixMilli(), next).Scan(&claim.Epoch)
		claimed = err == nil
		return err
	})
	return claim, claimed, err
}

// Hold the config row while a cache transaction commits its epoch's output.
func AssertFetchClaim(ctx context.Context, tx pgx.Tx, claim FetchClaim, now time.Time) error {
	if _, err := writer.Assert(ctx, tx, "admin", writer.ProcessIdentity(), now.UnixMilli(), "类目抓取写入未启用"); err != nil {
		return err
	}
	var valid bool
	err := tx.QueryRow(ctx, `SELECT lease_epoch=$1 AND COALESCE(lease_until_ms>$2,false) FROM platform_catalog_fetch_config WHERE singleton FOR SHARE`, claim.Epoch, now.UnixMilli()).Scan(&valid)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && !valid {
		return ErrFetchLeaseLost
	}
	return err
}

func (f *Fetcher) renew(ctx context.Context, claim FetchClaim) error {
	return db.InTx(ctx, f.Pool, db.AppRole(), func(tx pgx.Tx) error {
		defer writer.Forget(tx)
		if _, err := writer.Assert(ctx, tx, "admin", writer.ProcessIdentity(), f.now().UnixMilli(), "类目抓取写入未启用"); err != nil {
			return err
		}
		now := f.now()
		tag, err := tx.Exec(ctx, `UPDATE platform_catalog_fetch_config SET lease_until_ms=$1 WHERE singleton AND lease_epoch=$2 AND lease_until_ms>$3`, now.Add(fetchLease).UnixMilli(), claim.Epoch, now.UnixMilli())
		if err == nil && tag.RowsAffected() != 1 {
			return ErrFetchLeaseLost
		}
		return err
	})
}

func (f *Fetcher) run(parent context.Context, claim FetchClaim) {
	ctx, cancel := context.WithTimeout(parent, 20*time.Minute)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(20 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if f.renew(ctx, claim) != nil {
					cancel()
					return
				}
			}
		}
	}()
	var result FetchResult
	var workErr error
	defer func() {
		if recover() != nil {
			workErr = errFetchPanicked
		}
		cancel()
		<-done
		finishCtx, stop := context.WithTimeout(context.WithoutCancel(parent), 5*time.Second)
		defer stop()
		if err := f.finish(finishCtx, claim, result, workErr); err != nil && !errors.Is(err, ErrFetchLeaseLost) {
			slog.Error("catalog fetch completion", "err", err)
		}
	}()
	result, workErr = f.Execute(ctx, claim)
	if workErr == nil && ctx.Err() != nil {
		workErr = ctx.Err()
	}
}

func (f *Fetcher) finish(ctx context.Context, claim FetchClaim, result FetchResult, workErr error) error {
	status, message := fetchOutcome(workErr)
	duration := f.now().UnixMilli() - claim.StartedAt
	if duration < 0 {
		duration = 0
	}
	return db.InTx(ctx, f.Pool, db.AppRole(), func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `UPDATE platform_catalog_fetch_config SET lease_until_ms=NULL,last_run_at_ms=$1,last_status=$2::varchar,last_error=$3,last_duration_ms=$4,last_root_nodes=$5,last_key_client_id=NULLIF($6,''),last_key_attempts=$7,failure_streak=CASE WHEN $2::varchar = 'ok' THEN 0 ELSE LEAST(failure_streak::bigint+1,2147483647)::integer END,updated_at=clock_timestamp() WHERE singleton AND lease_epoch=$8 AND lease_until_ms IS NOT NULL`, claim.StartedAt, status, message, duration, result.RootNodes, result.ClientID, result.KeyAttempts, claim.Epoch)
		if err == nil && tag.RowsAffected() != 1 {
			return ErrFetchLeaseLost
		}
		return err
	})
}

// fetchOutcome turns a run's work error into the stored receipt.
func fetchOutcome(workErr error) (status, message string) {
	if workErr == nil {
		return "ok", ""
	}
	status = "failed"
	switch {
	case errors.Is(workErr, ErrNoFetchKey):
		message = "no_available_key"
	case errors.Is(workErr, ErrFetchLeaseLost):
		message = "lease_lost"
	case errors.Is(workErr, context.Canceled):
		message = "cancelled"
	case errors.Is(workErr, context.DeadlineExceeded):
		message = "fetch_timeout"
	case errors.Is(workErr, errFetchPanicked):
		message = "fetch_panicked"
	default:
		message = workErr.Error()
	}
	return status, clampMessage(message)
}

func clampMessage(message string) string {
	runes := []rune(message)
	if len(runes) <= maxErrorMessage {
		return message
	}
	return string(runes[:maxErrorMessage])
}
