package queuerepo

import (
	"context"
	"testing"
	"time"
)

func TestClaimAdvancesPastHeadsWithoutDueJobs(t *testing.T) {
	pool, ctx := parityDB(t)
	users := make([]int64, ClaimHeadLimit+1)
	for i := range users {
		users[i] = 96400 + int64(i)
	}
	orgs, _ := seedOrgs(t, ctx, pool, users...)
	t.Cleanup(func() { purgeUsers(context.Background(), pool, users) })
	jobs := make([]NewJob, len(users))
	for i, user := range users {
		jobs[i] = makeJob(orgs[user], user, "store.product_sync", "cursor", `{}`)
		if i < len(users)-1 {
			jobs[i].RunAt = time.Now().Add(time.Hour)
		}
	}
	if _, err := Enqueue(ctx, pool, jobs, 256); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO account_queue_cursor(lane, last_user_id) VALUES ($1, 0) ON CONFLICT (lane) DO UPDATE SET last_user_id = 0`, jobs[0].Kind); err != nil {
		t.Fatal(err)
	}
	claimed, err := Claim(ctx, pool, jobs[0].Kind, "cursor-test", 1)
	if err != nil || len(claimed) != 0 {
		t.Fatalf("first page: %+v %v", claimed, err)
	}
	claimed, err = Claim(ctx, pool, jobs[0].Kind, "cursor-test", 1)
	if err != nil || len(claimed) != 1 || claimed[0].ID != jobs[len(jobs)-1].ID {
		t.Fatalf("second page must reach due job: %+v %v", claimed, err)
	}
	if ok, err := Settle(ctx, pool, claimed[0].Lease(), StateSucceeded, nil); err != nil || !ok {
		t.Fatalf("settle: %v %v", ok, err)
	}
	// The cursor's head has gone; wrapping must still reach an earlier head.
	if _, err := pool.Exec(ctx, `UPDATE jobs SET run_at = clock_timestamp() WHERE id = $1`, jobs[0].ID); err != nil {
		t.Fatal(err)
	}
	claimed, err = Claim(ctx, pool, jobs[0].Kind, "cursor-test", 1)
	if err != nil || len(claimed) != 1 || claimed[0].ID != jobs[0].ID {
		t.Fatalf("wrapped page: %+v %v", claimed, err)
	}
	clearQueue(ctx, pool, users)
	if claimed, err := Claim(ctx, pool, jobs[0].Kind, "cursor-test", 1); err != nil || len(claimed) != 0 {
		t.Fatalf("empty queue: %+v %v", claimed, err)
	}
	jobs[0].RunAt = time.Time{}
	if _, err := Enqueue(ctx, pool, jobs[:1], 256); err != nil {
		t.Fatal(err)
	}
	claimed, err = Claim(ctx, pool, jobs[0].Kind, "cursor-test", 1)
	if err != nil || len(claimed) != 1 || claimed[0].ID != jobs[0].ID {
		t.Fatalf("queue refilled after empty scan: %+v %v", claimed, err)
	}
}
