package contract

import (
	"strings"
	"time"
)

// The transit bucket is the only bucket with a batch key shape. Its objects
// are written by the browser wasm, registered by the upload task, and removed
// by the daily clear. They never enter storage_objects. Key composition lives
// in the service layer, which may reach the objectkey domain.

// TransitObjectLifetime is the maximum time any transit object can exist.
const TransitObjectLifetime = 24 * time.Hour

// ClearTime is the fixed Asia/Shanghai wall clock at which the transit bucket
// is emptied. There is no closing window before it.
const (
	ClearHour   = 4
	ClearMinute = 0
)

// shanghai is fixed UTC+8: China has no daylight saving, so a fixed zone is
// the correct model. It is not derived from the host location.
var shanghai = time.FixedZone("UTC+8", 8*60*60)

// Shanghai returns the fixed UTC+8 zone.
func Shanghai() *time.Location { return shanghai }

// LastClearBoundary is the most recent 04:00 Shanghai at or before now.
func LastClearBoundary(now time.Time) time.Time {
	local := now.In(shanghai)
	boundary := time.Date(local.Year(), local.Month(), local.Day(), ClearHour, ClearMinute, 0, 0, shanghai)
	if boundary.After(now) {
		boundary = boundary.AddDate(0, 0, -1)
	}
	return boundary.UTC()
}

// NextClearBoundary is the following 04:00 Shanghai.
func NextClearBoundary(now time.Time) time.Time {
	return LastClearBoundary(now).Add(24 * time.Hour)
}

// ClearDue reports whether the boundary has been reached and the bucket has
// not yet recorded a completed run for that day. lastCompleted is the zero
// time when no run has ever completed.
func ClearDue(now, lastCompleted time.Time) bool {
	return LastClearBoundary(now).After(lastCompleted)
}

// PublicURL joins the exact public host and the key. Keys already carry the
// environment prefix; the prefix is never added twice.
func PublicURL(role Role, key string) string {
	host := PublicHost(role)
	if host == "" || strings.TrimSpace(key) == "" {
		return ""
	}
	return host + "/" + strings.TrimLeft(key, "/")
}
