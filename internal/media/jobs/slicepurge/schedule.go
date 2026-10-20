// Package slicepurge clears the transit bucket once per day.
//
// The clear runs at a fixed 04:00 Asia/Shanghai (UTC+8, no DST) and has no
// closing window: a PUT signed before the boundary may be deleted by the
// clear, which is expected. The send window stays below the object lifetime,
// so nothing a user can still send depends on it. Receipts live in
// transit_clear_runs.
package slicepurge

import (
	"time"

	"github.com/xxww0098/podhub-go/internal/media/contract"
	"github.com/xxww0098/podhub-go/internal/media/domain/objectkey"
)

var shanghai = contract.Shanghai()

// Buckets is the only physical bucket this job may name. It is one bucket:
// every environment uses its own transit bucket, never a prefix inside one.
var Buckets = []string{contract.BucketName(contract.RoleTransit)}

// Boundary is one clear boundary. A run is due once now is at or after Start
// and the last completed run for that day is older than it.
type Boundary struct {
	Day   time.Time
	Start time.Time
}

// BoundaryAt is the most recent 04:00 Shanghai at or before now. Day is the
// Shanghai calendar date of that boundary.
func BoundaryAt(now time.Time) Boundary {
	start := contract.LastClearBoundary(now)
	local := start.In(shanghai)
	day := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, shanghai)
	return Boundary{Day: day, Start: start}
}

// NextBoundary is the following 04:00 Shanghai.
func NextBoundary(now time.Time) time.Time { return contract.NextClearBoundary(now) }

// Due reports whether today's boundary has been reached and no completed run
// is recorded at or after it.
func Due(now, lastCompleted time.Time) bool {
	return contract.ClearDue(now, lastCompleted)
}

// NextCheck is the wake hint: top of the next minute, or the boundary when it
// is sooner. It only schedules polling; the claim decides whether the run
// starts.
func NextCheck(now time.Time) time.Duration {
	boundary := NextBoundary(now)
	remaining := 60_000 - now.UnixMilli()%60_000
	if remaining < 0 {
		remaining += 60_000
	}
	until := boundary.Sub(now).Milliseconds()
	if until < 1 {
		until = 1
	}
	if remaining < until {
		until = remaining
	}
	return time.Duration(until) * time.Millisecond
}

// KeyCurrent matches the batch generation fence: a key issued before
// notBefore belongs to an older day and is stale.
func KeyCurrent(key string, notBefore time.Time) bool {
	parsed, ok := objectkey.ParseUploadKey(key)
	if !ok {
		return false
	}
	return !time.UnixMilli(parsed.BatchMS).Before(notBefore.UTC())
}
