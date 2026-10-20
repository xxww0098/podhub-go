package db

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// grantRiverRuntime must run after River migrations, including on existing
// installations. The login roles are NOINHERIT and River uses the pool directly,
// without the SET LOCAL ROLE used by business transactions. Grant only River's
// runtime objects directly; never inherit the business worker role here.
func grantRiverRuntime(ctx context.Context, pool interface {
	Begin(context.Context) (pgx.Tx, error)
}) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("River runtime grants: %w", err)
	}
	defer tx.Rollback(ctx)
	// Explicit schema, objects and identities: no search_path interpolation,
	// broad/default grants, migration-table access, or DDL privileges. Missing
	// roles or objects fail the transaction rather than silently skipping a grant.
	for _, statement := range []string{
		`GRANT USAGE ON SCHEMA public TO podhub_login_listing_worker, podhub_login_ai_media_worker, podhub_login_reconciler`,
		`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.river_job, public.river_queue, public.river_leader TO podhub_login_listing_worker, podhub_login_ai_media_worker, podhub_login_reconciler`,
		`GRANT USAGE ON SEQUENCE public.river_job_id_seq TO podhub_login_listing_worker, podhub_login_ai_media_worker, podhub_login_reconciler`,
	} {
		if _, err := tx.Exec(ctx, statement); err != nil {
			return fmt.Errorf("River runtime grants: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("River runtime grants: %w", err)
	}
	return nil
}
