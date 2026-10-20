package readhttp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/platform/httpx/jsonwire"
	_ "github.com/xxww0098/podhub-go/internal/queue"
	queuerepo "github.com/xxww0098/podhub-go/internal/queue/repo"
	"github.com/xxww0098/podhub-go/tests/testkit"
)

// TestBrowserClaimHeadLockOrder is the browser batch claim lock-order fix.
// The quota-first sequence deadlocks kernel Claim (40P01) on ai.recognize.
// Head-then-quota does not. Non-concurrent claim results match.
func TestBrowserClaimHeadLockOrder(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Minute)
	defer cancel()
	pool := startClaimDB(t, ctx)

	t.Run("same result without concurrency", func(t *testing.T) {
		testClaimSameResult(t, ctx, pool)
	})
	t.Run("old order deadlocks", func(t *testing.T) {
		testOldOrderDeadlocks(t, ctx, pool)
	})
	t.Run("head then quota", func(t *testing.T) {
		testHeadFirstNoDeadlock(t, ctx, pool)
	})
	t.Run("kernel claim overlaps browser claim", func(t *testing.T) {
		testKernelOverlap(t, ctx, pool)
	})
}

func testClaimSameResult(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	org, owner, row := seedOwner(t, ctx, pool, "cmp")
	other := insertUser(t, ctx, pool, "cmp-q")
	insertMember(t, ctx, pool, org, other, "member", 2)
	if _, err := pool.Exec(ctx, `
		INSERT INTO execution_quota (class, user_id, hard_limit)
		VALUES ('ai_ocr', $1, 0)
		ON CONFLICT (class, user_id) DO UPDATE SET hard_limit = 0`, other); err != nil {
		t.Fatal(err)
	}
	const (
		jobA     = "c1000000-0000-4000-8000-0000000000a1"
		jobF     = "c1000000-0000-4000-8000-0000000000a2"
		jobH     = "c1000000-0000-4000-8000-0000000000a3"
		jobG     = "c1000000-0000-4000-8000-0000000000a4"
		jobLane  = "c1000000-0000-4000-8000-0000000000a5"
		jobB     = "c1000000-0000-4000-8000-0000000000a6"
		jobJ     = "c1000000-0000-4000-8000-0000000000a7"
		jobExtra = "c1000000-0000-4000-8000-0000000000a8"
		missing  = "c1000000-0000-4000-8000-000000000099"
		unknown  = "c1000000-0000-4000-8000-0000000000ff"
	)
	browser := `{"executor":"browser"}`
	insertJob(t, ctx, pool, jobRow{
		id: jobA, org: org, user: owner, row: row, kind: "ai.recognize", lane: "ai.recognize",
		state: "queued", priority: 10, payload: browser,
	})
	insertJob(t, ctx, pool, jobRow{
		id: jobF, org: org, user: other, row: row, kind: "ai.recognize", lane: "ai.recognize",
		state: "queued", priority: 12, payload: browser,
	})
	insertJob(t, ctx, pool, jobRow{
		id: jobH, org: org, user: owner, row: row, kind: "ai.recognize", lane: "ai.recognize",
		state: "retry_wait", priority: 15, payload: browser,
	})
	insertJob(t, ctx, pool, jobRow{
		id: jobG, org: org, user: owner, row: missing, kind: "ai.recognize", lane: "ai.recognize",
		state: "queued", priority: 16, payload: browser,
	})
	insertJob(t, ctx, pool, jobRow{
		id: jobLane, org: org, user: owner, row: row, kind: "ai.recognize", lane: "listing",
		state: "queued", priority: 18, payload: browser,
	})
	insertJob(t, ctx, pool, jobRow{
		id: jobB, org: org, user: owner, row: row, kind: "ai.recognize", lane: "ai.recognize",
		state: "queued", priority: 20, payload: browser,
	})
	uncertain := "uncertain_closed"
	insertJob(t, ctx, pool, jobRow{
		id: jobJ, org: org, user: owner, row: row, kind: "ai.recognize", lane: "ai.recognize",
		state: "queued", priority: 25, attempt: 8, payload: browser, last: &uncertain,
	})
	insertJob(t, ctx, pool, jobRow{
		id: jobExtra, org: org, user: owner, row: row, kind: "ai.recognize", lane: "ai.recognize",
		state: "queued", priority: 30, payload: browser,
	})
	insertJob(t, ctx, pool, jobRow{
		id: "c1000000-0000-4000-8000-0000000000b1", org: org, user: owner, row: row,
		kind: "ai.recognize", lane: "ai.recognize", state: "queued", priority: 40,
		payload: browser, runAt: "2099-01-01 00:00:00+00",
	})
	insertJob(t, ctx, pool, jobRow{
		id: "c1000000-0000-4000-8000-0000000000b2", org: org, user: owner, row: row,
		kind: "ai.recognize", lane: "ai.recognize", state: "running", priority: 1, payload: browser,
	})
	insertJob(t, ctx, pool, jobRow{
		id: "c1000000-0000-4000-8000-0000000000b3", org: org, user: owner, row: row,
		kind: "ai.recognize", lane: "ai.recognize", state: "queued", priority: 2,
		payload: browser, cancel: true,
	})
	insertJob(t, ctx, pool, jobRow{
		id: "c1000000-0000-4000-8000-0000000000b4", org: org, user: owner, row: row,
		kind: "ai.recognize", lane: "ai.recognize", state: "queued", priority: 3,
		attempt: 8, payload: browser,
	})
	insertJob(t, ctx, pool, jobRow{
		id: "c1000000-0000-4000-8000-0000000000b5", org: org, user: owner, row: row,
		kind: "media.render", lane: "media.render", state: "queued", priority: 4, payload: browser,
	})
	insertJob(t, ctx, pool, jobRow{
		id: "c1000000-0000-4000-8000-0000000000b6", org: org, user: owner, row: row,
		kind: "listing.submit", lane: "listing.submit", state: "queued", priority: 5, payload: browser,
	})

	ids := []string{jobA, jobA, jobF, jobH, jobG, jobLane, jobB, jobJ, jobExtra, unknown,
		"c1000000-0000-4000-8000-0000000000b1",
		"c1000000-0000-4000-8000-0000000000b2",
		"c1000000-0000-4000-8000-0000000000b3",
		"c1000000-0000-4000-8000-0000000000b4",
		"c1000000-0000-4000-8000-0000000000b5",
		"c1000000-0000-4000-8000-0000000000b6",
	}
	oldSnap := claimWindowSnap(t, ctx, pool, org, owner, other, ids, "ai.recognize", 16, false)
	newSnap := claimWindowSnap(t, ctx, pool, org, owner, other, ids, "ai.recognize", 16, true)
	if oldSnap.canon != newSnap.canon {
		t.Fatalf("response bytes\nold %s\nnew %s", oldSnap.canon, newSnap.canon)
	}
	if oldSnap.db != newSnap.db {
		t.Fatalf("db snapshot\nold %s\nnew %s", oldSnap.db, newSnap.db)
	}
	wantIDs := []string{jobA, jobH, jobLane, jobB, jobJ, jobExtra}
	if strings.Join(oldSnap.ids, ",") != strings.Join(wantIDs, ",") {
		t.Fatalf("claimed %v", oldSnap.ids)
	}
	for _, item := range oldSnap.claims {
		if item.State != "running" || item.Epoch != 1 || item.LeaseSeconds != 30 {
			t.Fatalf("claim %s state %s epoch %d lease %d", item.ID, item.State, item.Epoch, item.LeaseSeconds)
		}
		wantAttempt := int32(1)
		if item.ID == jobJ {
			wantAttempt = 9
		}
		if item.Attempt != wantAttempt {
			t.Fatalf("attempt %s %d", item.ID, item.Attempt)
		}
	}
	if !strings.Contains(oldSnap.db, ownerText(owner)+" ai.recognize 32 48") {
		t.Fatalf("owner head %s", oldSnap.db)
	}
	if !strings.Contains(oldSnap.db, ownerText(owner)+" listing 0 8") {
		t.Fatalf("listing head %s", oldSnap.db)
	}
	if !strings.Contains(oldSnap.db, ownerText(other)+" ai.recognize 8 0") {
		t.Fatalf("quota head %s", oldSnap.db)
	}
	if !strings.Contains(oldSnap.db, jobF+" queued 0 0 true true") {
		t.Fatalf("quota job %s", oldSnap.db)
	}
	if !strings.Contains(oldSnap.db, jobG+" queued 0 0 true true") {
		t.Fatalf("missing row %s", oldSnap.db)
	}
	if strings.Count(oldSnap.db, "permit ") != 6 {
		t.Fatalf("permits %s", oldSnap.db)
	}

	oneOld := claimWindowSnap(t, ctx, pool, org, owner, other, ids, "ai.recognize", 1, false)
	oneNew := claimWindowSnap(t, ctx, pool, org, owner, other, ids, "ai.recognize", 1, true)
	if oneOld.canon != oneNew.canon || oneOld.db != oneNew.db {
		t.Fatalf("limit 1\n%s\n%s\n%s\n%s", oneOld.canon, oneNew.canon, oneOld.db, oneNew.db)
	}
	if strings.Join(oneOld.ids, ",") != jobA {
		t.Fatalf("limit 1 claimed %v", oneOld.ids)
	}

	emptyBody := `{"jobIds":[],"kind":"ai.recognize","limit":4}`
	mediaBody := `{"jobIds":["c1000000-0000-4000-8000-0000000000b5"],"kind":"media.render","limit":4}`
	h := claimHost(pool, org, owner)
	for _, body := range []string{emptyBody, mediaBody} {
		httpBody := callWindow(h, body).Body.Bytes()
		oldBody := windowBody(t, ctx, pool, org, owner, body, false)
		newBody := windowBody(t, ctx, pool, org, owner, body, true)
		if string(httpBody) != string(oldBody) || string(oldBody) != string(newBody) {
			t.Fatalf("body %s\nhttp %s\nold %s\nnew %s", body, httpBody, oldBody, newBody)
		}
	}
	var aiState, mediaState string
	if err := pool.QueryRow(ctx, `SELECT state FROM jobs WHERE id = $1::uuid`, jobA).Scan(&aiState); err != nil || aiState != "queued" {
		t.Fatalf("ai left %s %v", aiState, err)
	}
	if err := pool.QueryRow(ctx, `SELECT state FROM jobs WHERE id = $1::uuid`, "c1000000-0000-4000-8000-0000000000b5").Scan(&mediaState); err != nil || mediaState != "queued" {
		t.Fatalf("media left %s %v", mediaState, err)
	}
	emptyPage := callWindow(h, emptyBody).Body.String()
	if !strings.Contains(emptyPage, `"queuedCost":72`) || !strings.Contains(emptyPage, `"runningCost":8`) {
		t.Fatal(emptyPage)
	}

	jobOrg, jobUser, jobRowID := seedOwner(t, ctx, pool, "job")
	jobOther := insertUser(t, ctx, pool, "job-q")
	insertMember(t, ctx, pool, jobOrg, jobOther, "member", 2)
	if _, err := pool.Exec(ctx, `
		INSERT INTO execution_quota (class, user_id, hard_limit)
		VALUES ('ai_ocr', $1, 0)
		ON CONFLICT (class, user_id) DO UPDATE SET hard_limit = 0`, jobOther); err != nil {
		t.Fatal(err)
	}
	const (
		okJob      = "c2000000-0000-4000-8000-000000000001"
		missingJob = "c2000000-0000-4000-8000-000000000002"
		mediaJob   = "c2000000-0000-4000-8000-000000000003"
		quotaJob   = "c2000000-0000-4000-8000-000000000004"
	)
	insertJob(t, ctx, pool, jobRow{id: okJob, org: jobOrg, user: jobUser, row: jobRowID, kind: "ai.recognize", lane: "ai.recognize", state: "queued", payload: browser})
	insertJob(t, ctx, pool, jobRow{id: missingJob, org: jobOrg, user: jobUser, row: missing, kind: "ai.recognize", lane: "ai.recognize", state: "queued", payload: browser})
	insertJob(t, ctx, pool, jobRow{id: mediaJob, org: jobOrg, user: jobUser, row: jobRowID, kind: "media.render", lane: "media.render", state: "queued", payload: browser})
	insertJob(t, ctx, pool, jobRow{id: quotaJob, org: jobOrg, user: jobOther, row: jobRowID, kind: "ai.recognize", lane: "ai.recognize", state: "queued", payload: browser})

	okOld := claimJobSnap(t, ctx, pool, jobOrg, jobUser, okJob, false)
	okNew := claimJobSnap(t, ctx, pool, jobOrg, jobUser, okJob, true)
	if okOld.canon != okNew.canon || okOld.db != okNew.db || okOld.quota != okNew.quota || okOld.quota {
		t.Fatalf("single claim\n%s\n%s\n%s\n%s quota %v %v", okOld.canon, okNew.canon, okOld.db, okNew.db, okOld.quota, okNew.quota)
	}
	if !strings.Contains(okOld.db, okJob+" running 1 1 false false") {
		t.Fatalf("single row %s", okOld.db)
	}
	missOld := claimJobSnap(t, ctx, pool, jobOrg, jobUser, missingJob, false)
	missNew := claimJobSnap(t, ctx, pool, jobOrg, jobUser, missingJob, true)
	if missOld.canon != `{"data":null}` || missOld.canon != missNew.canon || missOld.db != missNew.db || missOld.quota || missNew.quota {
		t.Fatalf("missing row claim %s %s %v", missOld.canon, missNew.canon, missOld.quota)
	}
	mediaOld := claimJobSnap(t, ctx, pool, jobOrg, jobUser, mediaJob, false)
	mediaNew := claimJobSnap(t, ctx, pool, jobOrg, jobUser, mediaJob, true)
	if mediaOld.canon != `{"data":null}` || mediaOld.canon != mediaNew.canon || mediaOld.db != mediaNew.db {
		t.Fatalf("media claim %s %s\n%s\n%s", mediaOld.canon, mediaNew.canon, mediaOld.db, mediaNew.db)
	}
	if !strings.Contains(mediaOld.db, mediaJob+" queued 0 0 true true") {
		t.Fatalf("media job changed %s", mediaOld.db)
	}
	goneOld := claimJobSnap(t, ctx, pool, jobOrg, jobUser, unknown, false)
	goneNew := claimJobSnap(t, ctx, pool, jobOrg, jobUser, unknown, true)
	if goneOld.canon != `{"data":null}` || goneOld.canon != goneNew.canon || goneOld.quota || goneNew.quota {
		t.Fatalf("absent %s %s", goneOld.canon, goneNew.canon)
	}
	qOld := claimJobSnap(t, ctx, pool, jobOrg, jobOther, quotaJob, false)
	qNew := claimJobSnap(t, ctx, pool, jobOrg, jobOther, quotaJob, true)
	if !qOld.quota || !qNew.quota || qOld.db != qNew.db || !strings.Contains(qOld.db, quotaJob+" queued 0 0 true true") {
		t.Fatalf("quota rollback %v %v %s", qOld.quota, qNew.quota, qOld.db)
	}

	jh := claimHost(pool, jobOrg, jobUser)
	rec := callClaimJob(jh, okJob)
	if rec.Code != http.StatusOK || canonClaimJSON(rec.Body.Bytes()) != okNew.canon {
		t.Fatalf("handler %d %s vs %s", rec.Code, rec.Body.String(), okNew.canon)
	}
	qh := claimHost(pool, jobOrg, jobOther)
	qrec := callClaimJob(qh, quotaJob)
	const quotaBody = `{"error":"当前用户的执行配额已用尽，请等待现有任务完成或停止后重试","code":"internal"}`
	if qrec.Code != http.StatusTooManyRequests || qrec.Body.String() != quotaBody || qrec.Header().Get("Retry-After") != "5" {
		t.Fatalf("quota http %d %s %s", qrec.Code, qrec.Header().Get("Retry-After"), qrec.Body.String())
	}
	var quotaState string
	if err := pool.QueryRow(ctx, `SELECT state FROM jobs WHERE id = $1::uuid`, quotaJob).Scan(&quotaState); err != nil || quotaState != "queued" {
		t.Fatalf("quota state %s %v", quotaState, err)
	}
	mrec := callClaimJob(jh, mediaJob)
	if mrec.Code != http.StatusOK || mrec.Body.String() != `{"data":null}` {
		t.Fatalf("media http %d %s", mrec.Code, mrec.Body.String())
	}
	if err := pool.QueryRow(ctx, `SELECT state FROM jobs WHERE id = $1::uuid`, mediaJob).Scan(&mediaState); err != nil || mediaState != "queued" {
		t.Fatalf("media http state %s %v", mediaState, err)
	}
}

