package integration

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/go-chi/chi/v5"
	billinghttp "github.com/xxww0098/podhub-go/internal/billing/http"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	storedomain "github.com/xxww0098/podhub-go/internal/store/domain"
	storerepo "github.com/xxww0098/podhub-go/internal/store/repo"
	"github.com/xxww0098/podhub-go/tests/testkit"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/xxww0098/podhub-go/internal/billing/contract"
	"github.com/xxww0098/podhub-go/internal/billing/domain"
	billingrepo "github.com/xxww0098/podhub-go/internal/billing/repo"
	"github.com/xxww0098/podhub-go/internal/listing/submit"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
)

func subscriptionTime(month time.Month, day int) time.Time {
	return time.Date(2026, month, day, 10, 0, 0, 0, domain.Shanghai)
}
func subscriptionTenant(t *testing.T) (context.Context, *pgxpool.Pool, int64, int64) {
	t.Helper()
	ctx := context.Background()
	pool := migratedPool(t, ctx)
	org, user := seedAITenant(t, ctx, pool, 96171)
	if _, err := pool.Exec(ctx, `INSERT INTO subscriptions(org_id,status,plan_key,updated_at) VALUES($1,'free','free',clock_timestamp())`, org); err != nil {
		t.Fatal(err)
	}
	return ctx, pool, org, user
}
func subscriptionPay(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org, user int64, q contract.Offered, now time.Time) string {
	t.Helper()
	agreement, _ := json.Marshal(map[string]string{"version": "test", "title": "test", "effective_at": "2026-10-21", "content": "test", "accepted_at": now.Format(time.RFC3339), "accepted_by": fmt.Sprint(user)})
	order, err := billingrepo.CreateSubscriptionOrder(ctx, pool, org, user, "po_"+uuid.NewString(), "manual", "CNY", q.ID, agreement, now)
	if err != nil {
		t.Fatal(err)
	}
	if err = db.InTx(ctx, pool, db.App(org), func(tx pgx.Tx) error {
		o, err := billingrepo.LoadOrder(ctx, tx, order.PublicID)
		if err != nil {
			return err
		}
		if _, err = billingrepo.MarkOrderPaid(ctx, tx, o.ID, "test", now); err != nil {
			return err
		}
		if err = billingrepo.FulfillSubscription(ctx, tx, o, now); err != nil {
			return err
		}
		return billingrepo.FulfillSubscription(ctx, tx, o, now) // replay cannot duplicate the purchased interval
	}); err != nil {
		t.Fatal(err)
	}
	return order.PublicID
}
func subscriptionPreview(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org int64, req contract.QuoteRequest, now time.Time) contract.Offered {
	t.Helper()
	q, err := billingrepo.Quote(ctx, pool, org, req, now)
	if err != nil {
		t.Fatal(err)
	}
	return q
}
func subscriptionRead(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org int64, now time.Time) contract.View {
	t.Helper()
	v, err := billingrepo.SubscriptionView(ctx, pool, org, now)
	if err != nil {
		t.Fatal(err)
	}
	return v
}
func subscriptionAllowed(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org int64, id string, now time.Time) bool {
	t.Helper()
	var allowed bool
	if err := pool.QueryRow(ctx, `SELECT public.subscription_store_allowed($1,$2::uuid,$3)`, org, id, now).Scan(&allowed); err != nil {
		t.Fatal(err)
	}
	return allowed
}

