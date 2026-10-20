package integration

import (
	"context"
	"fmt"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// seedMatchingLease inserts the one live row Decide accepts for this process.
// An empty writer_leases domain refuses writes. Tests that need a
// successful write call this first.
// granted_at_ms is 0 so a test clock before wall time can heartbeat
// expires_at_ms backward without breaking writer_leases_expiry_after_grant.
func seedMatchingLease(t *testing.T, ctx context.Context, pool *pgxpool.Pool, domain, reason string) {
	t.Helper()
	instance := fmt.Sprintf("axum-%d", os.Getpid())
	if _, err := pool.Exec(ctx, `
		DELETE FROM writer_lease_events
		 WHERE lease_id IN (
		       SELECT id FROM writer_leases
		        WHERE domain = $1 AND revoked_at_ms IS NULL)`, domain); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		DELETE FROM writer_leases WHERE domain = $1 AND revoked_at_ms IS NULL`, domain); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO writer_leases (
		    domain, holder, holder_instance, fence_token, granted_at_ms,
		    expires_at_ms, heartbeat_at_ms, grant_reason)
		VALUES ($1, 'axum', $2, 1,
		        0,
		        (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint + 600000,
		        (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint,
		        $3)`, domain, instance, reason); err != nil {
		t.Fatal(err)
	}
}
