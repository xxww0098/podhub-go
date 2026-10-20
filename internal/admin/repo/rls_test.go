package adminrepo

import (
	"context"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go/modules/postgres"

	"github.com/xxww0098/podhub-go/internal/admin/contract"
	"github.com/xxww0098/podhub-go/internal/admin/domain"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

func TestOwnershipStaffRLSAndCash(t *testing.T) {
	pool, ctx := adminParityDB(t)
	const (
		userA = int64(910101)
		userB = int64(910102)
		userS = int64(910103)
	)
	pubA, pubB, pubS := "a910101", "a910102", "a910103"
	seedAdmin(t, ctx, pool, userA, pubA, "admin")
	seedAdmin(t, ctx, pool, userB, pubB, "admin")
	seedAdmin(t, ctx, pool, userS, pubS, "super_admin")
	t.Cleanup(func() { dropAdmins(context.Background(), pool, userA, userB, userS) })

	seedLiveAdminLease(t, ctx, pool)
	repo := New(pool, tenantx.BeginApp)
	actorA := contract.Actor{UserID: userA, Role: "admin"}
	actorB := contract.Actor{UserID: userB, Role: "admin"}
	if _, err := pool.Exec(ctx, `
		INSERT INTO public.sc_sources
		       (source_id, name, country, contact, internal_note, listed, icon,
		        accepts_delegate, view_prefs, created_at_ms, updated_at_ms,
		        created_by_account_uuid)
		VALUES ('src_admin_a1_910101', '隔离印花厂-910101', 'CN', '', '', false, '',
		        false, '{}', 10, 10, $1)`, pubA); err != nil {
		t.Fatal(err)
	}

	if _, err := pool.Exec(ctx, `
		INSERT INTO supplier_wallets (source_id, balance_microfen, held_microfen, updated_at_ms)
		VALUES ('src_admin_a1_910101', 2000000, 1000000, 1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO supplier_withdrawals
		    (source_id, amount_cents, amount_microfen, channel, account, real_name, status, requested_at_ms)
		VALUES ('src_admin_a1_910101', 1, 1000000, 'alipay', 'acct', '名', 'requested', 5)`); err != nil {
		t.Fatal(err)
	}
	bare, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer bare.Rollback(ctx)
	if _, err := bare.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := bare.QueryRow(ctx, `SELECT count(*) FROM supplier_withdrawals`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("missing staff GUC saw %d withdrawals (%v)", n, err)
	}
	if err := bare.QueryRow(ctx, `SELECT count(*) FROM sc_source_members`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("missing staff GUC saw %d members (%v)", n, err)
	}

	grant, token, err := repo.CreateGrant(ctx, actorA, domain.GrantInput{
		Name: "夜班", Actions: []string{"supplier:read"},
	})
	if err != nil || len(token) < 12 || token[:4] != "opa_" || grant.TokenPrefix != token[:12] || grant.SourceIDs != nil || grant.ExpiresAtMs != nil {
		t.Fatalf("grant %+v token %q %v", grant, token, err)
	}
	mine, err := repo.ListGrants(ctx, actorA)
	if err != nil || len(mine) != 1 || mine[0].ID != grant.ID {
		t.Fatalf("own grants %+v %v", mine, err)
	}
	theirs, err := repo.ListGrants(ctx, actorB)
	if err != nil || len(theirs) != 0 {
		t.Fatalf("other grants %+v %v", theirs, err)
	}
	if _, err := repo.RevokeGrant(ctx, actorB, grant.ID); err == nil {
		t.Fatal("other admin revoked the grant")
	}
	if _, err := repo.RevokeGrant(ctx, actorA, grant.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.RevokeGrant(ctx, actorA, grant.ID); err == nil || err.Error() != "授权不存在" {
		t.Fatalf("second revoke %v", err)
	}
}

func seedLiveAdminLease(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	if _, err := pool.Exec(ctx, `DELETE FROM writer_lease_events WHERE lease_id IN (
		SELECT id FROM writer_leases WHERE domain = 'admin' AND revoked_at_ms IS NULL)`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM writer_leases WHERE domain = 'admin' AND revoked_at_ms IS NULL`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO writer_leases (
		    domain, holder, holder_instance, fence_token, granted_at_ms,
		    expires_at_ms, heartbeat_at_ms, grant_reason)
		VALUES ('admin', 'axum', $1, 1, 0,
		        (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint + 600000,
		        (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint, 'admin lease')`,
		fmt.Sprintf("axum-%d", os.Getpid())); err != nil {
		t.Fatal(err)
	}
}

func seedAdmin(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id int64, publicID, role string) {
	t.Helper()
	_, err := pool.Exec(ctx, `
		INSERT INTO account_users (id, public_id, email, password_hash, role, name, target, supplier_id, plan, created_at, updated_at)
		VALUES ($1, $2, $3, 'x', $4, '管理员', '/workspace', '', 'lite', clock_timestamp(), clock_timestamp())`,
		id, publicID, fmt.Sprintf("%s@example.invalid", publicID), role)
	if err != nil {
		t.Fatal(err)
	}
}

func dropAdmins(ctx context.Context, pool *pgxpool.Pool, ids ...int64) {
	_, _ = pool.Exec(ctx, `DELETE FROM automation_grants WHERE user_id = ANY($1)`, ids)
	_, _ = pool.Exec(ctx, `DELETE FROM supplier_wallet_ledger WHERE source_id = 'src_admin_a1_910101'`)
	_, _ = pool.Exec(ctx, `DELETE FROM supplier_withdrawals WHERE source_id = 'src_admin_a1_910101'`)
	_, _ = pool.Exec(ctx, `DELETE FROM supplier_wallets WHERE source_id = 'src_admin_a1_910101'`)
	_, _ = pool.Exec(ctx, `DELETE FROM audit_logs WHERE entity_id IN ('src_admin_a1_910101') OR user_id = ANY($1)`, ids)
	_, _ = pool.Exec(ctx, `DELETE FROM sc_source_prop_defs WHERE source_id = 'src_admin_a1_910101'`)
	_, _ = pool.Exec(ctx, `DELETE FROM sc_sources WHERE source_id = 'src_admin_a1_910101'`)
	_, _ = pool.Exec(ctx, `DELETE FROM account_users WHERE id = ANY($1)`, ids)
}

var (
	adminOnce sync.Once
	adminPool *pgxpool.Pool
	adminErr  error
)

func adminParityDB(t testing.TB) (*pgxpool.Pool, context.Context) {
	t.Helper()
	dsn := os.Getenv("PODHUB_PARITY_DSN")
	if dsn == "" {
		if _, err := os.Stat("/var/run/docker.sock"); err != nil {
			t.Skip("docker daemon is not available")
		}
	}
	adminOnce.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		if dsn == "" {
			container, err := postgres.Run(ctx, "postgres:16-alpine",
				postgres.WithDatabase("podhub"),
				postgres.WithUsername("postgres"),
				postgres.WithPassword("postgres"),
				postgres.BasicWaitStrategies(),
			)
			if err != nil {
				adminErr = err
				return
			}
			dsn, err = container.ConnectionString(ctx, "sslmode=disable")
			if err != nil {
				adminErr = err
				return
			}
		}
		cfg := config.Config{DatabaseURL: dsn}
		if err := cfg.CheckDatabase(); err != nil {
			adminErr = err
			return
		}
		_ = os.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "1")
		pool, err := db.Connect(ctx, cfg)
		if err != nil {
			adminErr = err
			return
		}
		if err := db.Migrate(ctx, pool); err != nil {
			pool.Close()
			adminErr = err
			return
		}
		adminPool = pool
	})
	if adminErr != nil {
		t.Fatal(adminErr)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	t.Cleanup(cancel)
	return adminPool, ctx
}
