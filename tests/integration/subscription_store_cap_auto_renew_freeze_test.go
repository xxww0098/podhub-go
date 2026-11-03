package integration

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	billingcontract "github.com/xxww0098/podhub-go/internal/billing/contract"
	"github.com/xxww0098/podhub-go/internal/billing/domain"
	billinghttp "github.com/xxww0098/podhub-go/internal/billing/http"
	billingrepo "github.com/xxww0098/podhub-go/internal/billing/repo"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/tests/testkit"
)

type autoOrder struct {
	PublicID, Provider, Status string
	Amount                     int64
	Deadline                   *time.Time
	AutoEnd                    *time.Time
	HasAgreement               bool
}

func autoOrders(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org int64) []autoOrder {
	t.Helper()
	rows, err := pool.Query(ctx, `SELECT public_id,provider,status,amount_cents,payment_deadline_at,auto_term_end,purchase_agreement IS NOT NULL
		FROM payment_orders WHERE org_id=$1 AND product='subscription' ORDER BY id`, org)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []autoOrder
	for rows.Next() {
		var o autoOrder
		if err := rows.Scan(&o.PublicID, &o.Provider, &o.Status, &o.Amount, &o.Deadline, &o.AutoEnd, &o.HasAgreement); err != nil {
			t.Fatal(err)
		}
		out = append(out, o)
	}
	return out
}

func buySubscription(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org, user int64, plan string, stores int, now time.Time) {
	t.Helper()
	q := subscriptionPreview(t, ctx, pool, org, billingcontract.QuoteRequest{Action: "subscribe", Target: billingcontract.Target{PlanKey: plan, Stores: stores}, Months: 1}, now)
	subscriptionPay(t, ctx, pool, org, user, q, now)
}

