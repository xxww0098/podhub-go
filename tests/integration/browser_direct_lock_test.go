package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/listing/submit"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	tenant "github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	queue "github.com/xxww0098/podhub-go/internal/platform/jobsched"
	loadmode "github.com/xxww0098/podhub-go/internal/platform/loadmode"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
)

// These tests lock the browser-direct grant. They dial only a loopback
// mock and use the fixed fixture key. They do not change the kill-switch
// parser; the grant sees the bool Config already captured.

func TestBrowserDirectImportRoundTrip(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	user, org := insertWorkspace(t, ctx, pool, "round-"+uuid.NewString()+"@example.com", "Round")
	ring := seal.Ring{Primary: seal.DeriveKEK("browser-direct-fixture-kek")}

	t.Run("2xx task id is accepted", func(t *testing.T) {
		shop := newGrantShop(t, ctx, pool, org, user, ring, false, farExpiry())
		mock, hits := importMock(t, "ok")
		defer mock.Close()
		first := grantAndPost(t, shop, mock, "offer-ok", "op-ok", shop.row(t, ctx))
		if hits.Load() != 1 {
			t.Fatalf("mock hits %d", hits.Load())
		}
		rec := shop.postReport(t, reportTask(first.IntentID, first.taskID))
		if rec.Code != http.StatusOK {
			t.Fatal(redact(rec))
		}
		assertIntent(t, ctx, pool, first.IntentID, "accepted", "42", "accepted")
		again := shop.postGrant(t, shop.body("offer-ok", "op-ok-2", shop.row(t, ctx)))
		assertNoKey(t, again, http.StatusConflict, "submission_intents_offer_busy")
		if shop.opens.Load() != 1 {
			t.Fatalf("opens %d", shop.opens.Load())
		}
	})

	t.Run("4xx is rejected and the fence opens", func(t *testing.T) {
		shop := newGrantShop(t, ctx, pool, org, user, ring, false, farExpiry())
		mock, hits := importMock(t, "bad")
		defer mock.Close()
		first := grantAndPost(t, shop, mock, "offer-4xx", "op-4xx", shop.row(t, ctx))
		if hits.Load() != 1 || first.status != http.StatusBadRequest {
			t.Fatalf("hits %d status %d", hits.Load(), first.status)
		}
		rec := shop.postReport(t, reportStatus(first.IntentID, first.status))
		if rec.Code != http.StatusOK {
			t.Fatal(redact(rec))
		}
		var state, code string
		if err := pool.QueryRow(ctx, `
			SELECT state, COALESCE(last_error_code, '')
			  FROM public.submission_intents WHERE id = $1::uuid`, first.IntentID).Scan(&state, &code); err != nil {
			t.Fatal(err)
		}
		if state != "rejected" || code != "OZON_ROW_REJECTED" {
			t.Fatalf("%s %s", state, code)
		}
		second := shop.postGrant(t, shop.body("offer-4xx", "op-4xx-2", shop.row(t, ctx)))
		if second.Code != http.StatusOK || strings.Count(second.Body.String(), fixtureAPIKey) != 1 {
			t.Fatal(redact(second))
		}
		if shop.opens.Load() != 2 {
			t.Fatalf("opens %d", shop.opens.Load())
		}
	})

	t.Run("connection drop is unknown and the fence holds", func(t *testing.T) {
		shop := newGrantShop(t, ctx, pool, org, user, ring, false, farExpiry())
		mock, hits := importMock(t, "drop")
		defer mock.Close()
		posted := grantAndPost(t, shop, mock, "offer-drop", "op-drop", shop.row(t, ctx))
		if hits.Load() != 1 || posted.gotStatus {
			t.Fatalf("hits %d status %v", hits.Load(), posted.gotStatus)
		}
		rec := shop.postReport(t, `{"intentId":"`+posted.IntentID+`"}`)
		if rec.Code != http.StatusOK {
			t.Fatal(redact(rec))
		}
		var state, code string
		var reconcile *time.Time
		if err := pool.QueryRow(ctx, `
			SELECT state, COALESCE(last_error_code, ''), reconcile_after
			  FROM public.submission_intents WHERE id = $1::uuid`, posted.IntentID).Scan(&state, &code, &reconcile); err != nil {
			t.Fatal(err)
		}
		if state != "unknown" || code != "OZON_DISPATCH_INTERRUPTED" || reconcile == nil {
			t.Fatalf("%s %s %v", state, code, reconcile)
		}
		again := shop.postGrant(t, shop.body("offer-drop", "op-drop-2", shop.row(t, ctx)))
		assertNoKey(t, again, http.StatusConflict, "submission_intents_offer_busy")
		if shop.opens.Load() != 1 {
			t.Fatalf("opens %d", shop.opens.Load())
		}
	})

	t.Run("failed report stays submitting and issues no second key", func(t *testing.T) {
		shop := newGrantShop(t, ctx, pool, org, user, ring, false, farExpiry())
		mock, _ := importMock(t, "ok")
		defer mock.Close()
		row := shop.row(t, ctx)
		body := shop.body("offer-hold", "op-hold", row)
		first := grantAndPost(t, shop, mock, "offer-hold", "op-hold", row)
		if _, err := pool.Exec(ctx, `
			UPDATE public.listing_rows SET revision = revision + 1 WHERE id = $1::uuid`, first.rowID); err != nil {
			t.Fatal(err)
		}
		rec := shop.postReport(t, reportTask(first.IntentID, first.taskID))
		if rec.Code != http.StatusConflict {
			t.Fatal(redact(rec))
		}
		if state := intentState(t, ctx, pool, first.IntentID); state != "submitting" {
			t.Fatal(state)
		}
		replay := shop.postGrant(t, body)
		assertNoKey(t, replay, http.StatusConflict, "grant_in_flight")
		other := shop.postGrant(t, shop.body("offer-hold", "op-hold-2", shop.row(t, ctx)))
		assertNoKey(t, other, http.StatusConflict, "submission_intents_offer_busy")
		if shop.opens.Load() != 1 {
			t.Fatalf("opens %d", shop.opens.Load())
		}
	})
}

