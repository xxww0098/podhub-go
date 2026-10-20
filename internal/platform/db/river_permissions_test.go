package db

import (
	"context"
	"net/url"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	queuejobs "github.com/xxww0098/podhub-go/internal/queue/jobs"
)

func TestRiverRuntimePermissions(t *testing.T) {
	admin, ctx := sessionDB(t)
	// Simulate the legacy install: the schema histories exist, but the
	// NOINHERIT logins cannot access the first table needed during startup.
	if _, err := admin.Exec(ctx, `REVOKE SELECT ON public.river_queue FROM podhub_login_listing_worker, podhub_login_ai_media_worker, podhub_login_reconciler`); err != nil {
		t.Fatal(err)
	}
	// Re-running the unified migration entrypoint must repair it, then be idempotent.
	for range 2 {
		if err := Migrate(ctx, admin); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "")
	for _, role := range []string{"podhub_login_listing_worker", "podhub_login_ai_media_worker", "podhub_login_reconciler"} {
		t.Run(role, func(t *testing.T) {
			loginURL, err := url.Parse(sessionDSN)
			if err != nil {
				t.Fatal(err)
			}
			// Synthetic password is confined to this throwaway test cluster, so
			// the same real-login test also runs with Docker's password auth.
			if _, err := admin.Exec(ctx, "ALTER ROLE "+pgx.Identifier{role}.Sanitize()+" PASSWORD 'river-runtime-test'"); err != nil {
				t.Fatal(err)
			}
			loginURL.User = url.UserPassword(role, "river-runtime-test")
			query := loginURL.Query()
			query.Set("search_path", "pg_catalog")
			loginURL.RawQuery = query.Encode()
			pool, err := Connect(ctx, config.Config{DatabaseURL: loginURL.String()})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(pool.Close)
			var current string
			var privileged bool
			if err := pool.QueryRow(ctx, `SELECT current_user, rolsuper OR rolbypassrls OR rolinherit FROM pg_roles WHERE rolname = current_user`).Scan(&current, &privileged); err != nil {
				t.Fatal(err)
			}
			if current != role || privileged {
				t.Fatalf("unexpected identity %s privileged=%v", current, privileged)
			}
			for _, table := range []string{"river_job", "river_queue", "river_leader"} {
				for _, privilege := range []string{"SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"} {
					var got bool
					if err := pool.QueryRow(ctx, `SELECT has_table_privilege(current_user, $1, $2)`, "public."+table, privilege).Scan(&got); err != nil {
						t.Fatal(err)
					}
					want := privilege == "SELECT" || privilege == "INSERT" || privilege == "UPDATE" || privilege == "DELETE"
					if got != want {
						t.Errorf("%s %s = %v, want %v", table, privilege, got, want)
					}
				}
			}
			for _, table := range []string{"river_migration", "river_notification", "jobs"} {
				var got bool
				if err := pool.QueryRow(ctx, `SELECT has_table_privilege(current_user, $1, 'SELECT,INSERT,UPDATE,DELETE')`, "public."+table).Scan(&got); err != nil {
					t.Fatal(err)
				}
				if got {
					t.Errorf("unexpected direct privilege on %s", table)
				}
			}
			var canCreate, canSetSeq bool
			if err := pool.QueryRow(ctx, `SELECT has_schema_privilege(current_user,'public','CREATE'), has_sequence_privilege(current_user,'public.river_job_id_seq','UPDATE')`).Scan(&canCreate, &canSetSeq); err != nil {
				t.Fatal(err)
			}
			if canCreate || canSetSeq {
				t.Fatalf("unexpected DDL/sequence update: %v %v", canCreate, canSetSeq)
			}
			for range 2 {
				client, err := queuejobs.Start(ctx, pool)
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() {
					stopCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
					defer cancel()
					_ = client.Stop(stopCtx)
				})
				result, err := client.Insert(ctx, queuejobs.NoopArgs{}, nil)
				if err != nil {
					t.Fatal(err)
				}
				deadline := time.Now().Add(10 * time.Second)
				for {
					var state string
					err = pool.QueryRow(ctx, `SELECT state FROM public.river_job WHERE id=$1`, result.Job.ID).Scan(&state)
					if err != nil {
						t.Fatal(err)
					}
					if state == "completed" {
						if _, err := pool.Exec(ctx, `DELETE FROM public.river_job WHERE id=$1`, result.Job.ID); err != nil {
							t.Fatal(err)
						}
						break
					}
					if time.Now().After(deadline) {
						t.Fatalf("job stuck in %s", state)
					}
					time.Sleep(20 * time.Millisecond)
				}
				stopCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				err = client.Stop(stopCtx)
				cancel()
				if err != nil {
					t.Fatal(err)
				}
			}
		})
	}
	for _, role := range []string{"podhub_login_api", "podhub_login_health"} {
		var allowed bool
		if err := admin.QueryRow(ctx, `SELECT has_table_privilege($1,'public.river_job','SELECT,INSERT,UPDATE,DELETE')`, role).Scan(&allowed); err != nil {
			t.Fatal(err)
		}
		if allowed {
			t.Errorf("unexpected River access for %s", role)
		}
	}
	// A shadow object in search_path must never receive the public grants.
	tx, err := admin.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	_, err = tx.Exec(ctx, `CREATE SCHEMA river_grant_shadow; CREATE TABLE river_grant_shadow.river_job(id bigint); SET LOCAL search_path = river_grant_shadow, public`)
	if err != nil {
		t.Fatal(err)
	}
	if err := grantRiverRuntime(ctx, tx); err != nil {
		t.Fatal(err)
	}
	var shadow bool
	if err = tx.QueryRow(ctx, `SELECT has_table_privilege('podhub_login_listing_worker','river_grant_shadow.river_job','SELECT')`).Scan(&shadow); err != nil {
		t.Fatal(err)
	}
	if shadow {
		t.Fatal("shadow table received runtime access")
	}
	// A missing late object must fail, and roll back earlier grants in the batch.
	if _, err := tx.Exec(ctx, `REVOKE SELECT ON public.river_queue FROM podhub_login_listing_worker; ALTER SEQUENCE public.river_job_id_seq RENAME TO river_job_id_seq_missing`); err != nil {
		t.Fatal(err)
	}
	if err := grantRiverRuntime(ctx, tx); err == nil {
		t.Fatal("missing sequence silently accepted")
	}
	var restored bool
	if err := tx.QueryRow(ctx, `SELECT has_table_privilege('podhub_login_listing_worker','public.river_queue','SELECT')`).Scan(&restored); err != nil {
		t.Fatal(err)
	}
	if restored {
		t.Fatal("failed grant batch committed earlier grants")
	}
	if _, err := tx.Exec(ctx, `ALTER SEQUENCE public.river_job_id_seq_missing RENAME TO river_job_id_seq; ALTER ROLE podhub_login_reconciler RENAME TO river_test_missing_login`); err != nil {
		t.Fatal(err)
	}
	if err := grantRiverRuntime(ctx, tx); err == nil {
		t.Fatal("missing login silently accepted")
	}
	if err := tx.QueryRow(ctx, `SELECT has_table_privilege('podhub_login_listing_worker','public.river_queue','SELECT')`).Scan(&restored); err != nil {
		t.Fatal(err)
	}
	if restored {
		t.Fatal("missing login committed partial grants")
	}
}
