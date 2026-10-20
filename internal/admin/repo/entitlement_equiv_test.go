package adminrepo

import (
	"math"
	"testing"
	"time"
)

// legacyOrgAtLeast0 and legacyRFC3339Millis are the admin/repo bodies before
// they moved to admin/core/repo.
func legacyOrgAtLeast0(orgID int64) int64 {
	if orgID < 0 {
		return 0
	}
	return orgID
}

func legacyRFC3339Millis(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

func TestOrgAtLeast0MatchesLegacy(t *testing.T) {
	for _, n := range []int64{math.MinInt64, -2, -1, 0, 1, 42, math.MaxInt64} {
		if got, want := orgAtLeast0(n), legacyOrgAtLeast0(n); got != want {
			t.Fatalf("%d: got %d want %d", n, got, want)
		}
	}
}

func TestRFC3339MillisMatchesLegacy(t *testing.T) {
	shanghai := time.FixedZone("CST", 8*3600)
	for _, at := range []time.Time{
		{},
		time.Unix(0, 0),
		time.Date(2026, 10, 17, 1, 2, 3, 0, time.UTC),
		time.Date(2026, 10, 17, 1, 2, 3, 999_999_999, time.UTC),
		time.Date(2026, 10, 17, 9, 2, 3, 1_500_000, shanghai),
		time.Date(1969, 12, 31, 23, 59, 59, 123_000_000, time.UTC),
		time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC),
	} {
		if got, want := rfc3339Millis(at), legacyRFC3339Millis(at); got != want {
			t.Fatalf("%v: got %q want %q", at, got, want)
		}
	}
}