func TestBrowserDirectConcurrentGrants(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	user, org := insertWorkspace(t, ctx, pool, "conc-"+uuid.NewString()+"@example.com", "Conc")
	ring := seal.Ring{Primary: seal.DeriveKEK("browser-direct-fixture-kek")}
	before := deadlocks(t, ctx, pool)

	const sameN = 8
	shop := newGrantShop(t, ctx, pool, org, user, ring, false, farExpiry())
	row := shop.row(t, ctx)
	bodies := make([]string, sameN)
	for i := range bodies {
		bodies[i] = shop.body("offer-same", fmt.Sprintf("op-same-%d", i), row)
	}
	same := fanoutGrants(sameN, func(i int) *httptest.ResponseRecorder {
		return shop.postGrant(t, bodies[i])
	})
	ok, busy, other := tallyGrantCodes(t, same)
	if ok != 1 || busy != sameN-1 || other != 0 {
		t.Fatalf("same offer ok %d busy %d other %d", ok, busy, other)
	}
	if keyAppearances(same) != 1 || shop.opens.Load() != 1 {
		t.Fatalf("keys %d opens %d", keyAppearances(same), shop.opens.Load())
	}
	if n := fencingIntents(t, ctx, pool, shop.storeID); n != 1 {
		t.Fatalf("fencing %d", n)
	}

	const diffN = 6
	diffShop := newGrantShop(t, ctx, pool, org, user, ring, false, farExpiry())
	diffBodies := make([]string, diffN)
	for i := range diffBodies {
		diffBodies[i] = diffShop.body(fmt.Sprintf("offer-d-%d", i), fmt.Sprintf("op-d-%d", i), diffShop.row(t, ctx))
	}
	diff := fanoutGrants(diffN, func(i int) *httptest.ResponseRecorder {
		return diffShop.postGrant(t, diffBodies[i])
	})
	ok, busy, other = tallyGrantCodes(t, diff)
	if ok != diffN || busy != 0 || other != 0 {
		t.Fatalf("distinct offers ok %d busy %d other %d", ok, busy, other)
	}
	if keyAppearances(diff) != diffN || diffShop.opens.Load() != int32(diffN) {
		t.Fatalf("keys %d opens %d", keyAppearances(diff), diffShop.opens.Load())
	}

	nullShop := newGrantShop(t, ctx, pool, org, user, ring, false, farExpiry())
	nullRow := insertFenceRow(t, ctx, pool, org, nullShop.storeID)
	insertIntent(t, ctx, pool, uuid.NewString(), org, nullShop.storeID, nullRow, "unknown", "op-null", nil, nil)
	const nullN = 6
	nullBodies := make([]string, nullN)
	for i := range nullBodies {
		nullBodies[i] = nullShop.body(fmt.Sprintf("offer-n-%d", i), fmt.Sprintf("op-n-%d", i), nullShop.row(t, ctx))
	}
	nulls := fanoutGrants(nullN, func(i int) *httptest.ResponseRecorder {
		return nullShop.postGrant(t, nullBodies[i])
	})
	ok, busy, other = tallyGrantCodes(t, nulls)
	if ok != 0 || busy != nullN || other != 0 || keyAppearances(nulls) != 0 || nullShop.opens.Load() != 0 {
		t.Fatalf("null fence ok %d busy %d other %d keys %d opens %d", ok, busy, other, keyAppearances(nulls), nullShop.opens.Load())
	}
	for _, rec := range nulls {
		if errorCode(t, rec) != "submission_intents_offer_busy" {
			t.Fatal(redact(rec))
		}
	}
	if delta := deadlocks(t, ctx, pool) - before; delta != 0 {
		t.Fatalf("40P01 deadlocks %d", delta)
	}
}

