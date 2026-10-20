// Package jobs is the error_log_retention hook.
// Rust runs it from spawn_background_work. This process does not delete:
// the retention predicate was not in the migration, which only adds an index.
package jobs

import (
	"context"

	"github.com/xxww0098/podhub-go/internal/telemetry/contract"
)

// Result is the retention pass. Deleted stays zero until the predicate is proven.
type Result struct {
	Deleted int
}

// Run is safe to call from a worker assembly point. It does not open a
// transaction and does not modify event_inbox_events.
func Run(context.Context) (Result, error) {
	return Result{}, contract.ErrNotPorted
}
