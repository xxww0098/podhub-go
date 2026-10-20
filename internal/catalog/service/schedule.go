package service

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/platform/db"
)

// NextFixed is the next clock time at atMinute in the offset zone, strictly
// after now. atMinute is minutes after local midnight, 0..1439. offsetMin is
// the zone's minutes east of UTC. This is the fixed schedule only. Random
// mode is not drawn here; the tick pins it to window_start_minute.
func NextFixed(atMinute, offsetMin int, now time.Time) time.Time {
	if atMinute < 0 {
		atMinute = 0
	}
	if atMinute > 1439 {
		atMinute = 1439
	}
	loc := time.FixedZone("catalog", offsetMin*60)
	local := now.In(loc)
	candidate := time.Date(local.Year(), local.Month(), local.Day(), atMinute/60, atMinute%60, 0, 0, loc)
	if !candidate.After(now) {
		candidate = candidate.Add(24 * time.Hour)
	}
	return candidate
}

// TickFetch advances platform_catalog_fetch_config when it is enabled and due.
// It writes next_run_at_ms, clears the lease, and sets last_error to
// fetch_not_ported. It does not change last_status or failure_streak, and it
// does not dial. A missing row is idle. Random mode uses window_start_minute
// because the Rust RNG was not read (无法对照).
func TickFetch(ctx context.Context, pool *pgxpool.Pool, now time.Time) (bool, error) {
	var fired bool
	// platform_catalog_fetch_config has no org_id and no tenant RLS, but its
	// grants are on podhub_app. The API login role has INHERIT FALSE
	// membership, so it must enter the role inside the transaction.
	err := db.InTx(ctx, pool, db.AppRole(), func(tx pgx.Tx) error {
		var err error
		fired, err = tickFetchInTx(ctx, tx, now)
		return err
	})
	if err != nil {
		return false, err
	}
	return fired, nil
}

func tickFetchInTx(ctx context.Context, tx pgx.Tx, now time.Time) (bool, error) {
	var enabled bool
	var mode string
	var atMinute, windowStart, offset int
	var next, lease *int64
	err := tx.QueryRow(ctx, `
		SELECT enabled, schedule_mode, at_minute, window_start_minute, utc_offset_minutes,
		       next_run_at_ms, lease_until_ms
		  FROM platform_catalog_fetch_config
		 WHERE singleton`).Scan(&enabled, &mode, &atMinute, &windowStart, &offset, &next, &lease)
	if err == pgx.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !enabled {
		return false, nil
	}
	nowMS := now.UnixMilli()
	if next != nil && *next > nowMS {
		return false, nil
	}
	if lease != nil && *lease > nowMS {
		return false, nil
	}
	minute := atMinute
	if mode == "random" {
		minute = windowStart
	}
	due := NextFixed(minute, offset, now).UnixMilli()
	tag, err := tx.Exec(ctx, `
		UPDATE platform_catalog_fetch_config
		   SET next_run_at_ms = $1,
		       lease_until_ms = NULL,
		       last_error = 'fetch_not_ported',
		       updated_at = clock_timestamp()
		 WHERE singleton
		   AND enabled
		   AND (next_run_at_ms IS NULL OR next_run_at_ms <= $2)
		   AND (lease_until_ms IS NULL OR lease_until_ms <= $2)`, due, nowMS)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}