func TestBrowserDirectKillSwitchHidesKey(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	user, org := insertWorkspace(t, ctx, pool, "kill-"+uuid.NewString()+"@example.com", "Kill")
	ring := seal.Ring{Primary: seal.DeriveKEK("browser-direct-fixture-kek")}
	logs := captureLogs(t)

	t.Setenv("OZON_WRITE_KILL_SWITCH", "1")
	capturedOn := config.Load().OzonWritesDisabled()
	if !capturedOn {
		t.Fatal("Config did not capture the switch")
	}
	t.Setenv("OZON_WRITE_KILL_SWITCH", "off")
	if config.Load().OzonWritesDisabled() {
		t.Fatal("a later Load still reported the first capture")
	}
	blocked := newGrantShop(t, ctx, pool, org, user, ring, capturedOn, farExpiry())
	logs.reset()
	rec := blocked.postGrant(t, blocked.body("offer-off", "op-off", blocked.row(t, ctx)))
	assertNoKey(t, rec, http.StatusServiceUnavailable, "OZON_WRITES_DISABLED")
	if n := keySurfaces(rec.Body.String(), logs.text(), auditText(t, ctx, pool)); n != 0 {
		t.Fatalf("key appearances %d", n)
	}
	if blocked.opens.Load() != 0 || fencingIntents(t, ctx, pool, blocked.storeID) != 0 || blocked.intentCount(t, ctx) != 0 {
		t.Fatalf("opens %d fence %d intents %d", blocked.opens.Load(), fencingIntents(t, ctx, pool, blocked.storeID), blocked.intentCount(t, ctx))
	}
	t.Setenv("OZON_WRITE_KILL_SWITCH", "0")
	logs.reset()
	still := blocked.postGrant(t, blocked.body("offer-off-2", "op-off-2", blocked.row(t, ctx)))
	assertNoKey(t, still, http.StatusServiceUnavailable, "OZON_WRITES_DISABLED")
	if blocked.opens.Load() != 0 || keySurfaces(still.Body.String(), logs.text(), auditText(t, ctx, pool)) != 0 {
		t.Fatal("captured bool followed a later Load")
	}

	t.Setenv("OZON_WRITE_KILL_SWITCH", "no")
	capturedOff := config.Load().OzonWritesDisabled()
	if capturedOff {
		t.Fatal("Config captured a disabled write path")
	}
	open := newGrantShop(t, ctx, pool, org, user, ring, capturedOff, farExpiry())
	t.Setenv("OZON_WRITE_KILL_SWITCH", "on")
	if !config.Load().OzonWritesDisabled() {
		t.Fatal("env no longer reads as disabled")
	}
	logs.reset()
	granted := open.postGrant(t, open.body("offer-on", "op-on", open.row(t, ctx)))
	if granted.Code != http.StatusOK {
		t.Fatal(redact(granted))
	}
	if n := keySurfaces(granted.Body.String(), logs.text(), auditText(t, ctx, pool)); n != 1 {
		t.Fatalf("key appearances %d", n)
	}
	if strings.Count(logs.text(), fixtureAPIKey) != 0 || strings.Count(auditText(t, ctx, pool), fixtureAPIKey) != 0 {
		t.Fatal("key reached the log or the audit")
	}
	if open.opens.Load() != 1 {
		t.Fatalf("opens %d", open.opens.Load())
	}
}