func notificationCount(t *testing.T, ctx context.Context, pool *pgxpool.Pool, user int64, kind string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM notifications WHERE user_id=$1 AND kind=$2`, user, kind).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// Bought 10-21 10:00, so the paid end is 11-21 10:00 and the order is issued
// from 11-18 10:00 (72h before).
func TestAutoRenewIssuesOneUnpaidOrderInsideTheLeadWindow(t *testing.T) {
	ctx, pool, org, user := subscriptionTenant(t)
	buySubscription(t, ctx, pool, org, user, "lite", 8, subscriptionTime(10, 21))
	end := time.Date(2026, 11, 21, 10, 0, 0, 0, domain.Shanghai)

	if n, err := billingrepo.IssueDueRenewals(ctx, pool, subscriptionTime(11, 17)); err != nil || n != 0 {
		t.Fatalf("outside the window: issued=%d err=%v", n, err)
	}
	if n, err := billingrepo.IssueDueRenewals(ctx, pool, subscriptionTime(11, 19)); err != nil || n != 1 {
		t.Fatalf("inside the window: issued=%d err=%v", n, err)
	}
	// The sweep runs every minute; it must not issue again.
	for _, at := range []time.Time{subscriptionTime(11, 19), subscriptionTime(11, 20)} {
		if n, err := billingrepo.IssueDueRenewals(ctx, pool, at); err != nil || n != 0 {
			t.Fatalf("second sweep: issued=%d err=%v", n, err)
		}
	}
	orders := autoOrders(t, ctx, pool, org)
	if len(orders) != 2 {
		t.Fatalf("orders=%d, want the purchase and one renewal", len(orders))
	}
	auto := orders[1]
	if auto.Provider != "unselected" || auto.Status != "pending" || auto.Amount != 8*2000 || auto.HasAgreement {
		t.Fatalf("auto order: %+v", auto)
	}
	if auto.AutoEnd == nil || !auto.AutoEnd.Equal(end) || auto.Deadline == nil || !auto.Deadline.Equal(end) {
		t.Fatalf("auto order is tied to the paid end %v: %+v", end, auto)
	}
	if got := notificationCount(t, ctx, pool, user, "subscription_renewal_due"); got != 1 {
		t.Fatalf("renewal notifications=%d", got)
	}
	v := subscriptionRead(t, ctx, pool, org, subscriptionTime(11, 19))
	if !v.PendingOrder || v.PendingProvider != "unselected" || v.PendingAmountCents != 16000 || v.Frozen || !v.AutoRenew || v.StoreCap != 100 {
		t.Fatalf("view: %+v", v)
	}
}

func TestAutoRenewOrderIsPaidByPickingAChannelAndExtendsTheTerm(t *testing.T) {
	ctx, pool, org, user := subscriptionTenant(t)
	buySubscription(t, ctx, pool, org, user, "lite", 8, subscriptionTime(10, 21))
	if _, err := billingrepo.IssueDueRenewals(ctx, pool, subscriptionTime(11, 19)); err != nil {
		t.Fatal(err)
	}
	auto := autoOrders(t, ctx, pool, org)[1]
	agreement, _ := json.Marshal(map[string]string{"version": "v", "title": "t", "effective_at": "2026-10-30", "content": "c",
		"accepted_at": subscriptionTime(11, 19).Format(time.RFC3339), "accepted_by": fmt.Sprint(user)})
	pay := subscriptionTime(11, 19)
	brief, err := billingrepo.PayAutoOrder(ctx, pool, org, user, auto.PublicID, "manual", agreement, pay)
	if err != nil {
		t.Fatal(err)
	}
	if brief.PaymentDeadlineAt == nil || !brief.PaymentDeadlineAt.Equal(pay.Add(billingrepo.PaymentWindow)) {
		t.Fatalf("payment window starts at confirmation, not issue: %+v", brief)
	}
	if _, err := billingrepo.PayAutoOrder(ctx, pool, org, user, auto.PublicID, "manual", agreement, pay); err == nil {
		t.Fatal("an order that already has a channel must not be confirmed twice")
	}
	got := autoOrders(t, ctx, pool, org)[1]
	if got.Provider != "manual" || !got.HasAgreement {
		t.Fatalf("after confirm: %+v", got)
	}
	// Settle it the way the callback does and check the next month is bought
	// from the old paid end, not from payment time.
	if err := settleOrder(t, ctx, pool, org, auto.PublicID, pay); err != nil {
		t.Fatal(err)
	}
	v := subscriptionRead(t, ctx, pool, org, subscriptionTime(11, 22))
	want := time.Date(2026, 12, 21, 10, 0, 0, 0, domain.Shanghai)
	if v.TermEnd == nil || !v.TermEnd.Equal(want) || v.Frozen || v.Stores.Limit != 8 {
		t.Fatalf("renewed 11-21 -> 12-21 with 8 stores: %+v", v)
	}
	if n, err := billingrepo.IssueDueRenewals(ctx, pool, subscriptionTime(11, 22)); err != nil || n != 0 {
		t.Fatalf("a paid end already renewed: issued=%d err=%v", n, err)
	}
}

func TestReconfiguringReplacesTheUnselectedAutoOrder(t *testing.T) {
	ctx, pool, org, user := subscriptionTenant(t)
	buySubscription(t, ctx, pool, org, user, "lite", 8, subscriptionTime(10, 21))
	if _, err := billingrepo.IssueDueRenewals(ctx, pool, subscriptionTime(11, 19)); err != nil {
		t.Fatal(err)
	}
	// The buyer picks a smaller renewal instead: no "cancel pending" flag, the
	// system's own proposal is simply replaced.
	q := subscriptionPreview(t, ctx, pool, org, billingcontract.QuoteRequest{Action: "renew", Target: billingcontract.Target{PlanKey: "lite", Stores: 3}, Months: 1}, subscriptionTime(11, 19))
	agreement, _ := json.Marshal(map[string]string{"version": "v", "title": "t", "effective_at": "e", "content": "c",
		"accepted_at": "a", "accepted_by": fmt.Sprint(user)})
	if _, err := billingrepo.CreateSubscriptionOrder(ctx, pool, org, user, "po_"+uuid.NewString(), "manual", "CNY", q.ID, agreement, subscriptionTime(11, 19)); err != nil {
		t.Fatalf("auto order must not block a new purchase: %v", err)
	}
	orders := autoOrders(t, ctx, pool, org)
	if len(orders) != 3 || orders[1].Status != "canceled" || orders[1].AutoEnd != nil || orders[2].Status != "pending" || orders[2].Amount != 3*2000 {
		t.Fatalf("orders: %+v", orders)
	}
}

func TestTurningAutoRenewOffStopsIssuingAndOnAllowsIt(t *testing.T) {
	ctx, pool, org, user := subscriptionTenant(t)
	buySubscription(t, ctx, pool, org, user, "pro", 4, subscriptionTime(10, 21))
	if err := billingrepo.SetAutoRenew(ctx, pool, org, false, subscriptionTime(11, 1)); err != nil {
		t.Fatal(err)
	}
	if n, err := billingrepo.IssueDueRenewals(ctx, pool, subscriptionTime(11, 19)); err != nil || n != 0 {
		t.Fatalf("off: issued=%d err=%v", n, err)
	}
	if err := billingrepo.SetAutoRenew(ctx, pool, org, true, subscriptionTime(11, 19)); err != nil {
		t.Fatal(err)
	}
	if n, err := billingrepo.IssueDueRenewals(ctx, pool, subscriptionTime(11, 19)); err != nil || n != 1 {
		t.Fatalf("on again: issued=%d err=%v", n, err)
	}
	// Switching off with an unpaid auto order closes it, and this paid end is
	// not proposed again even after the next sweep.
	if err := billingrepo.SetAutoRenew(ctx, pool, org, false, subscriptionTime(11, 20)); err != nil {
		t.Fatal(err)
	}
	if o := autoOrders(t, ctx, pool, org)[1]; o.Status != "canceled" {
		t.Fatalf("off must close the unpaid auto order: %+v", o)
	}
	if n, err := billingrepo.IssueDueRenewals(ctx, pool, subscriptionTime(11, 20)); err != nil || n != 0 {
		t.Fatalf("off after cancel: issued=%d err=%v", n, err)
	}
}

func TestPaidWorkspaceFreezesAtExpiryAndFreeWorkspaceDoesNot(t *testing.T) {
	ctx, pool, org, user := subscriptionTenant(t)
	storeID := uuid.NewString()
	seedCompanyStore(t, ctx, pool, org, storeID, 1, "S", nil)

	free := subscriptionRead(t, ctx, pool, org, subscriptionTime(10, 1))
	if free.Frozen || free.Stores.Limit != 1 || !subscriptionAllowed(t, ctx, pool, org, storeID, subscriptionTime(10, 1)) {
		t.Fatalf("a workspace that never paid keeps its free store: %+v", free)
	}

	buySubscription(t, ctx, pool, org, user, "lite", 5, subscriptionTime(10, 21))
	if !subscriptionAllowed(t, ctx, pool, org, storeID, subscriptionTime(11, 20)) {
		t.Fatal("store must run inside the paid term")
	}
	end := time.Date(2026, 11, 21, 10, 0, 0, 0, domain.Shanghai)
	if !subscriptionAllowed(t, ctx, pool, org, storeID, end.Add(-time.Second)) {
		t.Fatal("store must run until the last second")
	}
	if subscriptionAllowed(t, ctx, pool, org, storeID, end) {
		t.Fatal("store must be refused at the paid end")
	}
	v := subscriptionRead(t, ctx, pool, org, end.Add(time.Hour))
	if !v.Frozen || v.Stores.Limit != 0 || v.Status != "expired" {
		t.Fatalf("expired view: %+v", v)
	}
	if n, err := billingrepo.ExpireDue(ctx, pool, 200, end.Add(time.Minute)); err != nil || n != 1 {
		t.Fatalf("expire: %d %v", n, err)
	}
	if got := notificationCount(t, ctx, pool, user, "subscription_frozen"); got != 1 {
		t.Fatalf("freeze notifications=%d", got)
	}
	var suspended bool
	if err := pool.QueryRow(ctx, `SELECT quota_suspended FROM organization_stores WHERE org_id=$1 AND uuid=$2::uuid`, org, storeID).Scan(&suspended); err != nil || !suspended {
		t.Fatalf("store is shown as suspended: %v %v", suspended, err)
	}
	// Renewing lifts the freeze.
	buySubscription(t, ctx, pool, org, user, "lite", 5, end.Add(2*time.Hour))
	if !subscriptionAllowed(t, ctx, pool, org, storeID, end.Add(3*time.Hour)) {
		t.Fatal("renewal must lift the freeze")
	}
}

func TestStoreLimitOverrideWinsOverTheFreeze(t *testing.T) {
	ctx, pool, org, user := subscriptionTenant(t)
	storeID := uuid.NewString()
	seedCompanyStore(t, ctx, pool, org, storeID, 1, "S", nil)
	buySubscription(t, ctx, pool, org, user, "lite", 2, subscriptionTime(10, 21))
	if _, err := pool.Exec(ctx, `UPDATE organizations SET store_limit_override=3 WHERE id=$1`, org); err != nil {
		t.Fatal(err)
	}
	if !subscriptionAllowed(t, ctx, pool, org, storeID, subscriptionTime(12, 30)) {
		t.Fatal("an administrator grant must not be frozen by expiry")
	}
}

// The Go constant and the SQL constraint are the same number; the schema is
// the last line of defence against a path that skips paidTarget.
func TestStoreCapMatchesTheDatabaseConstraint(t *testing.T) {
	ctx, pool, org, _ := subscriptionTenant(t)
	insert := func(stores int, start time.Time) error {
		_, err := pool.Exec(ctx, `INSERT INTO subscription_periods(org_id,starts_at,ends_at,plan_key,stores,store_monthly_cents)
			VALUES($1,$2,$3,'lite',$4,2000)`, org, start, start.AddDate(0, 1, 0), stores)
		return err
	}
	if err := insert(domain.StoreCap, subscriptionTime(1, 1)); err != nil {
		t.Fatalf("%d stores must be accepted: %v", domain.StoreCap, err)
	}
	if err := insert(domain.StoreCap+1, subscriptionTime(3, 1)); err == nil {
		t.Fatalf("%d stores must be refused by the CHECK constraint", domain.StoreCap+1)
	}
	if err := insert(0, subscriptionTime(5, 1)); err == nil {
		t.Fatal("0 stores must be refused")
	}
}

func TestStoreCapRefusedOverHTTP(t *testing.T) {
	ctx, pool, org, user := subscriptionTenant(t)
	var workspace string
	if err := pool.QueryRow(ctx, `SELECT uuid::text FROM organizations WHERE id=$1`, org).Scan(&workspace); err != nil {
		t.Fatal(err)
	}
	spec, err := testkit.LoadOpenAPI()
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	billinghttp.Register(router, billinghttp.Deps{Billing: billingHTTPPort(), Pool: pool, Now: func() time.Time { return subscriptionTime(10, 21) },
		Access: access.FixedResolver{Principal: &access.Principal{OrgID: org, UserID: user, WorkspaceRole: "owner"}}})
	post := func(stores int) (int, string) {
		body := fmt.Sprintf(`{"expected_workspace_uuid":%q,"action":"subscribe","target":{"plan_key":"lite","stores":%d}}`, workspace, stores)
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/api/billing/quotes", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		router.ServeHTTP(rec, req)
		if err := spec.CheckResponse("POST", "/api/billing/quotes", rec.Code, rec.Header(), rec.Body.Bytes()); err != nil {
			t.Fatalf("%d stores: %v\n%s", stores, err, rec.Body.String())
		}
		return rec.Code, rec.Body.String()
	}
	if code, body := post(100); code != 200 {
		t.Fatalf("100 stores: %d %s", code, body)
	}
	if code, body := post(101); code != 400 || !strings.Contains(body, "STORE_CAP_EXCEEDED") {
		t.Fatalf("101 stores: %d %s", code, body)
	}
}

func TestAutoRenewEndpointsMatchOpenAPI(t *testing.T) {
	ctx, pool, org, user := subscriptionTenant(t)
	buySubscription(t, ctx, pool, org, user, "lite", 8, subscriptionTime(10, 21))
	if _, err := billingrepo.IssueDueRenewals(ctx, pool, subscriptionTime(11, 19)); err != nil {
		t.Fatal(err)
	}
	pending := autoOrders(t, ctx, pool, org)[1].PublicID
	spec, err := testkit.LoadOpenAPI()
	if err != nil {
		t.Fatal(err)
	}
	now := subscriptionTime(11, 19)
	router := chi.NewRouter()
	billinghttp.Register(router, billinghttp.Deps{Billing: billingHTTPPort(), Pool: pool, Now: func() time.Time { return now },
		Access: access.FixedResolver{Principal: &access.Principal{OrgID: org, UserID: user, WorkspaceRole: "owner"}}})
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
	call("PUT", "/api/billing/auto-renew", "/api/billing/auto-renew", `{}`, 400)
	call("POST", "/api/billing/orders/"+pending+"/pay", "/api/billing/orders/{public_id}/pay", `{"accepted_version":"obsolete"}`, 400)
	call("POST", "/api/billing/orders/"+pending+"/pay", "/api/billing/orders/{public_id}/pay", `{"accepted_version":"subscription-2026-10-31","provider":"unselected"}`, 400)
	raw := call("POST", "/api/billing/orders/"+pending+"/pay", "/api/billing/orders/{public_id}/pay", `{"accepted_version":"subscription-2026-10-31"}`, 200)
	var brief billingcontract.OrderBrief
	if err := json.Unmarshal(raw, &brief); err != nil || brief.PublicID != pending {
		t.Fatalf("brief: %s %v", raw, err)
	}
	call("POST", "/api/billing/orders/"+pending+"/pay", "/api/billing/orders/{public_id}/pay", `{"accepted_version":"subscription-2026-10-31"}`, 409)
	raw = call("PUT", "/api/billing/auto-renew", "/api/billing/auto-renew", `{"enabled":false}`, 200)
	var view billingcontract.View
	if err := json.Unmarshal(raw, &view); err != nil || view.AutoRenew {
		t.Fatalf("toggle: %s %v", raw, err)
	}
}

// settleOrder marks an order paid and fulfils it the way the webhook does.
func settleOrder(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org int64, publicID string, now time.Time) error {
	t.Helper()
	return db.InTx(ctx, pool, db.App(org), func(tx pgx.Tx) error {
		o, err := billingrepo.LoadOrder(ctx, tx, publicID)
		if err != nil {
			return err
		}
		if _, err = billingrepo.MarkOrderPaid(ctx, tx, o.ID, "test", now); err != nil {
			return err
		}
		return billingrepo.FulfillSubscription(ctx, tx, o, now)
	})
}
