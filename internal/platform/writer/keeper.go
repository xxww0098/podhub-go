package writer

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// Beginner starts one transaction. pgxpool.Pool.Begin satisfies it.
type Beginner func(context.Context) (pgx.Tx, error)

// Renew grants or heartbeats the lease owned by instance.
//
// It only touches a row whose holder is axum and whose holder_instance is the
// caller. A row held by another instance is never revoked here, even when its
// heartbeat has expired: taking over a live writer needs an explicit
// administrative revoke. This keeps a restart from silently splitting writes.
//
// A row owned by the caller is heartbeated even after expiry. The lease was
// already fenced off from writes; extending it is recovery, not a new grant.
func Renew(ctx context.Context, begin Beginner, domain, instance, reason string, nowMS int64) error {
	if !KnownDomain(domain) {
		return fmt.Errorf("writer lease unknown domain %q", domain)
	}
	if instance == "" || reason == "" {
		return fmt.Errorf("writer lease renewal needs an instance and reason")
	}
	if nowMS < 0 {
		nowMS = 0
	}
	tx, err := begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
		return err
	}
	var id int64
	var holder, heldInstance string
	err = tx.QueryRow(ctx, `
		SELECT id, holder, holder_instance
		  FROM writer_leases
		 WHERE domain = $1 AND revoked_at_ms IS NULL
		 FOR UPDATE`, domain).Scan(&id, &holder, &heldInstance)
	if err == nil {
		if holder != HolderAxum || heldInstance != instance {
			return fmt.Errorf("%w: domain %s holder %s instance %s", ErrLeaseHeld, domain, holder, heldInstance)
		}
		if _, err := tx.Exec(ctx, `
			UPDATE writer_leases
			   SET heartbeat_at_ms = $2,
			       expires_at_ms = $2::bigint + $3::bigint
			 WHERE id = $1`, id, nowMS, LeaseTTLMS); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	id, err = grantLease(ctx, tx, domain, instance, reason, nowMS)
	if err != nil {
		return err
	}
	if err := writeGrantEvent(ctx, tx, id, domain, instance, reason, nowMS); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// RenewAll renews every domain and returns all failures. One held domain does
// not stop the other domains from renewing.
func RenewAll(ctx context.Context, begin Beginner, instance, reason string, nowMS int64) error {
	var errs []error
	for _, domain := range leaseDomains {
		if err := Renew(ctx, begin, domain, instance, reason, nowMS); err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", domain, err))
		}
	}
	return errors.Join(errs...)
}

// Status is one domain's current live lease. Present is false when the domain
// has never been granted or its last row was revoked.
type Status struct {
	Domain      string
	Present     bool
	Holder      string
	Instance    string
	FenceToken  int64
	ExpiresAtMS int64
	HeartbeatMS int64
}

// ReadStatus reads every requested domain through podhub_app. The API login
// role has no direct SELECT on writer_leases; SET ROLE is required.
func ReadStatus(ctx context.Context, pool interface {
	Begin(context.Context) (pgx.Tx, error)
}, domains []string) ([]Status, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
		return nil, err
	}
	out := make([]Status, 0, len(domains))
	for _, domain := range domains {
		var s Status
		s.Domain = domain
		err := tx.QueryRow(ctx, `
			SELECT holder, holder_instance, fence_token, expires_at_ms, heartbeat_at_ms
			  FROM writer_leases
			 WHERE domain = $1 AND revoked_at_ms IS NULL
			 ORDER BY id DESC
			 LIMIT 1`, domain).Scan(&s.Holder, &s.Instance, &s.FenceToken, &s.ExpiresAtMS, &s.HeartbeatMS)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("read writer lease %s: %w", domain, err)
		}
		s.Present = true
		out = append(out, s)
	}
	return out, tx.Commit(ctx)
}
