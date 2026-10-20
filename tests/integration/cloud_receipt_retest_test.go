package integration

import (
	"context"
	"fmt"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
	"net/http"
	"strings"
	"testing"
	"time"
)

// Local-only functional regression. Uses one synthetic owner and that owner's
// own fixture shop; it does not probe cross-user or cross-store authorization.
func TestCloudRetestReceiptRecovery(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	user, org := insertWorkspace(t, ctx, pool, "retest-"+uuid.NewString()+"@example.com", "Receipt retest")
	ring := seal.Ring{Primary: seal.DeriveKEK("browser-direct-fixture-kek")}
	t.Run("late task acknowledgement after unknown", func(t *testing.T) {
		shop := newGrantShop(t, ctx, pool, org, user, ring, false, farExpiry())
		first := parseGrant(t, shop.postGrant(t, shop.body("offer-late", "op-late", shop.row(t, ctx))))
		initial := shop.postReport(t, `{"intentId":"`+first.IntentID+`"}`)
		if initial.Code != http.StatusOK {
			t.Fatalf("initial no-status report HTTP %d", initial.Code)
		}
		if got := intentState(t, ctx, pool, first.IntentID); got != "unknown" {
			t.Fatalf("initial state %s", got)
		}
		late := shop.postReport(t, `{"intentId":"`+first.IntentID+`","taskId":7}`)
		t.Logf("late receipt HTTP %d; persisted state %s", late.Code, intentState(t, ctx, pool, first.IntentID))
		if late.Code != http.StatusOK {
			t.Fatalf("late accepted receipt should reconcile unknown; HTTP %d", late.Code)
		}
		if got := intentState(t, ctx, pool, first.IntentID); got != "accepted" {
			t.Fatalf("late state %s", got)
		}
	})
	t.Run("identical accepted report replay", func(t *testing.T) {
		shop := newGrantShop(t, ctx, pool, org, user, ring, false, farExpiry())
		first := parseGrant(t, shop.postGrant(t, shop.body("offer-replay", "op-replay", shop.row(t, ctx))))
		body := `{"intentId":"` + first.IntentID + `","taskId":7}`
		if initial := shop.postReport(t, body); initial.Code != http.StatusOK {
			t.Fatalf("initial accepted report HTTP %d", initial.Code)
		}
		retry := shop.postReport(t, body)
		t.Logf("identical replay HTTP %d; persisted state %s", retry.Code, intentState(t, ctx, pool, first.IntentID))
		if retry.Code != http.StatusOK {
			t.Fatalf("identical accepted report replay should be idempotent; HTTP %d", retry.Code)
		}
	})
}