func TestSubscriptionPaidPeriods(t *testing.T) {
	ctx, pool, org, user := subscriptionTenant(t)
	now := subscriptionTime(10, 21)
	boundary := subscriptionTime(11, 21)
	target := contract.Target{PlanKey: "lite", ExtraStores: 3}
	q := subscriptionPreview(t, ctx, pool, org, contract.QuoteRequest{Action: "subscribe", Target: target, Months: 1}, now)
	if q.AmountCents != 16000 {
		t.Fatalf("first month: %d", q.AmountCents)
	}
	subscriptionPay(t, ctx, pool, org, user, q, now)
	stores := []string{}
	for i := 0; i < 7; i++ {
		id := uuid.NewString()
		stores = append(stores, id)
		seedCompanyStore(t, ctx, pool, org, id, i+1, fmt.Sprintf("Store %d", i+1), nil)
	}
	keep := append([]string{}, stores[1:]...) // Keep the newer stores, never creation-order substitution.
	before := subscriptionRead(t, ctx, pool, org, now)
	req := contract.QuoteRequest{Action: "schedule", Target: contract.Target{PlanKey: "lite", ExtraStores: 1}, Months: 1, KeepStores: keep}
	q = subscriptionPreview(t, ctx, pool, org, req, subscriptionTime(10, 30))
	after := subscriptionRead(t, ctx, pool, org, now)
	if before.Revision != after.Revision || after.Next.Stores != 8 {
		t.Fatal("preview changed renewal")
	}
	stale := subscriptionPreview(t, ctx, pool, org, req, subscriptionTime(10, 30))
	if err := billingrepo.ConfirmSchedule(ctx, pool, org, q.ID, false, subscriptionTime(10, 30)); err != nil {
		t.Fatal(err)
	}
	if err := billingrepo.ConfirmSchedule(ctx, pool, org, stale.ID, false, subscriptionTime(10, 30)); err == nil {
		t.Fatal("stale admin overwrite accepted")
	}
	after = subscriptionRead(t, ctx, pool, org, subscriptionTime(10, 30))
	if after.Stores.Limit != 8 || after.Next.Stores != 6 || after.NextRenewal.AmountCents != 12000 {
		t.Fatalf("schedule: %+v", after)
	}
	q = subscriptionPreview(t, ctx, pool, org, contract.QuoteRequest{Action: "renew", Months: 1}, subscriptionTime(11, 10))
	subscriptionPay(t, ctx, pool, org, user, q, subscriptionTime(11, 10))
	after = subscriptionRead(t, ctx, pool, org, subscriptionTime(11, 10))
	if after.Stores.Limit != 8 || !after.CurrentEnd.Equal(boundary) || !after.TermEnd.Equal(subscriptionTime(12, 21)) {
		t.Fatalf("early renewal changed current: %+v", after)
	}
	// Access is correct at the boundary before any background sweep.
	if !subscriptionAllowed(t, ctx, pool, org, stores[0], boundary.Add(-time.Nanosecond)) {
		t.Fatal("paid capacity ended early")
	}
	if subscriptionAllowed(t, ctx, pool, org, stores[0], boundary) {
		t.Fatal("unselected store admitted after boundary")
	}
	if !subscriptionAllowed(t, ctx, pool, org, stores[6], boundary) {
		t.Fatal("explicit retained store lost access")
	}
	atBoundary := subscriptionRead(t, ctx, pool, org, boundary)
	if atBoundary.Stores.Limit != 6 {
		t.Fatalf("boundary capacity=%d", atBoundary.Stores.Limit)
	}
	t.Run("paused store only finishes existing work", func(t *testing.T) {
		row := insertFenceRow(t, ctx, pool, org, stores[0])
		intent := uuid.NewString()
		if _, err := pool.Exec(ctx, `INSERT INTO submission_intents
			(id,org_id,store_id,listing_row_id,row_revision,client_operation_id,request_hash,state,offer_id)
			VALUES($1::uuid,$2,$3::uuid,$4::uuid,1,'before-boundary','hash','submitting','existing-offer')`, intent, org, stores[0], row); err != nil {
			t.Fatal(err)
		}
		_, err := submit.Grant(ctx, pool, submit.GrantInput{
			OrgID: org, UserID: user, StoreID: stores[0], ListingRowID: row, RowRevision: 1,
			ClientOperationID: "after-boundary", RequestHash: "hash", OfferID: "new-offer", Now: boundary,
		}, func(context.Context) error { return nil }, func(seal.Store) (seal.Secret, error) {
			t.Fatal("paused store opened credentials for new work")
			return seal.Secret{}, nil
		})
		var refusal submit.Status
		if !errors.As(err, &refusal) || refusal.Code != 402 || refusal.Kind != "SUBSCRIPTION_STORE_PAUSED" {
			t.Fatalf("new work at boundary: %v", err)
		}
		if _, err := pool.Exec(ctx, `UPDATE organization_stores SET quota_suspended=true WHERE org_id=$1 AND uuid=$2::uuid`, org, stores[0]); err != nil {
			t.Fatal(err)
		}
		reported, err := submit.Report(ctx, pool, submit.ReportInput{OrgID: org, IntentID: intent, TaskID: 123, HasTask: true})
		if err != nil || reported.State != submit.Accepted {
			t.Fatalf("receipt after pause: %+v %v", reported, err)
		}
		var count int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM submission_intents WHERE org_id=$1 AND store_id=$2::uuid`, org, stores[0]).Scan(&count); err != nil || count != 1 {
			t.Fatalf("paused store created new intents: %d %v", count, err)
		}
	})
	// Free reversal applies only to unpaid configuration. This future month already costs 40 yuan to restore.
	restore := true
	q = subscriptionPreview(t, ctx, pool, org, contract.QuoteRequest{Action: "change", Target: target, Months: 1, RenewWithChange: &restore}, subscriptionTime(11, 12))
	if q.AmountCents != 4000 {
		t.Fatalf("restore already paid future: %d", q.AmountCents)
	}
	subscriptionPay(t, ctx, pool, org, user, q, subscriptionTime(11, 12))
	if v := subscriptionRead(t, ctx, pool, org, subscriptionTime(11, 12)); v.Stores.Limit != 8 || v.Periods[len(v.Periods)-1].Stores != 8 {
		t.Fatalf("restore future: %+v", v)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM subscription_events WHERE org_id=$1 AND order_id IS NOT NULL`, org).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 3 {
		t.Fatalf("replayed payment events=%d", count)
	}
}

func TestSubscriptionTemporaryAddonsKeepRenewal(t *testing.T) {
	ctx, pool, org, user := subscriptionTenant(t)
	now := subscriptionTime(10, 21)
	q := subscriptionPreview(t, ctx, pool, org, contract.QuoteRequest{Action: "subscribe", Target: contract.Target{PlanKey: "lite", ExtraStores: 3, ExtraMembers: 2}, Months: 3}, now)
	subscriptionPay(t, ctx, pool, org, user, q, now)
	q = subscriptionPreview(t, ctx, pool, org, contract.QuoteRequest{Action: "schedule", Target: contract.Target{PlanKey: "lite", ExtraStores: 1}}, subscriptionTime(11, 1))
	if err := billingrepo.ConfirmSchedule(ctx, pool, org, q.ID, false, subscriptionTime(11, 1)); err != nil {
		t.Fatal(err)
	}
	v := subscriptionRead(t, ctx, pool, org, subscriptionTime(11, 1))
	if !v.Next.EffectiveAt.Equal(time.Date(2027, 1, 21, 10, 0, 0, 0, domain.Shanghai)) {
		t.Fatal("prepaid months shortened")
	}
	q = subscriptionPreview(t, ctx, pool, org, contract.QuoteRequest{Action: "change", Target: contract.Target{PlanKey: "lite", ExtraStores: 5, ExtraMembers: 2}}, subscriptionTime(11, 1))
	if q.Renewal.ExtraStores != 1 || q.Renewal.ExtraMembers != 2 {
		t.Fatalf("temporary addition reset renewal: %+v", q)
	}
	subscriptionPay(t, ctx, pool, org, user, q, subscriptionTime(11, 1))
	v = subscriptionRead(t, ctx, pool, org, subscriptionTime(11, 1))
	if v.Stores.Limit != 10 || v.Next.Stores != 6 || v.Next.ExtraMembers != 2 {
		t.Fatalf("temporary addition: %+v", v)
	}
	expired := subscriptionRead(t, ctx, pool, org, time.Date(2027, 1, 21, 10, 0, 0, 0, domain.Shanghai))
	if expired.Status != "expired" || expired.Stores.Limit != 1 {
		t.Fatal("unpaid renewal granted access")
	}
}

func TestSubscriptionListsAndPendingOrder(t *testing.T) {
	ctx, pool, org, user := subscriptionTenant(t)
	now := subscriptionTime(10, 21)
	q := subscriptionPreview(t, ctx, pool, org, contract.QuoteRequest{Action: "subscribe", Target: contract.Target{PlanKey: "lite", ExtraStores: 3}}, now)
	subscriptionPay(t, ctx, pool, org, user, q, now)
	for i := 0; i < 7; i++ {
		seedCompanyStore(t, ctx, pool, org, uuid.NewString(), i+1, "S", nil)
	}
	_, err := billingrepo.Quote(ctx, pool, org, contract.QuoteRequest{Action: "schedule", Target: contract.Target{PlanKey: "lite", ExtraStores: 1}}, now)
	var refusal *domain.QuoteError
	if !errors.As(err, &refusal) || refusal.Code != domain.CodeCapacityBelowUsage {
		t.Fatalf("missing list: %v", err)
	}
	// Raising unpaid renewal capacity is free even when it exceeds currently paid capacity.
	q = subscriptionPreview(t, ctx, pool, org, contract.QuoteRequest{Action: "schedule", Target: contract.Target{PlanKey: "lite", ExtraStores: 4}}, now)
	renewal := subscriptionPreview(t, ctx, pool, org, contract.QuoteRequest{Action: "renew", Months: 1}, now)
	agreement := []byte(fmt.Sprintf(`{"version":"t","title":"t","effective_at":"t","content":"t","accepted_at":"t","accepted_by":"%d"}`, user))
	_, err = billingrepo.CreateSubscriptionOrder(ctx, pool, org, user, "po_"+uuid.NewString(), "manual", "CNY", renewal.ID, agreement, now)
	if err != nil {
		t.Fatal(err)
	}
	if err = billingrepo.ConfirmSchedule(ctx, pool, org, q.ID, false, now); err == nil {
		t.Fatal("changed frozen pending order silently")
	}
	if err = billingrepo.ConfirmSchedule(ctx, pool, org, q.ID, true, now); err != nil {
		t.Fatal(err)
	}
	v := subscriptionRead(t, ctx, pool, org, now)
	if v.Next.Stores != 9 || v.PendingOrder {
		t.Fatal("explicit cancel and edit did not commit")
	}
}

func TestSubscriptionFutureKeepAndDeletedStore(t *testing.T) {
	ctx, pool, org, user := subscriptionTenant(t)
	now := subscriptionTime(10, 21)
	q := subscriptionPreview(t, ctx, pool, org, contract.QuoteRequest{Action: "subscribe", Target: contract.Target{PlanKey: "lite", ExtraStores: 3}}, now)
	subscriptionPay(t, ctx, pool, org, user, q, now)
	ids := []string{}
	for i := 0; i < 7; i++ {
		id := uuid.NewString()
		ids = append(ids, id)
		seedCompanyStore(t, ctx, pool, org, id, i+1, "S", nil)
	}
	q = subscriptionPreview(t, ctx, pool, org, contract.QuoteRequest{Action: "schedule", Target: contract.Target{PlanKey: "lite", ExtraStores: 1}, KeepStores: ids[1:]}, now)
	if err := billingrepo.ConfirmSchedule(ctx, pool, org, q.ID, false, now); err != nil {
		t.Fatal(err)
	}
	// Deleting a retained store leaves its place idle; it must not be substituted.
	if _, err := pool.Exec(ctx, `UPDATE organization_stores SET deleted_at_ms=1 WHERE uuid=$1`, ids[6]); err != nil {
		t.Fatal(err)
	}
	q = subscriptionPreview(t, ctx, pool, org, contract.QuoteRequest{Action: "renew"}, subscriptionTime(11, 10))
	subscriptionPay(t, ctx, pool, org, user, q, subscriptionTime(11, 10))
	if subscriptionAllowed(t, ctx, pool, org, ids[0], subscriptionTime(11, 21)) {
		t.Fatal("deleted retained store silently replaced")
	}
	v := subscriptionRead(t, ctx, pool, org, subscriptionTime(11, 10))
	future := v.Periods[len(v.Periods)-1]
	q = subscriptionPreview(t, ctx, pool, org, contract.QuoteRequest{Action: "keep", PeriodID: future.ID, Target: future.Target, KeepStores: ids[:5]}, subscriptionTime(11, 11))
	if q.AmountCents != 0 || !q.ScheduleOnly {
		t.Fatal("same-capacity keep list charged")
	}
	if err := billingrepo.ConfirmSchedule(ctx, pool, org, q.ID, false, subscriptionTime(11, 11)); err != nil {
		t.Fatal(err)
	}
	if !subscriptionAllowed(t, ctx, pool, org, ids[0], subscriptionTime(11, 21)) {
		t.Fatal("changed future keep list ignored")
	}
	if !subscriptionAllowed(t, ctx, pool, org, ids[5], subscriptionTime(11, 20)) {
		t.Fatal("future keep change affected current period")
	}
}

func TestSubscriptionPaidAfterCancel(t *testing.T) {
	ctx, pool, org, user := subscriptionTenant(t)
	now := subscriptionTime(10, 21)
	q := subscriptionPreview(t, ctx, pool, org, contract.QuoteRequest{Action: "subscribe", Target: contract.Target{PlanKey: "lite", ExtraStores: 3}}, now)
	subscriptionPay(t, ctx, pool, org, user, q, now)
	q = subscriptionPreview(t, ctx, pool, org, contract.QuoteRequest{Action: "renew"}, subscriptionTime(11, 10))
	agreement := []byte(fmt.Sprintf(`{"version":"t","title":"t","effective_at":"t","content":"t","accepted_at":"t","accepted_by":"%d"}`, user))
	pending, err := billingrepo.CreateSubscriptionOrder(ctx, pool, org, user, "po_"+uuid.NewString(), "easypay", "CNY", q.ID, agreement, subscriptionTime(11, 10))
	if err != nil {
		t.Fatal(err)
	}
	change := subscriptionPreview(t, ctx, pool, org, contract.QuoteRequest{Action: "schedule", Target: contract.Target{PlanKey: "lite", ExtraStores: 1}}, subscriptionTime(11, 10))
	if err = billingrepo.ConfirmSchedule(ctx, pool, org, change.ID, true, subscriptionTime(11, 10)); err == nil {
		t.Fatal("external payment was canceled without channel confirmation")
	}
	if _, err = pool.Exec(ctx, `UPDATE payment_orders SET status='canceled' WHERE public_id=$1`, pending.PublicID); err != nil {
		t.Fatal(err)
	}
	if err = billingrepo.ConfirmSchedule(ctx, pool, org, change.ID, true, subscriptionTime(11, 10)); err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	billinghttp.Register(router, billinghttp.Deps{Pool: pool, Now: func() time.Time { return subscriptionTime(11, 11) }, Payments: billinghttp.Payments{EasyPayPID: "1000", EasyPayKey: "secret"}})
	form := map[string]string{"pid": "1000", "money": "160.00", "out_trade_no": pending.PublicID, "trade_no": "subscription-late-trade", "trade_status": "TRADE_SUCCESS"}
	form["sign"] = domain.EasyPayMD5(form, "secret")
	body := url.Values{}
	for k, v := range form {
		body.Set(k, v)
	}
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest("POST", "/api/billing/webhooks/easypay", strings.NewReader(body.Encode()))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != 200 {
			t.Fatalf("late callback: %d %s", rec.Code, rec.Body.String())
		}
	}
	v := subscriptionRead(t, ctx, pool, org, subscriptionTime(11, 11))
	if v.Next.Stores != 6 || len(v.Periods) != 2 || v.Periods[1].Stores != 8 {
		t.Fatalf("paid late must fulfill frozen order and preserve new renewal: %+v", v)
	}
	var status string
	if err = pool.QueryRow(ctx, `SELECT status FROM payment_orders WHERE public_id=$1`, pending.PublicID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "paid" {
		t.Fatal("lost payment fact")
	}
}

func TestSubscriptionFulfillmentFailureKeepsReceipt(t *testing.T) {
	ctx, pool, org, user := subscriptionTenant(t)
	now := subscriptionTime(10, 21)
	q := subscriptionPreview(t, ctx, pool, org, contract.QuoteRequest{Action: "subscribe", Target: contract.Target{PlanKey: "lite"}}, now)
	agreement := []byte(fmt.Sprintf(`{"version":"t","title":"t","effective_at":"t","content":"t","accepted_at":"t","accepted_by":"%d"}`, user))
	pending, err := billingrepo.CreateSubscriptionOrder(ctx, pool, org, user, "po_"+uuid.NewString(), "manual", "CNY", q.ID, agreement, now)
	if err != nil {
		t.Fatal(err)
	}
	err = db.InTx(ctx, pool, db.App(org), func(tx pgx.Tx) error {
		order, err := billingrepo.LoadOrder(ctx, tx, pending.PublicID)
		if err != nil {
			return err
		}
		var raw map[string]json.RawMessage
		if err = json.Unmarshal(order.SubscriptionSnapshot, &raw); err != nil {
			return err
		}
		var period map[string]any
		if err = json.Unmarshal(raw["period"], &period); err != nil {
			return err
		}
		period["plan_members"] = 0
		raw["period"], _ = json.Marshal(period)
		order.SubscriptionSnapshot, _ = json.Marshal(raw)
		if _, err = billingrepo.MarkOrderPaid(ctx, tx, order.ID, "paid", now); err != nil {
			return err
		}
		return billingrepo.FulfillPaidSubscription(ctx, tx, order, now)
	})
	if err != nil {
		t.Fatal(err)
	}
	var status string
	var reason *string
	var periods int
	if err = pool.QueryRow(ctx, `SELECT status,reconciliation_reason,(SELECT count(*) FROM subscription_periods WHERE org_id=$2) FROM payment_orders WHERE public_id=$1`, pending.PublicID, org).Scan(&status, &reason, &periods); err != nil {
		t.Fatal(err)
	}
	if status != "paid" || reason == nil || periods != 0 {
		t.Fatalf("receipt rollback: %s %v periods=%d", status, reason, periods)
	}
}

func TestSubscriptionHTTPContract(t *testing.T) {
	ctx, pool, org, user := subscriptionTenant(t)
	now := subscriptionTime(10, 21)
	var workspace string
	if err := pool.QueryRow(ctx, `SELECT uuid::text FROM organizations WHERE id=$1`, org).Scan(&workspace); err != nil {
		t.Fatal(err)
	}
	spec, err := testkit.LoadOpenAPI()
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	billinghttp.Register(router, billinghttp.Deps{Pool: pool, Now: func() time.Time { return now }, Access: access.FixedResolver{Principal: &access.Principal{OrgID: org, UserID: user, WorkspaceRole: "owner"}}})
	call := func(method, path, specPath, body string, status int) []byte {
		t.Helper()
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		router.ServeHTTP(rec, req)
		if rec.Code != status {
			t.Fatalf("%s %s: %d %s", method, path, rec.Code, rec.Body.String())
		}
		if err := spec.CheckResponse(method, specPath, rec.Code, rec.Header(), rec.Body.Bytes()); err != nil {
			t.Fatalf("%s: %v\n%s", path, err, rec.Body.String())
		}
		return rec.Body.Bytes()
	}
	call("GET", "/api/billing/subscription", "/api/billing/subscription", "", 200)
	call("POST", "/api/billing/quotes", "/api/billing/quotes", `{"action":"subscribe","target":{"plan_key":"lite"}}`, 400)
	raw := call("POST", "/api/billing/quotes", "/api/billing/quotes", fmt.Sprintf(`{"expected_workspace_uuid":"%s","action":"subscribe","target":{"plan_key":"lite","extra_stores":3,"extra_members":0}}`, workspace), 200)
	var q contract.Offered
	if err = json.Unmarshal(raw, &q); err != nil {
		t.Fatal(err)
	}
	call("POST", "/api/billing/orders", "/api/billing/orders", fmt.Sprintf(`{"quote_id":"%s","accepted_version":"obsolete"}`, q.ID), 400)
	raw = call("POST", "/api/billing/orders", "/api/billing/orders", fmt.Sprintf(`{"quote_id":"%s","accepted_version":"subscription-2026-10-21"}`, q.ID), 201)
	var order contract.OrderBrief
	if err = json.Unmarshal(raw, &order); err != nil {
		t.Fatal(err)
	}
	call("GET", "/api/billing/orders/"+order.PublicID, "/api/billing/orders/{public_id}", "", 200)
	if err = db.InTx(ctx, pool, db.App(org), func(tx pgx.Tx) error {
		o, err := billingrepo.LoadOrder(ctx, tx, order.PublicID)
		if err != nil {
			return err
		}
		if _, err = billingrepo.MarkOrderPaid(ctx, tx, o.ID, "test", now); err != nil {
			return err
		}
		return billingrepo.FulfillSubscription(ctx, tx, o, now)
	}); err != nil {
		t.Fatal(err)
	}
	raw = call("POST", "/api/billing/quotes", "/api/billing/quotes", fmt.Sprintf(`{"expected_workspace_uuid":"%s","action":"schedule","target":{"plan_key":"lite","extra_stores":1,"extra_members":0}}`, workspace), 200)
	if err = json.Unmarshal(raw, &q); err != nil {
		t.Fatal(err)
	}
	call("POST", "/api/billing/schedule", "/api/billing/schedule", fmt.Sprintf(`{"quote_id":"%s","cancel_pending":false}`, q.ID), 200)
}

func TestSubscriptionBoundarySweepAndOrderReaper(t *testing.T) {
	ctx, pool, org, user := subscriptionTenant(t)
	now := subscriptionTime(10, 21)
	q := subscriptionPreview(t, ctx, pool, org, contract.QuoteRequest{Action: "subscribe", Target: contract.Target{PlanKey: "lite", ExtraStores: 3}}, now)
	subscriptionPay(t, ctx, pool, org, user, q, now)
	q = subscriptionPreview(t, ctx, pool, org, contract.QuoteRequest{Action: "schedule", Target: contract.Target{PlanKey: "lite", ExtraStores: 1}}, now)
	if err := billingrepo.ConfirmSchedule(ctx, pool, org, q.ID, false, now); err != nil {
		t.Fatal(err)
	}
	q = subscriptionPreview(t, ctx, pool, org, contract.QuoteRequest{Action: "renew"}, subscriptionTime(11, 10))
	subscriptionPay(t, ctx, pool, org, user, q, subscriptionTime(11, 10))
	n, err := billingrepo.ExpireDue(ctx, pool, 200, subscriptionTime(11, 21))
	if err != nil || n != 1 {
		t.Fatalf("activate future: %d %v", n, err)
	}
	var limit int
	if err = pool.QueryRow(ctx, `SELECT store_limit FROM organizations WHERE id=$1`, org).Scan(&limit); err != nil {
		t.Fatal(err)
	}
	if limit != 6 {
		t.Fatalf("sweep capacity %d", limit)
	}
	n, err = billingrepo.ExpireDue(ctx, pool, 200, subscriptionTime(12, 21))
	if err != nil || n != 1 {
		t.Fatalf("expire: %d %v", n, err)
	}
	if _, err = billingrepo.FinishDrains(ctx, pool, subscriptionTime(12, 23)); err != nil {
		t.Fatal(err)
	}
}

func TestSubscriptionGrowthKeepsSelectedStoresAndAllocatesCurrentVacancy(t *testing.T) {
	ctx, pool, org, user := subscriptionTenant(t)
	now := time.Now().Add(-time.Minute)
	q := subscriptionPreview(t, ctx, pool, org, contract.QuoteRequest{Action: "subscribe", Target: contract.Target{PlanKey: "lite", ExtraStores: 3}}, now)
	subscriptionPay(t, ctx, pool, org, user, q, now)
	ids := []string{}
	for i := 0; i < 15; i++ {
		id := uuid.NewString()
		ids = append(ids, id)
		seedCompanyStore(t, ctx, pool, org, id, i+1, "S", nil)
	}
	keep := ids[9:]
	if _, err := pool.Exec(ctx, `UPDATE subscription_periods SET keep_store_ids=$2 WHERE org_id=$1`, org, keep); err != nil {
		t.Fatal(err)
	}
	q = subscriptionPreview(t, ctx, pool, org, contract.QuoteRequest{Action: "schedule", Target: contract.Target{PlanKey: "lite", ExtraStores: 1}, KeepStores: keep}, now)
	if err := billingrepo.ConfirmSchedule(ctx, pool, org, q.ID, false, now); err != nil {
		t.Fatal(err)
	}
	at := time.Now()
	q = subscriptionPreview(t, ctx, pool, org, contract.QuoteRequest{Action: "change", Target: contract.Target{PlanKey: "lite", ExtraStores: 5}}, at)
	subscriptionPay(t, ctx, pool, org, user, q, at)
	if !subscriptionAllowed(t, ctx, pool, org, ids[14], at) {
		t.Fatal("growth replaced an already retained store with an older one")
	}
	var member int64
	if err := pool.QueryRow(ctx, `SELECT id FROM organization_members WHERE org_id=$1 AND user_id=$2`, org, user).Scan(&member); err != nil {
		t.Fatal(err)
	}
	var newID string
	err := db.InTx(ctx, pool, db.App(org), func(tx pgx.Tx) error {
		row, _, err := storerepo.CreateStore(ctx, tx, org, storedomain.Actor{UserID: user, MembershipID: member, Role: "owner"}, storerepo.CreateInput{Name: "New current store"})
		if err == nil {
			newID = row.UUID
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if !subscriptionAllowed(t, ctx, pool, org, newID, time.Now()) {
		t.Fatal("new store could not use a current vacant purchased slot")
	}
	v := subscriptionRead(t, ctx, pool, org, time.Now())
	if v.Next.Stores != 6 {
		t.Fatal("creating a store canceled the renewal reduction")
	}
	for _, id := range v.Next.KeepStores {
		if id == newID {
			t.Fatal("new store silently replaced a future reservation")
		}
	}
}

func TestSubscriptionUpgradeRetainsAlreadyPaidExtras(t *testing.T) {
	ctx, pool, org, user := subscriptionTenant(t)
	now := subscriptionTime(10, 21)
	q := subscriptionPreview(t, ctx, pool, org, contract.QuoteRequest{Action: "subscribe", Target: contract.Target{PlanKey: "lite", ExtraStores: 3, ExtraMembers: 2}}, now)
	subscriptionPay(t, ctx, pool, org, user, q, now)
	q = subscriptionPreview(t, ctx, pool, org, contract.QuoteRequest{Action: "change", Target: contract.Target{PlanKey: "pro", ExtraStores: 1}}, subscriptionTime(10, 30))
	if q.Target.Stores != 33 || q.Target.Members != 8 {
		t.Fatalf("preview lost paid capacity: %+v", q.Target)
	}
	subscriptionPay(t, ctx, pool, org, user, q, subscriptionTime(10, 30))
	v := subscriptionRead(t, ctx, pool, org, subscriptionTime(10, 30))
	if v.Stores.Limit != 33 || v.Members.Limit != 8 {
		t.Fatalf("upgrade lost paid add-ons: %+v", v)
	}
}
