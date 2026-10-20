package domain

import "time"

// SampleRetention is how long a live sample_description is kept.
// The existing River periodic job podhub.error_digest blanks a sample
// once last_seen_at is strictly older than now minus this duration.
// occurrences, first_seen_at, and last_seen_at stay. docs_seed is the
// documented code list, not a live sample, and is not blanked.
const SampleRetention = 180 * 24 * time.Hour

// SampleCutoff is the instant a live sample must be strictly before
// in order to be blanked. A last_seen_at equal to the cutoff stays.
func SampleCutoff(now time.Time) time.Time {
	return now.UTC().Add(-SampleRetention)
}

// SampleExpired reports whether lastSeen is strictly before the cutoff.
func SampleExpired(lastSeen, now time.Time) bool {
	return lastSeen.Before(SampleCutoff(now))
}