// Every case is a single authorized owner reporting on its own shop. An
// intent ID is the attempt identity; row_revision also fences edited rows.
func TestCloudRetestReceiptOrdering(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	user, org := insertWorkspace(t, ctx, pool, "receipt-order-"+uuid.NewString()+"@example.com", "Receipt ordering")
	ring := seal.Ring{Primary: seal.DeriveKEK("browser-direct-fixture-kek")}
	for _, tc := range []struct{ name, initial, late, state string }{
		{"late accepted", "", `,"taskId":7`, "accepted"},
		{"late rejection", "", `,"httpStatus":422`, "rejected"},
		{"accepted replay", `,"taskId":7`, `,"taskId":7`, "accepted"},
		{"rejection replay", `,"httpStatus":422`, `,"httpStatus":422`, "rejected"},
		{"unknown replay", "", "", "unknown"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			shop := newGrantShop(t, ctx, pool, org, user, ring, false, farExpiry())
			first := parseGrant(t, shop.postGrant(t, shop.body("offer", "operation", shop.row(t, ctx))))
			report := func(suffix string) int { return shop.postReport(t, `{"intentId":"`+first.IntentID+`"`+suffix+`}`).Code }
			if code := report(tc.initial); code != http.StatusOK {
				t.Fatalf("initial HTTP %d", code)
			}
			before := receiptSnapshot(t, ctx, pool, first.IntentID)
			if code := report(tc.late); code != http.StatusOK {
				t.Fatalf("late HTTP %d", code)
			}
			after := receiptSnapshot(t, ctx, pool, first.IntentID)
			if got := intentState(t, ctx, pool, first.IntentID); got != tc.state {
				t.Fatalf("state %s want %s", got, tc.state)
			}
			if tc.initial == tc.late && before != after {
				t.Fatal("replay mutated intent or listing row, including revisions/timestamps")
			}
			if code := report(tc.late); code != http.StatusOK {
				t.Fatalf("repeat HTTP %d", code)
			}
			if after != receiptSnapshot(t, ctx, pool, first.IntentID) {
				t.Fatal("repeat mutated persisted receipt")
			}
			if shop.opens.Load() != 1 {
				t.Fatalf("receipt reopened credentials: %d", shop.opens.Load())
			}
		})
	}
	for _, tc := range []struct{ name, initial, late string }{
		{"accepted cannot become unknown", `,"taskId":7`, ""},
		{"accepted cannot be rejected", `,"taskId":7`, `,"httpStatus":422`},
		{"accepted task cannot change", `,"taskId":7`, `,"taskId":8`},
		{"rejected cannot be accepted", `,"httpStatus":422`, `,"taskId":7`},
		{"rejected cannot become unknown", `,"httpStatus":422`, ""},
		{"rejected reason cannot change", `,"httpStatus":422`, `,"httpStatus":429`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			shop := newGrantShop(t, ctx, pool, org, user, ring, false, farExpiry())
			first := parseGrant(t, shop.postGrant(t, shop.body("offer", "operation", shop.row(t, ctx))))
			initial := shop.postReport(t, `{"intentId":"`+first.IntentID+`"`+tc.initial+`}`)
			if initial.Code != http.StatusOK {
				t.Fatalf("initial HTTP %d", initial.Code)
			}
			before := receiptSnapshot(t, ctx, pool, first.IntentID)
			late := shop.postReport(t, `{"intentId":"`+first.IntentID+`"`+tc.late+`}`)
			if late.Code != http.StatusConflict {
				t.Fatalf("conflicting report HTTP %d", late.Code)
			}
			if before != receiptSnapshot(t, ctx, pool, first.IntentID) {
				t.Fatal("conflict mutated confirmed receipt")
			}
		})
	}
	for _, newerRevision := range []bool{false, true} {
		t.Run(fmt.Sprintf("old attempt cannot overwrite newer attempt/revision_changed_%v", newerRevision), func(t *testing.T) {
			shop := newGrantShop(t, ctx, pool, org, user, ring, false, farExpiry())
			row := shop.row(t, ctx)
			old := parseGrant(t, shop.postGrant(t, shop.body("old-offer", "old-operation", row)))
			if r := shop.postReport(t, `{"intentId":"`+old.IntentID+`"}`); r.Code != http.StatusOK {
				t.Fatalf("unknown HTTP %d", r.Code)
			}
			if newerRevision {
				if _, err := pool.Exec(ctx, `UPDATE public.listing_rows SET revision=revision+1 WHERE id=$1::uuid`, row); err != nil {
					t.Fatal(err)
				}
			}
			body := shop.body("new-offer", "new-operation", row)
			if newerRevision {
				body = strings.Replace(body, `"rowRevision":1`, `"rowRevision":2`, 1)
			}
			// The rate limiter belongs to grants, not receipts. Clear only this synthetic shop's test slot.
			if _, err := pool.Exec(ctx, `DELETE FROM public.lease_budget WHERE scope=$1`, "browser-grant:"+shop.storeID); err != nil {
				t.Fatal(err)
			}
			current := parseGrant(t, shop.postGrant(t, body))
			if r := shop.postReport(t, `{"intentId":"`+current.IntentID+`","taskId":8}`); r.Code != http.StatusOK {
				t.Fatalf("current HTTP %d", r.Code)
			}
			oldBefore := receiptSnapshot(t, ctx, pool, old.IntentID)
			newBefore := receiptSnapshot(t, ctx, pool, current.IntentID)
			if r := shop.postReport(t, `{"intentId":"`+old.IntentID+`","taskId":7}`); r.Code != http.StatusConflict {
				t.Fatalf("stale HTTP %d", r.Code)
			}
			if oldBefore != receiptSnapshot(t, ctx, pool, old.IntentID) || newBefore != receiptSnapshot(t, ctx, pool, current.IntentID) {
				t.Fatal("old attempt overwrote newer confirmed result")
			}
		})
	}
	t.Run("concurrent conflicting receipts preserve one terminal result", func(t *testing.T) {
		shop := newGrantShop(t, ctx, pool, org, user, ring, false, farExpiry())
		first := parseGrant(t, shop.postGrant(t, shop.body("offer", "operation", shop.row(t, ctx))))
		start := make(chan struct{})
		type result struct {
			code     int
			accepted bool
		}
		results := make(chan result, 2)
		for _, accepted := range []bool{true, false} {
			go func(accepted bool) {
				<-start
				suffix := `,"httpStatus":422`
				if accepted {
					suffix = `,"taskId":7`
				}
				rec := callJSON(shop.h, http.MethodPost, "/api/listing/browser/report", `{"intentId":"`+first.IntentID+`"`+suffix+`}`)
				results <- result{rec.Code, accepted}
			}(accepted)
		}
		close(start)
		one, two := <-results, <-results
		if one.code == http.StatusConflict {
			one, two = two, one
		}
		if one.code != http.StatusOK || two.code != http.StatusConflict {
			t.Fatalf("concurrent responses %d, %d", one.code, two.code)
		}
		var state, task, rowState string
		if err := pool.QueryRow(ctx, `SELECT i.state, COALESCE(i.external_task_id,''), r.submission_state FROM public.submission_intents i JOIN public.listing_rows r ON r.id=i.listing_row_id WHERE i.id=$1::uuid`, first.IntentID).Scan(&state, &task, &rowState); err != nil {
			t.Fatal(err)
		}
		if one.accepted {
			if state != "accepted" || task != "7" || rowState != "accepted" {
				t.Fatalf("accepted winner persisted %s/%s/%s", state, task, rowState)
			}
		} else if state != "rejected" || task != "" || rowState != "rejected" {
			t.Fatalf("rejected winner persisted %s/%s/%s", state, task, rowState)
		}
	})
	t.Run("concurrent identical receipts mutate once", func(t *testing.T) {
		shop := newGrantShop(t, ctx, pool, org, user, ring, false, farExpiry())
		first := parseGrant(t, shop.postGrant(t, shop.body("offer", "operation", shop.row(t, ctx))))
		body := `{"intentId":"` + first.IntentID + `","taskId":7}`
		var revisionBefore int64
		if err := pool.QueryRow(ctx, `SELECT view_revision FROM public.listing_rows WHERE id=(SELECT listing_row_id FROM public.submission_intents WHERE id=$1::uuid)`, first.IntentID).Scan(&revisionBefore); err != nil {
			t.Fatal(err)
		}
		start := make(chan struct{})
		results := make(chan int, 8)
		for i := 0; i < 8; i++ {
			go func() {
				<-start
				results <- callJSON(shop.h, http.MethodPost, "/api/listing/browser/report", body).Code
			}()
		}
		close(start)
		for i := 0; i < 8; i++ {
			if code := <-results; code != http.StatusOK {
				t.Errorf("concurrent HTTP %d", code)
			}
		}
		var revisionAfter int64
		if err := pool.QueryRow(ctx, `SELECT view_revision FROM public.listing_rows WHERE id=(SELECT listing_row_id FROM public.submission_intents WHERE id=$1::uuid)`, first.IntentID).Scan(&revisionAfter); err != nil {
			t.Fatal(err)
		}
		if revisionAfter-revisionBefore != 2 {
			t.Fatalf("concurrent reports changed view_revision by %d, want one intent touch plus one row update", revisionAfter-revisionBefore)
		}
		before := receiptSnapshot(t, ctx, pool, first.IntentID)
		if r := shop.postReport(t, body); r.Code != http.StatusOK {
			t.Fatalf("replay HTTP %d", r.Code)
		}
		if before != receiptSnapshot(t, ctx, pool, first.IntentID) {
			t.Fatal("concurrent result not idempotent")
		}
	})
}

func receiptSnapshot(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id string) string {
	t.Helper()
	var snapshot string
	if err := pool.QueryRow(ctx, `SELECT jsonb_build_object('intent',to_jsonb(i),'row',to_jsonb(r))::text FROM public.submission_intents i JOIN public.listing_rows r ON r.id=i.listing_row_id WHERE i.id=$1::uuid`, id).Scan(&snapshot); err != nil {
		t.Fatal(err)
	}
	return snapshot
}
