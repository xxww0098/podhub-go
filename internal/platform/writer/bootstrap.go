package writer

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// ErrLeaseHeld is returned when another instance already holds the domain.
var ErrLeaseHeld = errors.New("writer lease is held by another instance")

// ErrLeaseExpired is returned when this instance holds an expired lease.
// Bootstrap does not revive it; lease recovery must explicitly revoke and grant.
var ErrLeaseExpired = errors.New("writer lease has expired")

// Bootstrap inserts the first live lease for a domain, or returns the live row
// this instance already holds. It does not call Decide: an empty table would
// refuse, and this is the explicit cutover write. A live row for another
// instance is left in place.
func Bootstrap(ctx context.Context, begin func(context.Context) (pgx.Tx, error), domain, instance, reason string, nowMS int64) (int64, error) {
	if domain == "" || instance == "" || reason == "" {
		return 0, fmt.Errorf("writer lease bootstrap needs a domain, instance, and reason")
	}
	if nowMS < 0 {
		nowMS = 0
	}
	tx, err := begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
		return 0, err
	}
	var id int64
	var holder, heldInstance string
	var expiresAt, heartbeatAt int64
	err = tx.QueryRow(ctx, `
		SELECT id, holder, holder_instance, expires_at_ms, heartbeat_at_ms
		  FROM writer_leases
		 WHERE domain = $1 AND revoked_at_ms IS NULL
		 FOR UPDATE`, domain).Scan(&id, &holder, &heldInstance, &expiresAt, &heartbeatAt)
	if err == nil {
		if holder != HolderAxum || heldInstance != instance {
			return 0, fmt.Errorf("%w: domain %s holder %s instance %s", ErrLeaseHeld, domain, holder, heldInstance)
		}
		if expiresAt <= nowMS || heartbeatAt+LeaseTTLMS <= nowMS {
			return 0, fmt.Errorf("%w: domain %s lease %d", ErrLeaseExpired, domain, id)
		}
		if err := tx.Commit(ctx); err != nil {
			return 0, err
		}
		return id, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return 0, err
	}
	err = tx.QueryRow(ctx, `
		INSERT INTO writer_leases
		       (domain, holder, holder_instance, fence_token, granted_at_ms,
		        expires_at_ms, heartbeat_at_ms, revoked_at_ms, grant_reason)
		VALUES ($1, $2, $3, nextval('public.writer_lease_fence_seq'), $4::bigint,
		        $4::bigint + $5::bigint, $4::bigint, NULL, $6)
		RETURNING id`,
		domain, HolderAxum, instance, nowMS, LeaseTTLMS, reason).Scan(&id)
	if err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO writer_lease_events
		       (lease_id, domain, action, holder, holder_instance, fence_token,
		        expected_fence, reason, created_at_ms)
		VALUES ($1, $2, 'grant', $3, $4, (SELECT fence_token FROM writer_leases WHERE id = $1),
		        NULL, $5, $6)`,
		id, domain, HolderAxum, instance, reason, nowMS); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return id, nil
}
