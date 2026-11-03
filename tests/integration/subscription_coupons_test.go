package integration

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/xxww0098/podhub-go/internal/billing/contract"
)

func subscriptionCouponFixture(t *testing.T, uses int) subscriptionRuntimeFixture {
	t.Helper()
	f := newSubscriptionRuntimeFixture(t, false)
	if _, err := f.fixture.Exec(f.ctx, `UPDATE account_users SET role='super_admin' WHERE id=96311`); err != nil {
		t.Fatal(err)
	}
	seedMatchingLease(t, f.ctx, f.fixture, "admin", "subscription coupon management")
	f.ownerToken = f.login(t, "a96311@example.invalid")
	body := fmt.Sprintf(`{"code":"team10","discount_percent":10,"max_uses":%d,"starts_at":%q,"expires_at":%q}`, uses, time.Now().Add(-time.Hour).UTC().Format(time.RFC3339), time.Now().Add(time.Hour).UTC().Format(time.RFC3339))
	raw := f.expect(t, http.MethodPost, "/api/admin/subscription-coupons", body, f.ownerToken, http.StatusCreated)
	if !strings.Contains(string(raw), `"code":"TEAM10"`) {
		t.Fatalf("coupon not canonicalized: %s", raw)
	}
	return f
}

func couponQuote(t *testing.T, f subscriptionRuntimeFixture, workspace, token string) contract.Offered {
	t.Helper()
	body := fmt.Sprintf(`{"action":"subscribe","expected_workspace_uuid":%q,"target":{"plan_key":"max","stores":10},"months":12,"coupon_code":" team10 "}`, workspace)
	raw := f.expect(t, http.MethodPost, "/api/billing/quotes", body, token, http.StatusOK)
	var out contract.Offered
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	if out.AmountCents != 259200 || out.Coupon == nil || out.Coupon.Code != "TEAM10" || out.Coupon.DiscountCents != 28800 {
		t.Fatalf("annual + coupon: %s", raw)
	}
	return out
}

func TestSubscriptionCouponConcurrentOrders(t *testing.T) {
	f := subscriptionCouponFixture(t, 1)
	f.expect(t, http.MethodGet, "/api/admin/subscription-coupons", "", f.foreignToken, http.StatusForbidden)
	quotes := []contract.Offered{couponQuote(t, f, f.workspace, f.ownerToken), couponQuote(t, f, f.foreignWorkspace, f.foreignToken)}
	var used int
	if err := f.fixture.QueryRow(f.ctx, `SELECT used_count FROM subscription_coupons WHERE code='TEAM10'`).Scan(&used); err != nil || used != 0 {
		t.Fatalf("quotes consumed uses: %d %v", used, err)
	}
	tokens := []string{f.ownerToken, f.foreignToken}
	responses := make(chan subscriptionHTTPResult, 2)
	for i := range 2 {
		go func() {
			responses <- f.call(http.MethodPost, "/api/billing/orders", subscriptionOrderBody(quotes[i].ID), tokens[i])
		}()
	}
	var success, refused int
	for range 2 {
		res := <-responses
		if res.err != nil {
			t.Fatal(res.err)
		}
		switch res.status {
		case http.StatusCreated:
			success++
		case http.StatusBadRequest:
			refused++
			if !strings.Contains(string(res.body), "COUPON_UNAVAILABLE") {
				t.Fatalf("wrong refusal: %s", res.body)
			}
		default:
			t.Fatalf("order %d %s", res.status, res.body)
		}
	}
	if success != 1 || refused != 1 {
		t.Fatalf("success=%d refused=%d", success, refused)
	}
	var orders, unconsumed int
	var amount int64
	var snapshot []byte
	if err := f.fixture.QueryRow(f.ctx, `SELECT used_count FROM subscription_coupons WHERE code='TEAM10'`).Scan(&used); err != nil || used != 1 {
		t.Fatal(used, err)
	}
	if err := f.fixture.QueryRow(f.ctx, `SELECT count(*),min(amount_cents) FROM payment_orders WHERE product='subscription'`).Scan(&orders, &amount); err != nil || orders != 1 || amount != 259200 {
		t.Fatal(orders, amount, err)
	}
	if err := f.fixture.QueryRow(f.ctx, `SELECT subscription_snapshot FROM payment_orders WHERE product='subscription'`).Scan(&snapshot); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(snapshot), `"CouponCode": "TEAM10"`) || !strings.Contains(string(snapshot), `"年付 8 折"`) {
		t.Fatalf("discount not frozen in order: %s", snapshot)
	}
	if err := f.fixture.QueryRow(f.ctx, `SELECT count(*) FROM subscription_quotes WHERE consumed_at IS NULL`).Scan(&unconsumed); err != nil || unconsumed != 1 {
		t.Fatalf("losing order consumed quote: %d %v", unconsumed, err)
	}
	f.expect(t, http.MethodPut, "/api/admin/subscription-coupons/TEAM10", `{"enabled":false}`, f.ownerToken, http.StatusOK)
	f.expect(t, http.MethodGet, "/api/admin/subscription-coupons", "", f.ownerToken, http.StatusOK)
	f.assertClean(t)
}