func testOldOrderDeadlocks(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	org, user, row := seedOwner(t, ctx, pool, "old-win")
	const id = "d1000000-0000-4000-8000-000000000001"
	insertJob(t, ctx, pool, jobRow{
		id: id, org: org, user: user, row: row, kind: "ai.recognize", lane: "ai.recognize",
		state: "queued", payload: `{"executor":"browser"}`,
	})
	holder, pid, release := lockHead(t, ctx, pool, user, "ai.recognize")
	defer release()
	errCh := make(chan error, 1)
	claimCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		tx, err := tenant.BeginApp(claimCtx, pool.Begin, org)
		if err != nil {
			errCh <- err
			return
		}
		defer tx.Rollback(claimCtx)
		req := httptest.NewRequest(http.MethodPost, "/", nil).WithContext(claimCtx)
		_, _, err = runClaimWindow(req, tx, org, user, []string{id}, "ai.recognize", 4, false)
		if err != nil {
			errCh <- err
			return
		}
		errCh <- tx.Commit(claimCtx)
	}()
	waiter := waitLocked(t, ctx, pool, pid)
	if n := advisoryGranted(t, ctx, pool, waiter); n == 0 {
		t.Fatalf("old order waited without the quota lock\n%s", dumpActivity(t, ctx, pool))
	}
	_, holdErr := holder.Exec(ctx, `
		SELECT pg_advisory_xact_lock(hashtextextended('eq-user:' || $1 || ':' || ($2::bigint)::text, 0))`,
		"ai_ocr", user)
	claimErr := waitClaim(t, errCh, cancel)
	if !isDeadlock(holdErr) && !isDeadlock(claimErr) {
		t.Fatalf("old order did not raise 40P01\nholder %v\nclaim %v\n%s", holdErr, claimErr, dumpActivity(t, ctx, pool))
	}

	org2, user2, row2 := seedOwner(t, ctx, pool, "old-one")
	const id2 = "d2000000-0000-4000-8000-000000000001"
	insertJob(t, ctx, pool, jobRow{
		id: id2, org: org2, user: user2, row: row2, kind: "ai.recognize", lane: "ai.recognize",
		state: "queued", payload: `{"executor":"browser"}`,
	})
	holder2, pid2, release2 := lockHead(t, ctx, pool, user2, "ai.recognize")
	defer release2()
	errCh2 := make(chan error, 1)
	claimCtx2, cancel2 := context.WithCancel(ctx)
	defer cancel2()
	go func() {
		tx, err := tenant.BeginApp(claimCtx2, pool.Begin, org2)
		if err != nil {
			errCh2 <- err
			return
		}
		defer tx.Rollback(claimCtx2)
		req := httptest.NewRequest(http.MethodPost, "/", nil).WithContext(claimCtx2)
		_, _, err = runClaimJob(req, tx, org2, id2, false)
		if err != nil {
			errCh2 <- err
			return
		}
		errCh2 <- tx.Commit(claimCtx2)
	}()
	waiter2 := waitLocked(t, ctx, pool, pid2)
	if n := advisoryGranted(t, ctx, pool, waiter2); n == 0 {
		t.Fatalf("old single claim waited without the quota lock\n%s", dumpActivity(t, ctx, pool))
	}
	_, holdErr2 := holder2.Exec(ctx, `
		SELECT pg_advisory_xact_lock(hashtextextended('eq-user:' || $1 || ':' || ($2::bigint)::text, 0))`,
		"ai_ocr", user2)
	claimErr2 := waitClaim(t, errCh2, cancel2)
	if !isDeadlock(holdErr2) && !isDeadlock(claimErr2) {
		t.Fatalf("old single claim did not raise 40P01\nholder %v\nclaim %v\n%s", holdErr2, claimErr2, dumpActivity(t, ctx, pool))
	}
}

