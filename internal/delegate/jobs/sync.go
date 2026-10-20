// Package jobs is the delegate posting sync tick a reconciler can call.
// internal/queue is not modified. Until that wiring exists, Schedules still
// uses its own idle tick.
package jobs

import "context"

// KindPostingSync is the posting-sync queue kind. This package does
// not claim or complete jobs.
const KindPostingSync = "delegate.posting_sync"

// PostingSyncTick is a DelegateSyncScan body. It does not enqueue, does not
// back off, and does not read DELEGATE_SYNC_INTERVAL_MS. The interval stays
// in internal/config, which already parsed it once.
//
// The Rust bucket key is not in db/migrations. Returning no work is the
// honest behavior until that key is confirmed.
func PostingSyncTick(context.Context) (bool, error) {
	return false, nil
}