func TestSubscriptionCouponRecheckedBeforeOrder(t *testing.T) {
	f := subscriptionCouponFixture(t, 3)
	q := couponQuote(t, f, f.workspace, f.ownerToken)
	if _, err := f.fixture.Exec(f.ctx, `UPDATE subscription_coupons SET expires_at=clock_timestamp()-interval '1 second' WHERE code='TEAM10'`); err != nil {
		t.Fatal(err)
	}
	raw := f.expect(t, http.MethodPost, "/api/billing/orders", subscriptionOrderBody(q.ID), f.ownerToken, http.StatusBadRequest)
	if !strings.Contains(string(raw), "COUPON_UNAVAILABLE") {
		t.Fatal(string(raw))
	}
	var used, orders int
	if err := f.fixture.QueryRow(f.ctx, `SELECT used_count FROM subscription_coupons WHERE code='TEAM10'`).Scan(&used); err != nil || used != 0 {
		t.Fatal(used, err)
	}
	if err := f.fixture.QueryRow(f.ctx, `SELECT count(*) FROM payment_orders WHERE product='subscription'`).Scan(&orders); err != nil || orders != 0 {
		t.Fatal(orders, err)
	}
	f.expect(t, http.MethodPut, "/api/admin/subscription-coupons/TEAM10", `{"enabled":false}`, f.ownerToken, http.StatusOK)
	body := fmt.Sprintf(`{"action":"subscribe","expected_workspace_uuid":%q,"target":{"plan_key":"max","stores":10},"months":12,"coupon_code":"TEAM10"}`, f.workspace)
	f.expect(t, http.MethodPost, "/api/billing/quotes", body, f.ownerToken, http.StatusBadRequest)
	f.assertClean(t)
}

func TestSubscriptionCouponScheduledWindow(t *testing.T) {
	f := subscriptionCouponFixture(t, 5)
	start := time.Now().UTC().Truncate(time.Second).Add(time.Hour)
	end := start.Add(time.Hour)
	body := fmt.Sprintf(`{"code":"scheduled10","discount_percent":10,"max_uses":5,"starts_at":%q,"expires_at":%q}`, start.Format(time.RFC3339), end.Format(time.RFC3339))
	raw := f.expect(t, http.MethodPost, "/api/admin/subscription-coupons", body, f.ownerToken, http.StatusCreated)
	var saved struct {
		Data contract.Coupon `json:"data"`
	}
	if err := json.Unmarshal(raw, &saved); err != nil || !saved.Data.StartsAt.Equal(start) || !saved.Data.ExpiresAt.Equal(end) {
		t.Fatalf("schedule was not persisted: %s %v", raw, err)
	}
	body = fmt.Sprintf(`{"action":"subscribe","expected_workspace_uuid":%q,"target":{"plan_key":"max","stores":10},"months":12,"coupon_code":"SCHEDULED10"}`, f.workspace)
	raw = f.expect(t, http.MethodPost, "/api/billing/quotes", body, f.ownerToken, http.StatusBadRequest)
	if !strings.Contains(string(raw), "COUPON_UNAVAILABLE") {
		t.Fatal(string(raw))
	}
	for _, tc := range []struct {
		name string
		at   time.Time
		want bool
	}{
		{"before start", start.Add(-time.Microsecond), false},
		{"at start", start, true},
		{"before end", end.Add(-time.Microsecond), true},
		{"at end", end, false},
		{"after end", end.Add(time.Microsecond), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var offers int
			if err := f.fixture.QueryRow(f.ctx, `SELECT count(*) FROM public.billing_coupon_offer('SCHEDULED10',$1)`, tc.at).Scan(&offers); err != nil || (offers == 1) != tc.want {
				t.Fatalf("offer: %d, want %v: %v", offers, tc.want, err)
			}
			var consumed bool
			if err := f.fixture.QueryRow(f.ctx, `SELECT public.billing_coupon_consume('SCHEDULED10',10,$1)`, tc.at).Scan(&consumed); err != nil || consumed != tc.want {
				t.Fatalf("consume: %v, want %v: %v", consumed, tc.want, err)
			}
		})
	}
	q := couponQuote(t, f, f.workspace, f.ownerToken)
	if _, err := f.fixture.Exec(f.ctx, `UPDATE subscription_coupons SET starts_at=clock_timestamp()+interval '10 minutes' WHERE code='TEAM10'`); err != nil {
		t.Fatal(err)
	}
	raw = f.expect(t, http.MethodPost, "/api/billing/orders", subscriptionOrderBody(q.ID), f.ownerToken, http.StatusBadRequest)
	if !strings.Contains(string(raw), "COUPON_UNAVAILABLE") {
		t.Fatal(string(raw))
	}
	var used, orders int
	if err := f.fixture.QueryRow(f.ctx, `SELECT used_count FROM subscription_coupons WHERE code='TEAM10'`).Scan(&used); err != nil || used != 0 {
		t.Fatal(used, err)
	}
	if err := f.fixture.QueryRow(f.ctx, `SELECT count(*) FROM payment_orders WHERE product='subscription'`).Scan(&orders); err != nil || orders != 0 {
		t.Fatal(orders, err)
	}
	f.assertClean(t)
}

