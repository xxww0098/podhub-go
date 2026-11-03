// Command devlease keeps every writer_leases domain held by this dev instance.
//
// The API refuses a write when its domain has no live lease for
// CLOUD_INSTANCE_ID (internal/platform/writer). A lease lasts 60s and only a
// write renews it, so an idle local database loses every lease, and a restart
// without a pinned instance id never matches the old rows. This command takes
// over the domains for the local instance and renews them until it is stopped.
//
// Local only: it revokes leases held by any other instance. It is not built
// into the image; production grants go through `writer-lease bootstrap`.
// Usage: go run ./scripts/devlease [-once]
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/writer"
)

// domains is every value writer_leases_domain_known accepts.
var domains = writer.Domains()

const (
	reason   = "dev lease"
	interval = 20 * time.Second
)

type begin func(context.Context) (pgx.Tx, error)

func main() {
	once := flag.Bool("once", false, "renew once and exit")
	flag.Parse()

	cfg := config.Load()
	if cfg.DatabaseURL == "" {
		fmt.Fprintln(os.Stderr, "devlease: DATABASE_URL is empty")
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	pool, err := db.Connect(ctx, cfg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "devlease: connect: %v\n", err)
		os.Exit(1)
	}
	defer pool.Close()

	instance := cfg.WriterInstanceID()
	if err := renewAll(ctx, pool.Begin, instance); err != nil {
		fmt.Fprintf(os.Stderr, "devlease: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("devlease: holding %d domains as %s\n", len(domains), instance)
	if *once {
		return
	}
	tick := time.NewTicker(interval)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			if err := renewAll(ctx, pool.Begin, instance); err != nil && ctx.Err() == nil {
				fmt.Fprintf(os.Stderr, "devlease: %v\n", err)
			}
		}
	}
}

func renewAll(ctx context.Context, b begin, instance string) error {
	for _, domain := range domains {
		if err := renew(ctx, b, domain, instance); err != nil {
			return fmt.Errorf("%s: %w", domain, err)
		}
	}
	return nil
}

// renew leaves exactly one live row for domain, held by instance with a fresh
// heartbeat. A foreign or expired row is revoked first (with its event), then
// Bootstrap inserts the new grant when no live row remains.
func renew(ctx context.Context, b begin, domain, instance string) error {
	now := time.Now().UnixMilli()
	if err := revokeStale(ctx, b, domain, instance, now); err != nil {
		return err
	}
	if _, err := writer.Bootstrap(ctx, b, domain, instance, reason, now); err != nil {
		return err
	}
	return heartbeat(ctx, b, domain, instance, now)
}

func revokeStale(ctx context.Context, b begin, domain, instance string, now int64) error {
	tx, err := b(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
		return err
	}
	var id, fence, expiresAt, heartbeatAt int64
	var holder, held string
	err = tx.QueryRow(ctx, `
		SELECT id, holder, holder_instance, fence_token, expires_at_ms, heartbeat_at_ms
		  FROM writer_leases
		 WHERE domain = $1 AND revoked_at_ms IS NULL
		 FOR UPDATE`, domain).Scan(&id, &holder, &held, &fence, &expiresAt, &heartbeatAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	live := expiresAt > now && heartbeatAt+writer.LeaseTTLMS > now
	if holder == writer.HolderAxum && held == instance && live {
		return nil
	}
	if _, err := tx.Exec(ctx, `UPDATE writer_leases SET revoked_at_ms = $2 WHERE id = $1 AND revoked_at_ms IS NULL`, id, now); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO writer_lease_events
		       (lease_id, domain, action, holder, holder_instance, fence_token,
		        expected_fence, reason, created_at_ms)
		VALUES ($1, $2, 'revoke', $3, $4, $5, NULL, $6, $7)`,
		id, domain, holder, held, fence, reason, now); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func heartbeat(ctx context.Context, b begin, domain, instance string, now int64) error {
	tx, err := b(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `
		UPDATE writer_leases
		   SET heartbeat_at_ms = $3::bigint, expires_at_ms = $3::bigint + $4::bigint
		 WHERE domain = $1 AND holder = $5 AND holder_instance = $2 AND revoked_at_ms IS NULL`,
		domain, instance, now, writer.LeaseTTLMS, writer.HolderAxum)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return fmt.Errorf("heartbeat updated %d rows", tag.RowsAffected())
	}
	return tx.Commit(ctx)
}
