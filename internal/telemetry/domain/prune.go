package domain

import "time"

// ErrorClassKinds are the inbox kinds the hourly digest projects.
// Prune deletes every aged kind, not only this list.
var ErrorClassKinds = []string{
	"desktop_error_log.v1",
	"desktop_error_log.v2",
	"desktop_error_log.v3",
	"desktop_error_log.v4",
	"error_feedback.v1",
}

// BillingClassKinds are usage events stored in the inbox. Aged rows of these
// kinds are deleted with every other kind. The digest does not project them.
var BillingClassKinds = []string{
	"billing.ai-token-usage.v1",
	"billing.object-upload-usage.v1",
}

// IsErrorClass reports whether kind is projected into error_digest.
func IsErrorClass(kind string) bool {
	for _, item := range ErrorClassKinds {
		if item == kind {
			return true
		}
	}
	return false
}

// RustPruneDeletes is the aged-inbox predicate this port matched before the
// allow-list: every kind with received < now-olderThan. The cutoff is strict.
func RustPruneDeletes(kind string, received, now time.Time, olderThan time.Duration) bool {
	_ = kind
	if olderThan < 0 {
		olderThan = 0
	}
	return received.Before(now.Add(-olderThan))
}

// GoPruneDeletes matches RustPruneDeletes. Every kind is deleted once
// received is strictly before now-olderThan, including billing kinds and
// unknown kinds. A row at the cutoff stays.
func GoPruneDeletes(kind string, received, now time.Time, olderThan time.Duration) bool {
	return RustPruneDeletes(kind, received, now, olderThan)
}
