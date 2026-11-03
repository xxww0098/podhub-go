package integration

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/automation/domain"
	automationrepo "github.com/xxww0098/podhub-go/internal/automation/repo"
	automationsvc "github.com/xxww0098/podhub-go/internal/automation/service"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

func TestAutomationClaimCannotOutliveRuntimeDeregistration(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	user, org := seedAutomationOwner(t, ctx, pool, "rt-race")
	repo := automationrepo.New(pool, tenantx.BeginApp)
	service := automationsvc.New(repo, nil, nil)
	grant, _, err := service.CreateGrant(ctx, user, org, "owner", domain.ScopeWorkspace, "runtime-race", []string{"read", "prepare"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	runtime, _, err := service.RegisterRuntime(ctx, org, user, grant.ID, "original runtime", "render-v1")
	if err != nil {
		t.Fatal(err)
	}
	replacement, _, err := service.RegisterRuntime(ctx, org, user, grant.ID, "replacement runtime", "render-v1")
	if err != nil {
		t.Fatal(err)
	}
	var command string
	if err := pool.QueryRow(ctx, `INSERT INTO browser_commands(org_id,user_id,grant_id,client_request_id,action,payload)
		VALUES($1,$2,$3::uuid,'runtime-race','listing_prepare','{}') RETURNING id::text`, org, user, grant.ID).Scan(&command); err != nil {
		t.Fatal(err)
	}
	blocker, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(ctx)
	if _, err := blocker.Exec(ctx, `SELECT 1 FROM automation_runtimes WHERE id=$1::uuid FOR UPDATE`, runtime.ID); err != nil {
		t.Fatal(err)
	}
	deregistered := make(chan error, 1)
	go func() {
		_, err := repo.DeregisterRuntime(ctx, org, user, runtime.ID)
		deregistered <- err
	}()
	waitAutomationRuntimeWriters(t, ctx, pool, 1)
	type result struct {
		commands []domain.Claimed
		err      error
	}
	claimed := make(chan result, 1)
	go func() {
		commands, err := repo.Claim(ctx, org, user, runtime.ID, 1)
		claimed <- result{commands, err}
	}()
	waitAutomationRuntimeWriters(t, ctx, pool, 2)
	if err := blocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-deregistered; err != nil {
		t.Fatal(err)
	}
	got := <-claimed
	if got.err != nil || len(got.commands) != 0 {
		t.Errorf("deregistered runtime received commands: %+v err=%v", got.commands, got.err)
	}
	var state string
	var holder *string
	if err := pool.QueryRow(ctx, `SELECT status,claimed_by::text FROM browser_commands WHERE id=$1::uuid`, command).Scan(&state, &holder); err != nil {
		t.Fatal(err)
	}
	if state != "queued" || holder != nil {
		t.Errorf("command stranded on deregistered runtime: status=%s holder=%v", state, holder)
	}
	next, err := repo.Claim(ctx, org, user, replacement.ID, 1)
	if err != nil || len(next) != 1 || next[0].OperationID != command {
		t.Fatalf("replacement runtime could not claim command: %+v err=%v", next, err)
	}
}

func waitAutomationRuntimeWriters(t *testing.T, ctx context.Context, pool *pgxpool.Pool, count int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var waiting int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity
			WHERE datname=current_database() AND wait_event_type='Lock'
			  AND query LIKE '%automation_runtimes%'`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting == count {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("runtime writers did not reach lock: %d/%d", waiting, count)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
