package integration

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	dbschema "github.com/xxww0098/podhub-go/db"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/tests/testkit"
)

func TestWorkspaceInvitationNotificationMigration(t *testing.T) {
	if !testkit.DockerAvailable() {
		t.Skip("docker daemon is not available")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	dsn, stop, err := testkit.StartPostgres(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	goose.SetBaseFS(dbschema.Migrations)
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	sqlDB := stdlib.OpenDBFromPool(pool)
	if err := goose.UpToContext(ctx, sqlDB, "migrations", 40); err != nil {
		t.Fatal(err)
	}
	_ = sqlDB.Close()
	owner, org, _ := securityOrg(t, ctx, pool, "inv-owner")
	recipient, _, _ := securityOrg(t, ctx, pool, "inv-recipient")
	hxExec(t, ctx, pool, `INSERT INTO org_invitations (org_id,email,role,token_hash,invited_by_user_id,invited_by_email,invitee_user_id,expires_at,created_at,updated_at)
		VALUES ($1,'bound@example.invalid','member','bound',$2,'owner@example.invalid',$3,clock_timestamp()+interval '1 day',clock_timestamp(),clock_timestamp()),
		($1,'unbound@example.invalid','member','unbound',$2,'owner@example.invalid',NULL,clock_timestamp()+interval '1 day',clock_timestamp(),clock_timestamp())`, org, owner, recipient)
	if err := db.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	var boundRevoked, unboundRevoked, tokenColumn bool
	if err := pool.QueryRow(ctx, `SELECT
		(SELECT revoked_at IS NOT NULL FROM org_invitations WHERE email='bound@example.invalid'),
		(SELECT revoked_at IS NOT NULL FROM org_invitations WHERE email='unbound@example.invalid'),
		EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='org_invitations' AND column_name='token_hash')`).Scan(&boundRevoked, &unboundRevoked, &tokenColumn); err != nil || boundRevoked || !unboundRevoked || tokenColumn {
		t.Fatalf("migration: bound revoked=%v unbound revoked=%v token column=%v err=%v", boundRevoked, unboundRevoked, tokenColumn, err)
	}
}
