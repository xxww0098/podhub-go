package queuerepo

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/xxww0098/podhub-go/internal/queue/domain"
)

func TestMutateRunningRejectsLostLeaseBeforeCallback(t *testing.T) {
	pool, ctx := parityDB(t)
	orgs, users := seedOrgs(t, ctx, pool, 96301)
	t.Cleanup(func() { purgeUsers(context.Background(), pool, users) })
	job := makeJob(orgs[96301], 96301, "listing.submit", "fence", `{}`)
	if _, err := Enqueue(ctx, pool, []NewJob{job}, 256); err != nil {
		t.Fatal(err)
	}
	claimed, err := Claim(ctx, pool, job.Kind, "fence-test", 1)
	if err != nil || len(claimed) != 1 {
		t.Fatalf("claim: %+v %v", claimed, err)
	}
	lease := claimed[0].Lease()
	called := false
	ok, err := MutateRunning(ctx, pool, lease, func(context.Context, pgx.Tx) error {
		called = true
		return nil
	})
	if err != nil || !ok || !called {
		t.Fatalf("live lease: ok=%v called=%v err=%v", ok, called, err)
	}
	for _, field := range []string{"owner", "epoch", "expiry", "state"} {
		t.Run(field, func(t *testing.T) {
			stale := lease
			switch field {
			case "owner":
				stale.Owner = "another-worker"
			case "epoch":
				stale.Epoch++
			case "expiry":
				if _, err := pool.Exec(ctx, `UPDATE jobs SET lease_until = clock_timestamp() - interval '1 second' WHERE id = $1`, job.ID); err != nil {
					t.Fatal(err)
				}
			case "state":
				if _, err := pool.Exec(ctx, `UPDATE jobs SET state = 'succeeded', lease_until = clock_timestamp() + interval '30 seconds' WHERE id = $1`, job.ID); err != nil {
					t.Fatal(err)
				}
			}
			called := false
			ok, err := MutateRunning(ctx, pool, stale, func(context.Context, pgx.Tx) error {
				called = true
				return nil
			})
			if err != nil || ok || called {
				t.Fatalf("lost lease: ok=%v called=%v err=%v", ok, called, err)
			}
		})
	}
}

func TestExpiredLeaseCannotRenewOrSettle(t *testing.T) {
	pool, ctx := parityDB(t)
	orgs, users := seedOrgs(t, ctx, pool, 96302)
	t.Cleanup(func() { purgeUsers(context.Background(), pool, users) })
	for _, action := range []string{"renew", "settle", "requeue"} {
		t.Run(action, func(t *testing.T) {
			t.Cleanup(func() { clearQueue(context.Background(), pool, users) })
			job := makeJob(orgs[96302], 96302, "store.product_sync", action, `{}`)
			if _, err := Enqueue(ctx, pool, []NewJob{job}, 256); err != nil {
				t.Fatal(err)
			}
			claimed, err := Claim(ctx, pool, job.Kind, "expired-test", 1)
			if err != nil || len(claimed) != 1 || claimed[0].ID != job.ID {
				t.Fatalf("claim: %+v %v", claimed, err)
			}
			if _, err := pool.Exec(ctx, `UPDATE jobs SET lease_until = clock_timestamp() - interval '1 second' WHERE id = $1`, job.ID); err != nil {
				t.Fatal(err)
			}
			var ok bool
			switch action {
			case "renew":
				ok, err = Renew(ctx, pool, claimed[0].Lease())
			case "settle":
				ok, err = Settle(ctx, pool, claimed[0].Lease(), StateSucceeded, nil)
			case "requeue":
				ok, err = RequeueJob(ctx, pool, claimed[0].Lease(), domain.ReasonSafeToRetry, 0)
			}
			if err != nil || ok {
				t.Errorf("expired %s: ok=%v err=%v", action, ok, err)
			}
			var state string
			var livePermit, expired bool
			if err := pool.QueryRow(ctx, `
				SELECT j.state, COALESCE(j.lease_until <= clock_timestamp(), false), p.released_at IS NULL
				  FROM jobs j JOIN execution_permits p ON p.holder_id = j.id::text
				 WHERE j.id = $1`, job.ID).Scan(&state, &expired, &livePermit); err != nil {
				t.Fatal(err)
			}
			if state != "running" || !expired || !livePermit {
				t.Errorf("expired worker changed state=%s expired=%v permit=%v", state, expired, livePermit)
			}
		})
	}
}