func testHeadFirstNoDeadlock(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	org, user, row := seedOwner(t, ctx, pool, "new-win")
	const id = "d3000000-0000-4000-8000-000000000001"
	insertJob(t, ctx, pool, jobRow{
		id: id, org: org, user: user, row: row, kind: "ai.recognize", lane: "ai.recognize",
		state: "queued", payload: `{"executor":"browser"}`,
	})
	holder, pid, release := lockHead(t, ctx, pool, user, "ai.recognize")
	defer release()
	h := claimHost(pool, org, user)
	body := `{"jobIds":["` + id + `"],"kind":"ai.recognize","limit":4}`
	type httpResult struct {
		code int
		body string
	}
	out := make(chan httpResult, 1)
	claimCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/listing/jobs/claim-window", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req = req.WithContext(claimCtx)
		h.claimWindow(rec, req)
		out <- httpResult{code: rec.Code, body: rec.Body.String()}
	}()
	waiter := waitLocked(t, ctx, pool, pid)
	if n := advisoryGranted(t, ctx, pool, waiter); n != 0 {
		t.Fatalf("head-first claim held %d advisory locks while waiting\n%s", n, dumpActivity(t, ctx, pool))
	}
	if _, err := holder.Exec(ctx, `
		SELECT pg_advisory_xact_lock(hashtextextended('eq-user:' || $1 || ':' || ($2::bigint)::text, 0))`,
		"ai_ocr", user); err != nil {
		t.Fatalf("quota lock while claim waits on the head: %v\n%s", err, dumpActivity(t, ctx, pool))
	}
	release()
	var got httpResult
	select {
	case got = <-out:
	case <-time.After(10 * time.Second):
		cancel()
		t.Fatal("claim window did not return")
	}
	if got.code != http.StatusOK || !strings.Contains(got.body, id) || strings.Contains(got.body, "40P01") {
		t.Fatalf("window %d %s", got.code, got.body)
	}
	var state string
	var attempt int32
	var epoch int64
	var queued, running int64
	var permits int
	if err := pool.QueryRow(ctx, `
		SELECT state, attempt, lease_epoch FROM jobs WHERE id = $1::uuid`, id).Scan(&state, &attempt, &epoch); err != nil {
		t.Fatal(err)
	}
	if state != "running" || attempt != 1 || epoch != 1 {
		t.Fatalf("job %s %d %d", state, attempt, epoch)
	}
	if err := pool.QueryRow(ctx, `
		SELECT queued_cost, running_cost FROM account_queue_head
		WHERE user_id = $1 AND lane = 'ai.recognize'`, user).Scan(&queued, &running); err != nil {
		t.Fatal(err)
	}
	if queued != 0 || running != 8 {
		t.Fatalf("head %d %d", queued, running)
	}
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM execution_permits
		WHERE holder_id = $1 AND released_at IS NULL AND class = 'ai_ocr'`, id).Scan(&permits); err != nil || permits != 1 {
		t.Fatalf("permits %d %v", permits, err)
	}

	org2, user2, row2 := seedOwner(t, ctx, pool, "new-one")
	const id2 = "d4000000-0000-4000-8000-000000000001"
	insertJob(t, ctx, pool, jobRow{
		id: id2, org: org2, user: user2, row: row2, kind: "ai.recognize", lane: "ai.recognize",
		state: "queued", payload: `{"executor":"browser"}`,
	})
	holder2, pid2, release2 := lockHead(t, ctx, pool, user2, "ai.recognize")
	defer release2()
	h2 := claimHost(pool, org2, user2)
	out2 := make(chan httpResult, 1)
	claimCtx2, cancel2 := context.WithCancel(ctx)
	defer cancel2()
	go func() {
		rec := callClaimJobCtx(h2, id2, claimCtx2)
		out2 <- httpResult{code: rec.Code, body: rec.Body.String()}
	}()
	waiter2 := waitLocked(t, ctx, pool, pid2)
	if n := advisoryGranted(t, ctx, pool, waiter2); n != 0 {
		t.Fatalf("single claim held advisory locks while waiting on the head\n%s", dumpActivity(t, ctx, pool))
	}
	if _, err := holder2.Exec(ctx, `
		SELECT pg_advisory_xact_lock(hashtextextended('eq-user:' || $1 || ':' || ($2::bigint)::text, 0))`,
		"ai_ocr", user2); err != nil {
		t.Fatalf("single quota lock: %v", err)
	}
	release2()
	select {
	case got = <-out2:
	case <-time.After(10 * time.Second):
		cancel2()
		t.Fatal("single claim did not return")
	}
	if got.code != http.StatusOK || !strings.Contains(got.body, id2) {
		t.Fatalf("single %d %s", got.code, got.body)
	}
	if err := pool.QueryRow(ctx, `SELECT state FROM jobs WHERE id = $1::uuid`, id2).Scan(&state); err != nil || state != "running" {
		t.Fatalf("single state %s %v", state, err)
	}
}

func testKernelOverlap(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	org, user, browserRow := seedOwner(t, ctx, pool, "overlap")
	var card string
	if err := pool.QueryRow(ctx, `SELECT card_id::text FROM listing_rows WHERE id = $1::uuid`, browserRow).Scan(&card); err != nil {
		t.Fatal(err)
	}
	const workerRow = "c5000000-0000-4000-8000-0000000000e1"
	if _, err := pool.Exec(ctx, `
		INSERT INTO listing_rows (id, org_id, card_id, payload)
		VALUES ($1::uuid, $2, $3::uuid, '{}'::jsonb)`, workerRow, org, card); err != nil {
		t.Fatal(err)
	}
	// Five rounds claim two jobs each. 64 covers both grants every round.
	if _, err := pool.Exec(ctx, `
		INSERT INTO execution_quota (class, user_id, hard_limit)
		VALUES ('ai_ocr', $1, 64)
		ON CONFLICT (class, user_id) DO UPDATE SET hard_limit = 64`, user); err != nil {
		t.Fatal(err)
	}
	h := claimHost(pool, org, user)
	for i := 0; i < 5; i++ {
		browserID := fmt.Sprintf("e1000000-0000-4000-8000-%012d", i*2+1)
		workerID := fmt.Sprintf("e1000000-0000-4000-8000-%012d", i*2+2)
		insertJob(t, ctx, pool, jobRow{
			id: browserID, org: org, user: user, row: browserRow, kind: "ai.recognize", lane: "ai.recognize",
			state: "queued", payload: `{"executor":"browser"}`,
		})
		insertJob(t, ctx, pool, jobRow{
			id: workerID, org: org, user: user, row: workerRow, kind: "ai.recognize", lane: "ai.recognize",
			state: "queued", payload: `{}`,
		})
		prepared := []string{browserID, workerID}
		start := make(chan struct{})
		type kernelResult struct {
			ids []string
			err error
		}
		kernelCh := make(chan kernelResult, 1)
		httpCh := make(chan *httptest.ResponseRecorder, 1)
		go func() {
			<-start
			claimed, err := queuerepo.Claim(ctx, pool, "ai.recognize", "overlap", 1)
			ids := make([]string, 0, len(claimed))
			for _, item := range claimed {
				ids = append(ids, item.ID.String())
			}
			kernelCh <- kernelResult{ids: ids, err: err}
		}()
		go func(id string) {
			<-start
			body := `{"jobIds":["` + id + `"],"kind":"ai.recognize","limit":4}`
			httpCh <- callWindow(h, body)
		}(browserID)
		close(start)
		var kernel kernelResult
		var rec *httptest.ResponseRecorder
		select {
		case kernel = <-kernelCh:
		case <-time.After(15 * time.Second):
			t.Fatal("kernel claim stuck")
		}
		select {
		case rec = <-httpCh:
		case <-time.After(15 * time.Second):
			t.Fatal("browser claim stuck")
		}
		if isDeadlock(kernel.err) || kernel.err != nil || rec.Code != http.StatusOK || strings.Contains(rec.Body.String(), "40P01") {
			t.Fatalf("round %d kernel %v http %d %s", i, kernel.err, rec.Code, rec.Body.String())
		}
		// The kernel may take the worker while the browser try-lock skips.
		// Either split is fine. The ids reported must be exactly the jobs
		// now running, once each.
		got := map[string]bool{}
		for _, id := range kernel.ids {
			if got[id] {
				t.Fatalf("round %d kernel claimed %s twice", i, id)
			}
			got[id] = true
		}
		httpIDs, _ := readClaims(t, rec.Body.Bytes())
		for _, id := range httpIDs {
			if got[id] {
				t.Fatalf("round %d job %s claimed twice", i, id)
			}
			got[id] = true
		}
		stateOf := map[string]string{}
		running := 0
		for _, id := range prepared {
			var state string
			if err := pool.QueryRow(ctx, `SELECT state FROM jobs WHERE id = $1::uuid`, id).Scan(&state); err != nil {
				t.Fatal(err)
			}
			stateOf[id] = state
			if state == "running" {
				running++
				if !got[id] {
					t.Fatalf("round %d running %s missing from claims %v http %s", i, id, got, rec.Body.String())
				}
				continue
			}
			if state != "queued" {
				t.Fatalf("round %d job %s state %s", i, id, state)
			}
			if got[id] {
				t.Fatalf("round %d claimed queued job %s http %s", i, id, rec.Body.String())
			}
		}
		if len(got) != running {
			t.Fatalf("round %d claimed %d running %d http %s", i, len(got), running, rec.Body.String())
		}
		for id := range got {
			if stateOf[id] == "" {
				t.Fatalf("round %d claimed job outside this round: %s", i, id)
			}
		}
		// Leave no due worker for the next kernel Claim. A skipped browser
		// job stays queued and is not a worker candidate.
		if stateOf[workerID] == "queued" {
			claimed, err := queuerepo.Claim(ctx, pool, "ai.recognize", "overlap", 1)
			if isDeadlock(err) || err != nil || len(claimed) != 1 || claimed[0].ID.String() != workerID {
				t.Fatalf("round %d drain worker err %v claimed %v", i, err, claimed)
			}
		}
	}
}

type claimSnap struct {
	canon  string
	db     string
	ids    []string
	claims []seenClaim
	quota  bool
}

type seenClaim struct {
	ID           string
	State        string
	Attempt      int32
	Epoch        int64
	LeaseSeconds int64
}

func claimWindowSnap(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org, owner, other int64, ids []string, kind string, limit int64, headsFirst bool) claimSnap {
	t.Helper()
	var snap claimSnap
	withApp(t, ctx, pool, org, func(tx pgx.Tx) {
		req := httptest.NewRequest(http.MethodPost, "/", nil)
		out, level, err := runClaimWindow(req, tx, org, owner, ids, kind, limit, headsFirst)
		if err != nil {
			t.Fatal(err)
		}
		raw := marshalWindow(t, out, level)
		snap.canon = canonClaimJSON(raw)
		snap.ids, snap.claims = readClaims(t, raw)
		snap.db = dbSnap(t, ctx, tx, org, []int64{owner, other})
	})
	return snap
}

func claimJobSnap(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org, user int64, id string, headsFirst bool) claimSnap {
	t.Helper()
	var snap claimSnap
	withApp(t, ctx, pool, org, func(tx pgx.Tx) {
		req := httptest.NewRequest(http.MethodPost, "/", nil)
		leased, quota, err := runClaimJob(req, tx, org, id, headsFirst)
		if err != nil {
			t.Fatal(err)
		}
		raw, err := jsonwire.Marshal(struct {
			Data *browserClaim `json:"data"`
		}{Data: leased})
		if err != nil {
			t.Fatal(err)
		}
		snap.canon = canonClaimJSON(raw)
		snap.quota = quota
		snap.db = dbSnap(t, ctx, tx, org, []int64{user})
	})
	return snap
}

func windowBody(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org, user int64, body string, headsFirst bool) []byte {
	t.Helper()
	var raw []byte
	withApp(t, ctx, pool, org, func(tx pgx.Tx) {
		var fields struct {
			JobIDs []string `json:"jobIds"`
			Kind   string   `json:"kind"`
			Limit  int64    `json:"limit"`
		}
		if err := json.Unmarshal([]byte(body), &fields); err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
		out, level, err := runClaimWindow(req, tx, org, user, fields.JobIDs, fields.Kind, fields.Limit, headsFirst)
		if err != nil {
			t.Fatal(err)
		}
		raw = marshalWindow(t, out, level)
	})
	return raw
}

func marshalWindow(t *testing.T, out []browserClaim, level *queueLevelView) []byte {
	t.Helper()
	if out == nil {
		out = []browserClaim{}
	}
	raw, err := jsonwire.Marshal(struct {
		Data       []browserClaim  `json:"data"`
		QueueLevel *queueLevelView `json:"queueLevel,omitempty"`
	}{Data: out, QueueLevel: level})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

var (
	ownerRe = regexp.MustCompile(`"owner":"[^"]*"`)
	msRe    = regexp.MustCompile(`"updatedAtMs":\d+`)
)