func TestSubscriptionCouponUnlimited(t *testing.T) {
	f := subscriptionCouponFixture(t, 0)
	quotes := []contract.Offered{couponQuote(t, f, f.workspace, f.ownerToken), couponQuote(t, f, f.foreignWorkspace, f.foreignToken)}
	tokens := []string{f.ownerToken, f.foreignToken}
	responses := make(chan subscriptionHTTPResult, 2)
	for i := range 2 {
		go func() {
			responses <- f.call(http.MethodPost, "/api/billing/orders", subscriptionOrderBody(quotes[i].ID), tokens[i])
		}()
	}
	for range 2 {
		res := <-responses
		if res.err != nil || res.status != http.StatusCreated {
			t.Fatalf("unlimited order: %d %s %v", res.status, res.body, res.err)
		}
	}
	var used int64
	if err := f.fixture.QueryRow(f.ctx, `SELECT used_count FROM subscription_coupons WHERE code='TEAM10' AND max_uses=0`).Scan(&used); err != nil || used != 2 {
		t.Fatalf("unlimited coupon did not count both orders: %d %v", used, err)
	}
	if _, err := f.fixture.Exec(f.ctx, `UPDATE subscription_coupons SET used_count=2147483647 WHERE code='TEAM10'`); err != nil {
		t.Fatal(err)
	}
	var offers int
	var consumed bool
	if err := f.fixture.QueryRow(f.ctx, `SELECT count(*) FROM public.billing_coupon_offer('TEAM10',clock_timestamp())`).Scan(&offers); err != nil || offers != 1 {
		t.Fatal(offers, err)
	}
	if err := f.fixture.QueryRow(f.ctx, `SELECT public.billing_coupon_consume('TEAM10',10,clock_timestamp())`).Scan(&consumed); err != nil || !consumed {
		t.Fatal(consumed, err)
	}
	raw := f.expect(t, http.MethodPut, "/api/admin/subscription-coupons/TEAM10", `{"enabled":false}`, f.ownerToken, http.StatusOK)
	var saved struct {
		Data contract.Coupon `json:"data"`
	}
	if err := json.Unmarshal(raw, &saved); err != nil || saved.Data.MaxUses != 0 || saved.Data.UsedCount != 2147483648 {
		t.Fatalf("unlimited counter was truncated: %s %v", raw, err)
	}
	if err := f.fixture.QueryRow(f.ctx, `SELECT public.billing_coupon_consume('TEAM10',10,clock_timestamp())`).Scan(&consumed); err != nil || consumed {
		t.Fatalf("disabled unlimited coupon remained available: %v %v", consumed, err)
	}
	f.expect(t, http.MethodPut, "/api/admin/subscription-coupons/TEAM10", `{"enabled":true}`, f.ownerToken, http.StatusOK)
	if _, err := f.fixture.Exec(f.ctx, `UPDATE subscription_coupons SET expires_at=clock_timestamp()-interval '1 second' WHERE code='TEAM10'`); err != nil {
		t.Fatal(err)
	}
	if err := f.fixture.QueryRow(f.ctx, `SELECT public.billing_coupon_consume('TEAM10',10,clock_timestamp())`).Scan(&consumed); err != nil || consumed {
		t.Fatalf("expired unlimited coupon remained available: %v %v", consumed, err)
	}
	f.assertClean(t)
}
