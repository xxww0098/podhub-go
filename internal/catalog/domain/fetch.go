package domain

import "time"

// Fetch-config constants from the catalog spec. A missing row uses these
// defaults and does not insert.

const (
	FetchAtMinute     = 180
	FetchWindowStart  = 120
	FetchWindowEnd    = 240
	FetchUTCOffset    = 480
	FetchLanguage     = "zh_hans"
	FreshnessSample   = 1000
	CatalogStaleAgeMs = int64(86_400_000)
	CatalogMaxAgeMs   = int64(259_200_000)
)

// FreshnessBand classifies one coordinate age. A SQL NULL fetch time is missing.
func FreshnessBand(fetchedAt *int64, nowMs int64) string {
	if fetchedAt == nil {
		return "missing"
	}
	age := nowMs - *fetchedAt
	switch {
	case age > CatalogMaxAgeMs:
		return "expired"
	case age > CatalogStaleAgeMs:
		return "stale"
	default:
		return "fresh"
	}
}

// FetchRunning is lease_until_ms > now.
func FetchRunning(leaseUntil *int64, now time.Time) bool {
	return leaseUntil != nil && *leaseUntil > now.UnixMilli()
}