func TestBrowserDirectGrantDeadlineAndRevocation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	user, org := insertWorkspace(t, ctx, pool, "dead-"+uuid.NewString()+"@example.com", "Deadline")
	ring := seal.Ring{Primary: seal.DeriveKEK("browser-direct-fixture-kek")}
	if submit.GrantTTLMS != 120000 {
		t.Fatalf("ttl %d", submit.GrantTTLMS)
	}

	shop := newGrantShop(t, ctx, pool, org, user, ring, false, farExpiry())
	row := shop.row(t, ctx)
	body := shop.body("offer-ttl", "op-ttl", row)
	first := parseGrant(t, shop.postGrant(t, body))
	if first.TTL != 120000 {
		t.Fatalf("ttl %d", first.TTL)
	}
	replay := shop.postGrant(t, body)
	assertNoKey(t, replay, http.StatusConflict, "grant_in_flight")
	if shop.opens.Load() != 1 {
		t.Fatalf("opens %d", shop.opens.Load())
	}

	inside := time.Now().Add(-119 * time.Second)
	if _, err := pool.Exec(ctx, `
		UPDATE public.submission_intents SET credential_granted_at = $2 WHERE id = $1::uuid`, first.IntentID, inside); err != nil {
		t.Fatal(err)
	}
	still := shop.postGrant(t, body)
	assertNoKey(t, still, http.StatusConflict, "grant_in_flight")

	past := time.Now().Add(-121 * time.Second)
	if _, err := pool.Exec(ctx, `
		UPDATE public.submission_intents SET credential_granted_at = $2 WHERE id = $1::uuid`, first.IntentID, past); err != nil {
		t.Fatal(err)
	}
	expired := shop.postGrant(t, body)
	assertNoKey(t, expired, http.StatusConflict, "grant_expired")
	fresh := shop.postGrant(t, shop.body("offer-ttl", "op-ttl-2", shop.row(t, ctx)))
	assertNoKey(t, fresh, http.StatusConflict, "submission_intents_offer_busy")
	if shop.opens.Load() != 1 {
		t.Fatalf("opens %d", shop.opens.Load())
	}

	revokedShop := newGrantShop(t, ctx, pool, org, user, ring, false, farExpiry())
	revokedBody := revokedShop.body("offer-rev", "op-rev", revokedShop.row(t, ctx))
	revoked := parseGrant(t, revokedShop.postGrant(t, revokedBody))
	if _, err := pool.Exec(ctx, `
		UPDATE public.submission_intents SET revoked_at = clock_timestamp() WHERE id = $1::uuid`, revoked.IntentID); err != nil {
		t.Fatal(err)
	}
	again := revokedShop.postGrant(t, revokedShop.body("offer-rev", "op-rev-2", revokedShop.row(t, ctx)))
	assertNoKey(t, again, http.StatusConflict, "grant_revoked")
	same := revokedShop.postGrant(t, revokedBody)
	assertNoKey(t, same, http.StatusConflict, "grant_revoked")
	if revokedShop.opens.Load() != 1 {
		t.Fatalf("opens %d", revokedShop.opens.Load())
	}
}