func canonClaimJSON(raw []byte) string {
	s := ownerRe.ReplaceAllString(string(raw), `"owner":"OWNER"`)
	return msRe.ReplaceAllString(s, `"updatedAtMs":0`)
}

func readClaims(t *testing.T, raw []byte) ([]string, []seenClaim) {
	t.Helper()
	var body struct {
		Data []struct {
			Job struct {
				ID      string `json:"id"`
				State   string `json:"state"`
				Attempt int32  `json:"attempt"`
			} `json:"job"`
			Lease struct {
				Epoch int64 `json:"epoch"`
			} `json:"lease"`
			LeaseSeconds int64 `json:"leaseSeconds"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatal(err)
	}
	var ids []string
	var claims []seenClaim
	for _, item := range body.Data {
		ids = append(ids, item.Job.ID)
		claims = append(claims, seenClaim{
			ID: item.Job.ID, State: item.Job.State, Attempt: item.Job.Attempt,
			Epoch: item.Lease.Epoch, LeaseSeconds: item.LeaseSeconds,
		})
	}
	return ids, claims
}

func dbSnap(t *testing.T, ctx context.Context, tx pgx.Tx, org int64, users []int64) string {
	t.Helper()
	var jobs, heads, quotas, permits, fair, cursor string
	if err := tx.QueryRow(ctx, `
		SELECT coalesce(string_agg(
			id::text || ' ' || state || ' ' || attempt::text || ' ' || lease_epoch::text
			|| ' ' || (lease_owner IS NULL)::text || ' ' || (lease_until IS NULL)::text,
			E'\n' ORDER BY id::text), '')
		FROM jobs WHERE org_id = $1`, org).Scan(&jobs); err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(ctx, `
		SELECT coalesce(string_agg(
			user_id::text || ' ' || lane || ' ' || queued_cost::text || ' ' || running_cost::text,
			E'\n' ORDER BY user_id, lane), '')
		FROM account_queue_head WHERE user_id = ANY($1::bigint[])`, users).Scan(&heads); err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(ctx, `
		SELECT coalesce(string_agg(
			class || ' ' || user_id::text || ' ' || hard_limit::text || ' ' || used::text,
			E'\n' ORDER BY class, user_id), '')
		FROM execution_quota
		WHERE class = 'ai_ocr' AND (user_id = ANY($1::bigint[]) OR user_id = 0)`, users).Scan(&quotas); err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(ctx, `
		SELECT coalesce(string_agg(
			'permit ' || class || ' ' || user_id::text || ' ' || holder_id || ' ' || lease_epoch::text,
			E'\n' ORDER BY holder_id, class), '')
		FROM execution_permits WHERE org_id = $1 AND released_at IS NULL`, org).Scan(&permits); err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(ctx, `
		SELECT coalesce(string_agg(class || ' ' || user_id::text, E'\n' ORDER BY user_id), '')
		FROM execution_fairness
		WHERE class = 'ai_ocr' AND user_id = ANY($1::bigint[])`, users).Scan(&fair); err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(ctx, `
		SELECT last_user_id::text FROM execution_fairness_cursor WHERE class = 'ai_ocr'`).Scan(&cursor); err != nil {
		t.Fatal(err)
	}
	return strings.Join([]string{jobs, heads, quotas, permits, fair, "cursor " + cursor}, "\n")
}

func withApp(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org int64, fn func(pgx.Tx)) {
	t.Helper()
	tx, err := tenant.BeginApp(ctx, pool.Begin, org)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	fn(tx)
}

func lockHead(t *testing.T, ctx context.Context, pool *pgxpool.Pool, user int64, lane string) (pgx.Tx, int, func()) {
	t.Helper()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	tx, err := conn.Begin(ctx)
	if err != nil {
		conn.Release()
		t.Fatal(err)
	}
	var once sync.Once
	release := func() {
		once.Do(func() {
			_ = tx.Rollback(ctx)
			conn.Release()
		})
	}
	if _, err := tx.Exec(ctx, `SET LOCAL deadlock_timeout = '200ms'`); err != nil {
		release()
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `SET LOCAL lock_timeout = '5s'`); err != nil {
		release()
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO account_queue_head(user_id, lane) VALUES ($1, $2)
		ON CONFLICT (user_id, lane) DO UPDATE SET lane = account_queue_head.lane`, user, lane); err != nil {
		release()
		t.Fatal(err)
	}
	var pid int
	if err := tx.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
		release()
		t.Fatal(err)
	}
	return tx, pid, release
}

