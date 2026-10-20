// Package telemetry prunes client and inbox logs.
//
// error_log_retention in the Rust serve path was not in this workspace
// (无法对照). There is no error_logs table. The head schema's closest rows
// are event_inbox_events and client_listing_logs. The age is a fixed
// argument. This package does not read the environment.
//
// Inbox deletion goes through prune_aged_inbox as podhub_error_prune.
// That function deletes every kind older than the cutoff. The role has no
// DELETE on event_inbox_events and is not BYPASSRLS. client_listing_logs
// still uses the aged delete below, with no level filter.
package telemetry

import (
	"context"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// DefaultLogRetention is 14 days. CLOUD_LOG_RETENTION_DAYS was not read.
const DefaultLogRetention = 14 * 24 * time.Hour

// clientLogPruneSQL is the aged delete for client_listing_logs. It has no
// level predicate. The client-logs route and this delete stay as they were.
const clientLogPruneSQL = `
		DELETE FROM client_listing_logs
		 WHERE received_at < clock_timestamp() - ($1 || ' seconds')::interval`

// pruneRole is the only role allowed to execute prune_aged_inbox.
// It has no DELETE on event_inbox_events. The function body is the age predicate.
const pruneRole = "podhub_error_prune"

// PruneErrorLogs deletes every aged inbox kind through prune_aged_inbox,
// then deletes aged client_listing_logs with the previous statement.
// There is no owner-wide inbox DELETE in this function.
func PruneErrorLogs(ctx context.Context, pool *pgxpool.Pool, olderThan time.Duration) (int64, error) {
	seconds := int64(olderThan / time.Second)
	if seconds < 0 {
		seconds = 0
	}
	inbox, err := pruneInbox(ctx, pool, seconds)
	if err != nil {
		return 0, err
	}
	span := strconv.FormatInt(seconds, 10)
	logs, err := pool.Exec(ctx, clientLogPruneSQL, span)
	if err != nil {
		return inbox, err
	}
	return inbox + logs.RowsAffected(), nil
}

func pruneInbox(ctx context.Context, pool *pgxpool.Pool, seconds int64) (int64, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('role', $1, true)`, pruneRole); err != nil {
		return 0, err
	}
	var deleted int64
	if err := tx.QueryRow(ctx, `SELECT public.prune_aged_inbox($1)`, seconds).Scan(&deleted); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return deleted, nil
}