func TestBrowserDirectTenantAndCapability(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	userA, orgA := insertWorkspace(t, ctx, pool, "ten-a-"+uuid.NewString()+"@example.com", "Ten A")
	userB, orgB := insertWorkspace(t, ctx, pool, "ten-b-"+uuid.NewString()+"@example.com", "Ten B")
	ring := seal.Ring{Primary: seal.DeriveKEK("browser-direct-fixture-kek")}
	shop := newGrantShop(t, ctx, pool, orgA, userA, ring, false, farExpiry())

	other := shop.handler(orgB, userB, "owner", false)
	cross := callJSON(other, http.MethodPost, "/api/listing/browser/grant", shop.body("offer-x", "op-x", shop.row(t, ctx)))
	assertNoKey(t, cross, http.StatusNotFound, "not_found")
	if shop.opens.Load() != 0 || shop.intentCount(t, ctx) != 0 {
		t.Fatalf("opens %d intents %d", shop.opens.Load(), shop.intentCount(t, ctx))
	}

	row := shop.row(t, ctx)
	otherRow := shop.row(t, ctx)
	first := parseGrant(t, shop.postGrant(t, shop.body("offer-own", "op-own", row)))
	second := parseGrant(t, shop.postGrant(t, shop.body("offer-own-2", "op-own-2", otherRow)))
	crossReport := callJSON(other, http.MethodPost, "/api/listing/browser/report", reportTask(first.IntentID, 9))
	assertNoKey(t, crossReport, http.StatusNotFound, "not_found")
	if state := intentState(t, ctx, pool, first.IntentID); state != "submitting" {
		t.Fatal(state)
	}

	reviewer := shop.handler(orgA, userA, "reviewer", false)
	denied := callJSON(reviewer, http.MethodPost, "/api/listing/browser/grant", shop.body("offer-cap", "op-cap", shop.row(t, ctx)))
	assertNoKey(t, denied, http.StatusForbidden, "forbidden")
	deniedReport := callJSON(reviewer, http.MethodPost, "/api/listing/browser/report", reportTask(first.IntentID, 9))
	assertNoKey(t, deniedReport, http.StatusForbidden, "forbidden")
	if state := intentState(t, ctx, pool, first.IntentID); state != "submitting" {
		t.Fatal(state)
	}

	okReport := shop.postReport(t, reportTask(first.IntentID, 9))
	if okReport.Code != http.StatusOK {
		t.Fatal(redact(okReport))
	}
	assertIntent(t, ctx, pool, first.IntentID, "accepted", "9", "accepted")
	if state := intentState(t, ctx, pool, second.IntentID); state != "submitting" {
		t.Fatal(state)
	}
	var otherListing string
	if err := pool.QueryRow(ctx, `SELECT submission_state FROM public.listing_rows WHERE id = $1::uuid`, otherRow).Scan(&otherListing); err != nil || otherListing != "submitting" {
		t.Fatalf("other row %s %v", otherListing, err)
	}

	assertMissingGUC(t, ctx, pool, orgA, shop.storeID, second.IntentID)
	if state := intentState(t, ctx, pool, second.IntentID); state != "submitting" {
		t.Fatal(state)
	}
	tx, err := tenant.BeginApp(ctx, pool.Begin, orgB)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	var seen int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM public.submission_intents WHERE id = $1::uuid`, second.IntentID).Scan(&seen); err != nil || seen != 0 {
		t.Fatalf("org B sees %d %v", seen, err)
	}
}

func TestBrowserDirectWorkerDoesNotDialSubmitting(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	user, org := insertWorkspace(t, ctx, pool, "work-"+uuid.NewString()+"@example.com", "Work")
	ring := seal.Ring{Primary: seal.DeriveKEK("browser-direct-fixture-kek")}
	shop := newGrantShop(t, ctx, pool, org, user, ring, false, farExpiry())
	before := countJobs(t, ctx, pool, org)
	row := shop.row(t, ctx)
	first := parseGrant(t, shop.postGrant(t, shop.body("offer-work", "op-work", row)))
	if countJobs(t, ctx, pool, org) != before {
		t.Fatal("grant enqueued listing.submit")
	}
	if n := countUpstream(t, ctx, pool, org, first.IntentID); n != 0 {
		t.Fatalf("upstream %d", n)
	}
	seed := submit.Seed{
		OrgID: org, StorePK: shop.storePK, StoreID: shop.storeID,
		IntentID: first.IntentID, RowID: row, OfferID: "offer-work",
		RequestHash: "hash-offer-work", RowRevision: 1,
	}
	lease := runningJob(t, ctx, pool, seed, user, false)
	tr := &writeCounter{}
	err := submit.Work(ctx, pool, queue.Claimed{
		ID: lease.ID, OrgID: org, Kind: "listing.submit", SubmitterUserID: user,
		Attempt: 1, MaxAttempts: 8, Epoch: lease.Epoch, Owner: lease.Owner,
		Payload: jobPayload(seed, false),
	}, tr)
	if !errors.Is(err, submit.ErrIllegalEdge) {
		t.Fatal(err)
	}
	if tr.writes.Load() != 0 || tr.reads.Load() != 0 {
		t.Fatalf("writes %d reads %d", tr.writes.Load(), tr.reads.Load())
	}
	if state := intentState(t, ctx, pool, first.IntentID); state != "submitting" {
		t.Fatal(state)
	}
}

func TestBrowserDirectModeRGrantCount(t *testing.T) {
	if err := loadmode.Run(loadmode.ModeR); err != nil {
		t.Fatal(err)
	}
	if err := loadmode.Run("W"); err == nil || !errors.Is(err, loadmode.ErrModeNotAllowed) {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	user, org := insertWorkspace(t, ctx, pool, "mode-"+uuid.NewString()+"@example.com", "Mode")
	ring := seal.Ring{Primary: seal.DeriveKEK("browser-direct-fixture-kek")}
	mock, hits := importMock(t, "ok")
	defer mock.Close()
	if host := mustLoopback(t, mock.URL); host != "127.0.0.1" {
		t.Fatal(host)
	}
	before := deadlocks(t, ctx, pool)
	const n = 8
	shop := newGrantShop(t, ctx, pool, org, user, ring, false, farExpiry())
	row := shop.row(t, ctx)
	bodies := make([]string, n)
	for i := range bodies {
		bodies[i] = shop.body("offer-mode", fmt.Sprintf("op-mode-%d", i), row)
	}
	started := time.Now()
	recs := fanoutGrants(n, func(i int) *httptest.ResponseRecorder {
		return shop.postGrant(t, bodies[i])
	})
	elapsed := time.Since(started)
	ok, busy, other := tallyGrantCodes(t, recs)
	keys := keyAppearances(recs)
	delta := deadlocks(t, ctx, pool) - before
	t.Logf("modeR measured grants=%d winners=%d conflicts=%d other=%d keyAppearances=%d openStore=%d mockHits=%d deadlockDelta=%d elapsedMs=%d",
		n, ok, busy, other, keys, shop.opens.Load(), hits.Load(), delta, elapsed.Milliseconds())
	if ok != 1 || busy != n-1 || other != 0 || keys != 1 || shop.opens.Load() != 1 || hits.Load() != 0 || delta != 0 {
		t.Fatalf("winners %d conflicts %d other %d keys %d opens %d hits %d deadlocks %d",
			ok, busy, other, keys, shop.opens.Load(), hits.Load(), delta)
	}
}

type postedImport struct {
	grantBody
	rowID     string
	status    int
	taskID    int64
	gotStatus bool
}

func grantAndPost(t *testing.T, shop *grantShop, mock *httptest.Server, offer, op, row string) postedImport {
	t.Helper()
	rec := shop.postGrant(t, shop.body(offer, op, row))
	granted := parseGrant(t, rec)
	if strings.Count(rec.Body.String(), fixtureAPIKey) != 1 {
		t.Fatalf("key count %d", strings.Count(rec.Body.String(), fixtureAPIKey))
	}
	status, taskID, got := postImport(t, mock.URL+"/v3/product/import", granted.ClientID, granted.APIKey)
	return postedImport{grantBody: granted, rowID: row, status: status, taskID: taskID, gotStatus: got}
}

func postImport(t *testing.T, rawURL, clientID, apiKey string) (int, int64, bool) {
	t.Helper()
	mustLoopback(t, rawURL)
	req, err := http.NewRequest(http.MethodPost, rawURL, bytes.NewReader([]byte(`{"items":[{"offer_id":"fixture-offer"}]}`)))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Client-Id", clientID)
	req.Header.Set("Api-Key", apiKey)
	client := &http.Client{
		Timeout: 2 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("redirect")
		},
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, 0, false
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		t.Fatal(err)
	}
	var parsed struct {
		Result struct {
			TaskID int64 `json:"task_id"`
		} `json:"result"`
	}
	_ = json.Unmarshal(raw, &parsed)
	return resp.StatusCode, parsed.Result.TaskID, true
}

func importMock(t *testing.T, mode string) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.URL.Path != "/v3/product/import" || r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Client-Id") != fixtureClientID || r.Header.Get("Api-Key") != fixtureAPIKey {
			http.Error(w, "auth", http.StatusUnauthorized)
			return
		}
		switch mode {
		case "ok":
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"result":{"task_id":42}}`))
		case "bad":
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"code":1,"message":"bad row"}`))
		case "drop":
			hj, ok := w.(http.Hijacker)
			if !ok {
				http.Error(w, "hijack", http.StatusInternalServerError)
				return
			}
			conn, _, err := hj.Hijack()
			if err != nil {
				return
			}
			_ = conn.Close()
		default:
			http.Error(w, "mode", http.StatusInternalServerError)
		}
	}))
	mustLoopback(t, srv.URL)
	return srv, &hits
}

func mustLoopback(t *testing.T, rawURL string) string {
	t.Helper()
	u, err := url.Parse(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	if u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost" {
		t.Fatalf("host %s", u.Hostname())
	}
	return u.Hostname()
}

func reportTask(intent string, task int64) string {
	return fmt.Sprintf(`{"intentId":"%s","taskId":%d}`, intent, task)
}

func reportStatus(intent string, status int) string {
	return fmt.Sprintf(`{"intentId":"%s","httpStatus":%d}`, intent, status)
}

func assertIntent(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id, state, task, listing string) {
	t.Helper()
	var gotState, gotTask, gotListing string
	err := pool.QueryRow(ctx, `
		SELECT i.state, COALESCE(i.external_task_id, ''), r.submission_state
		  FROM public.submission_intents i
		  JOIN public.listing_rows r ON r.id = i.listing_row_id
		 WHERE i.id = $1::uuid`, id).Scan(&gotState, &gotTask, &gotListing)
	if err != nil {
		t.Fatal(err)
	}
	if gotState != state || gotTask != task || gotListing != listing {
		t.Fatalf("%s %s %s", gotState, gotTask, gotListing)
	}
}

func fanoutGrants(n int, fn func(int) *httptest.ResponseRecorder) []*httptest.ResponseRecorder {
	out := make([]*httptest.ResponseRecorder, n)
	var wg sync.WaitGroup
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func(i int) {
			defer wg.Done()
			out[i] = fn(i)
		}(i)
	}
	wg.Wait()
	return out
}

func tallyGrantCodes(t *testing.T, recs []*httptest.ResponseRecorder) (ok, busy, other int) {
	t.Helper()
	for _, rec := range recs {
		switch rec.Code {
		case http.StatusOK:
			ok++
		case http.StatusConflict:
			if errorCode(t, rec) != "submission_intents_offer_busy" && errorCode(t, rec) != "grant_in_flight" {
				other++
				t.Errorf("conflict %s", redact(rec))
				continue
			}
			busy++
		default:
			other++
			t.Errorf("status %s", redact(rec))
		}
	}
	return ok, busy, other
}

func keyAppearances(recs []*httptest.ResponseRecorder) int {
	n := 0
	for _, rec := range recs {
		n += strings.Count(rec.Body.String(), fixtureAPIKey)
	}
	return n
}

func fencingIntents(t *testing.T, ctx context.Context, pool *pgxpool.Pool, store string) int {
	t.Helper()
	var n int
	err := pool.QueryRow(ctx, `
		SELECT count(*) FROM public.submission_intents
		 WHERE store_id = $1::uuid
		   AND state IN ('queued', 'submitting', 'unknown', 'accepted')`, store).Scan(&n)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func deadlocks(t *testing.T, ctx context.Context, pool *pgxpool.Pool) int64 {
	t.Helper()
	var n int64
	err := pool.QueryRow(ctx, `
		SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`).Scan(&n)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func errorCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var body struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	return body.Code
}

func redact(rec *httptest.ResponseRecorder) string {
	body := strings.ReplaceAll(rec.Body.String(), fixtureAPIKey, "[key]")
	return fmt.Sprintf("%d %s", rec.Code, body)
}

func keySurfaces(response, logs, audit string) int {
	return strings.Count(response, fixtureAPIKey) + strings.Count(logs, fixtureAPIKey) + strings.Count(audit, fixtureAPIKey)
}

func auditText(t *testing.T, ctx context.Context, pool *pgxpool.Pool) string {
	t.Helper()
	var text string
	err := pool.QueryRow(ctx, `
		SELECT COALESCE(string_agg(
			message || ' ' || entity_id || ' ' || api_path || ' ' || action || ' ' || result || ' ' || status,
			E'\n'), '')
		  FROM public.audit_logs
		 WHERE strpos(message, $1) > 0
		    OR strpos(entity_id, $1) > 0
		    OR strpos(api_path, $1) > 0
		    OR strpos(action, $1) > 0
		    OR strpos(result, $1) > 0
		    OR strpos(status, $1) > 0`, fixtureAPIKey).Scan(&text)
	if err != nil {
		t.Fatal(err)
	}
	return text
}

type logCapture struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *logCapture) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *logCapture) reset() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.b.Reset()
}

func (l *logCapture) text() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

func captureLogs(t *testing.T) *logCapture {
	t.Helper()
	buf := &logCapture{}
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return buf
}

func assertMissingGUC(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org int64, store, intent string) {
	t.Helper()
	bare, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer bare.Release()
	tx, err := bare.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
		t.Fatal(err)
	}
	if err := tenant.RequireOrg(ctx, tx); !errors.Is(err, tenant.ErrOrgUnset) {
		t.Fatal(err)
	}
	var seen int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM public.submission_intents WHERE id = $1::uuid`, intent).Scan(&seen); err != nil || seen != 0 {
		t.Fatalf("missing GUC sees %d %v", seen, err)
	}
	tag, err := tx.Exec(ctx, `
		UPDATE public.submission_intents SET state = 'rejected' WHERE id = $1::uuid`, intent)
	if err == nil && tag.RowsAffected() != 0 {
		t.Fatalf("missing GUC updated %d", tag.RowsAffected())
	}
	row := insertFenceRow(t, ctx, pool, org, store)
	if _, err := tx.Exec(ctx, `
		INSERT INTO submission_intents (
			id, org_id, store_id, listing_row_id, row_revision, client_operation_id, request_hash, state
		) VALUES ($1::uuid, $2, $3::uuid, $4::uuid, 1, 'missing-guc', 'h', 'queued')`,
		uuid.NewString(), org, store, row); err == nil {
		t.Fatal("missing GUC inserted an intent")
	}
}

type writeCounter struct {
	writes atomic.Int32
	reads  atomic.Int32
}

func (w *writeCounter) Write(context.Context, string, []byte) (int, string, error) {
	w.writes.Add(1)
	return http.StatusOK, "", nil
}

func (w *writeCounter) Read(context.Context, string, []byte) (int, string, error) {
	w.reads.Add(1)
	return http.StatusOK, "", nil
}

func (w *writeCounter) WritesDisabled() bool { return false }

func (w *writeCounter) Ready(context.Context) error { return nil }