func waitLocked(t *testing.T, ctx context.Context, pool *pgxpool.Pool, holder int) int {
	t.Helper()
	deadline := time.Now().Add(8 * time.Second)
	for {
		var pid int
		err := pool.QueryRow(ctx, `
			SELECT pid FROM pg_stat_activity
			WHERE pid <> $1 AND wait_event_type = 'Lock'
			ORDER BY pid
			LIMIT 1`, holder).Scan(&pid)
		if err == nil {
			return pid
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			t.Fatal(err)
		}
		if time.Now().After(deadline) {
			t.Fatalf("claim did not block\n%s", dumpActivity(t, ctx, pool))
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func advisoryGranted(t *testing.T, ctx context.Context, pool *pgxpool.Pool, pid int) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM pg_locks
		WHERE pid = $1 AND locktype = 'advisory' AND granted`, pid).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func waitClaim(t *testing.T, errCh <-chan error, cancel context.CancelFunc) error {
	t.Helper()
	select {
	case err := <-errCh:
		return err
	case <-time.After(8 * time.Second):
		cancel()
		select {
		case err := <-errCh:
			return err
		case <-time.After(5 * time.Second):
			t.Fatal("claim goroutine stuck")
		}
	}
	return nil
}

func isDeadlock(err error) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "40P01"
}

func dumpActivity(t *testing.T, ctx context.Context, pool *pgxpool.Pool) string {
	t.Helper()
	rows, err := pool.Query(ctx, `
		SELECT pid, coalesce(wait_event_type, ''), coalesce(wait_event, ''), left(query, 180)
		FROM pg_stat_activity WHERE datname = current_database()`)
	if err != nil {
		return err.Error()
	}
	defer rows.Close()
	var b strings.Builder
	for rows.Next() {
		var pid int
		var kind, event, query string
		if err := rows.Scan(&pid, &kind, &event, &query); err != nil {
			return err.Error()
		}
		fmt.Fprintf(&b, "%d %s %s %s\n", pid, kind, event, query)
	}
	return b.String()
}

func claimHost(pool *pgxpool.Pool, org, user int64) Host {
	p := access.Principal{UserID: user, OrgID: org, WorkspaceRole: "owner", PlatformRole: "user"}
	return Host{Pool: pool, Access: access.FixedResolver{Principal: &p}}
}

func callWindow(h Host, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/listing/jobs/claim-window", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	h.claimWindow(rec, req)
	return rec
}

func callClaimJob(h Host, id string) *httptest.ResponseRecorder {
	return callClaimJobCtx(h, id, context.Background())
}

func callClaimJobCtx(h Host, id string, ctx context.Context) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/listing/jobs/"+id+"/claim", nil).WithContext(ctx)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", id)
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
	h.claimJob(rec, req)
	return rec
}

func ownerText(id int64) string { return fmt.Sprintf("%d", id) }

type jobRow struct {
	id, row, kind, lane, state, payload, runAt string
	org, user                                  int64
	priority, attempt                          int
	last                                       *string
	cancel                                     bool
}

func insertJob(t *testing.T, ctx context.Context, pool *pgxpool.Pool, row jobRow) {
	t.Helper()
	if row.payload == "" {
		row.payload = `{"executor":"browser"}`
	}
	if row.priority == 0 {
		row.priority = 100
	}
	runAt := any(nil)
	if row.runAt != "" {
		runAt = row.runAt
	}
	var cancel any
	if row.cancel {
		cancel = "2026-01-01 00:00:00+00"
	}
	_, err := pool.Exec(ctx, `
		INSERT INTO jobs (
			id, org_id, kind, aggregate_type, aggregate_id, input_revision, idempotency_key,
			state, attempt, max_attempts, priority, lane, submitter_user_id, cost_units,
			payload, run_at, cancel_requested_at, last_error_code, created_at
		) VALUES (
			$1::uuid, $2, $3, 'listing_row', $4::uuid, 1, $1,
			$5, $6, 8, $7, $8, $9, 8,
			$10::jsonb, coalesce($11::timestamptz, clock_timestamp()), $12::timestamptz, $13,
			timestamptz '2026-01-01 00:00:00+00'
		)`, row.id, row.org, row.kind, row.row, row.state, row.attempt, row.priority, row.lane,
		row.user, row.payload, runAt, cancel, row.last)
	if err != nil {
		t.Fatal(err)
	}
}

func seedOwner(t *testing.T, ctx context.Context, pool *pgxpool.Pool, tag string) (org, user int64, row string) {
	t.Helper()
	user = insertUser(t, ctx, pool, tag)
	if err := pool.QueryRow(ctx, `
		INSERT INTO public.organizations (owner_user_id, name, created_at, updated_at)
		VALUES ($1, $2, timestamptz '2026-08-21 17:30:00+00', timestamptz '2026-08-21 17:30:00+00')
		RETURNING id`, user, "org-"+tag).Scan(&org); err != nil {
		t.Fatal(err)
	}
	insertMember(t, ctx, pool, org, user, "owner", 1)
	card := fmt.Sprintf("c3000000-0000-4000-8000-%012d", user%1000000000000)
	row = fmt.Sprintf("c4000000-0000-4000-8000-%012d", user%1000000000000)
	if _, err := pool.Exec(ctx, `
		INSERT INTO listing_cards (id, org_id, title, payload)
		VALUES ($1::uuid, $2, '卡', '{}'::jsonb)`, card, org); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO listing_rows (id, org_id, card_id, payload)
		VALUES ($1::uuid, $2, $3::uuid, '{}'::jsonb)`, row, org, card); err != nil {
		t.Fatal(err)
	}
	return org, user, row
}

func insertUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool, tag string) int64 {
	t.Helper()
	var id int64
	err := pool.QueryRow(ctx, `
		INSERT INTO public.account_users (public_id, email, password_hash, name, created_at, updated_at)
		VALUES ($1, $2, 'x', $3, timestamptz '2026-08-21 17:30:00+00', timestamptz '2026-08-21 17:30:00+00')
		RETURNING id`, tag, tag+"@example.invalid", tag).Scan(&id)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func insertMember(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org, user int64, role string, order int64) {
	t.Helper()
	_, err := pool.Exec(ctx, `
		INSERT INTO organization_members (org_id, user_id, role, status, display_name, created_at, updated_at, join_order)
		VALUES ($1, $2, $3, 'active', 'n', clock_timestamp(), clock_timestamp(), $4)`,
		org, user, role, order)
	if err != nil {
		t.Fatal(err)
	}
}

func startClaimDB(t *testing.T, ctx context.Context) *pgxpool.Pool {
	t.Helper()
	dsn, stop, err := testkit.StartPostgres(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(stop)
	if strings.Contains(dsn, "127.0.0.1:5432") {
		t.Fatalf("dsn dials a fixed postgres: %s", dsn)
	}
	cfg := config.Config{DatabaseURL: dsn}
	_ = os.Setenv("PODHUB_ALLOW_SUPERUSER_DB", "1")
	pool, err := db.Connect(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := db.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	return pool
}
