package integration

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/xxww0098/podhub-go/internal/billing/contract"
	"github.com/xxww0098/podhub-go/internal/billing/domain"
	billingrepo "github.com/xxww0098/podhub-go/internal/billing/repo"
	"github.com/xxww0098/podhub-go/tests/testkit"
)

func TestPlanRedeemIssuesAndPreservesPaidPeriods(t *testing.T) {
	f := newRedeemFixture(t)
	spec, err := testkit.LoadOpenAPI()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO subscriptions(org_id,status,plan_key,updated_at) VALUES($1,'free','free',clock_timestamp())`, f.org); err != nil {
		t.Fatal(err)
	}
	stores := make([]string, 3)
	for i := range stores {
		stores[i] = uuid.NewString()
		seedCompanyStore(t, f.ctx, f.pool, f.org, stores[i], i+1, fmt.Sprintf("Store %d", i+1), nil)
	}
	create := func(plan string, capacity, months int) issuedCode {
		t.Helper()
		body := fmt.Sprintf(`{"plan_key":%q,"plan_stores":%d,"plan_months":%d,"quantity":1}`, plan, capacity, months)
		response := adminPost(f.handler, "redeem-admin", "/api/admin/redeem-codes", body)
		if response.Code != http.StatusCreated {
			t.Fatalf("create: %d %s", response.Code, response.Body.String())
		}
		if err := spec.CheckResponse("POST", "/api/admin/redeem-codes", response.Code, response.Header(), response.Body.Bytes()); err != nil {
			t.Fatalf("create response contract: %v", err)
		}
		codes := decodeCodes(t, response.Body.Bytes())
		if len(codes) != 1 || !strings.HasPrefix(codes[0].Code, "POD-PLAN-") {
			t.Fatalf("issued codes: %+v", codes)
		}
		return codes[0]
	}
	first := create("pro", 2, 1)
	if _, err := f.pool.Exec(f.ctx, `UPDATE plans SET store_monthly_cents=9999 WHERE key='pro'`); err != nil {
		t.Fatal(err)
	}
	response := f.redeem(first.Code)
	if response.Code != http.StatusOK {
		t.Fatalf("first redeem: %d %s", response.Code, response.Body.String())
	}
	if err := spec.CheckResponse("POST", "/api/redeem", response.Code, response.Header(), response.Body.Bytes()); err != nil {
		t.Fatalf("redeem response contract: %v", err)
	}
	var result struct {
		PlanKey string    `json:"plan_key"`
		Starts  time.Time `json:"starts_at"`
		Ends    time.Time `json:"ends_at"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil || result.PlanKey != "pro" || !result.Ends.Equal(domain.AnchoredEnd(result.Starts, result.Starts, 1)) {
		t.Fatalf("redeem result: %+v, %v", result, err)
	}
	var price int64
	var keep []string
	if err := f.pool.QueryRow(f.ctx, `SELECT store_monthly_cents,keep_store_ids FROM subscription_periods WHERE redeem_code_id=$1`, first.ID).Scan(&price, &keep); err != nil || price != 2500 || len(keep) != 2 || keep[0] != stores[0] || keep[1] != stores[1] {
		t.Fatalf("snapshot price=%d keep=%v err=%v", price, keep, err)
	}
	if !subscriptionAllowed(t, f.ctx, f.pool, f.org, stores[0], result.Starts) || subscriptionAllowed(t, f.ctx, f.pool, f.org, stores[2], result.Starts) {
		t.Fatal("redeemed capacity did not choose the first two stores")
	}
	if replay := f.redeem(first.Code); replay.Code != http.StatusBadRequest {
		t.Fatalf("replay: %d %s", replay.Code, replay.Body.String())
	}
	second := create("max", 1, 3)
	response = f.redeem(second.Code)
	if response.Code != http.StatusOK {
		t.Fatalf("second redeem: %d %s", response.Code, response.Body.String())
	}
	var next struct {
		Starts time.Time `json:"starts_at"`
		Ends   time.Time `json:"ends_at"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &next); err != nil || !next.Starts.Equal(result.Ends) || !next.Ends.Equal(domain.AnchoredEnd(result.Starts, result.Ends, 3)) {
		t.Fatalf("scheduled result: %+v, %v", next, err)
	}
	current := subscriptionRead(t, f.ctx, f.pool, f.org, time.Now())
	if current.Stores.Limit != 2 || len(current.Periods) != 2 || current.Periods[0].PlanKey != "pro" || current.Periods[1].PlanKey != "max" {
		t.Fatalf("current and future periods: %+v", current)
	}
	if !subscriptionAllowed(t, f.ctx, f.pool, f.org, stores[1], result.Ends.Add(-time.Microsecond)) || subscriptionAllowed(t, f.ctx, f.pool, f.org, stores[1], result.Ends) {
		t.Fatal("existing capacity was not preserved to the exact boundary")
	}
	if balance := walletBalance(t, f.ctx, f.pool, f.org); balance != 0 {
		t.Fatalf("plan code changed wallet balance: %d", balance)
	}
	third, fourth := create("lite", 1, 1), create("pro", 1, 1)
	results := make(chan string, 2)
	for _, code := range []string{third.Code, fourth.Code} {
		go func(code string) {
			response := f.redeem(code)
			if response.Code == http.StatusOK {
				results <- ""
			} else {
				results <- fmt.Sprintf("%d %s", response.Code, response.Body.String())
			}
		}(code)
	}
	for range 2 {
		if result := <-results; result != "" {
			t.Fatalf("concurrent redeem: %s", result)
		}
	}
	var contiguous bool
	if err := f.pool.QueryRow(f.ctx, `SELECT count(*)=2 AND min(starts_at)=$3 AND max(ends_at) > $3
		AND max(starts_at) = min(ends_at) FROM subscription_periods
		WHERE org_id=$1 AND redeem_code_id=ANY($2::bigint[])`, f.org, []int64{third.ID, fourth.ID}, next.Ends).Scan(&contiguous); err != nil || !contiguous {
		t.Fatalf("concurrent periods did not append contiguously: %v", err)
	}
}

func TestPlanRedeemPendingOrderDoesNotConsumeCode(t *testing.T) {
	f := newRedeemFixture(t)
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO subscriptions(org_id,status,plan_key,updated_at) VALUES($1,'free','free',clock_timestamp())`, f.org); err != nil {
		t.Fatal(err)
	}
	issued := adminPost(f.handler, "redeem-admin", "/api/admin/redeem-codes", `{"plan_key":"lite","plan_stores":1,"plan_months":1,"quantity":1}`)
	if issued.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", issued.Code, issued.Body.String())
	}
	code := decodeCodes(t, issued.Body.Bytes())[0]
	now := time.Now().UTC()
	quote := subscriptionPreview(t, f.ctx, f.pool, f.org, contract.QuoteRequest{Action: "subscribe", Target: contract.Target{PlanKey: "lite", Stores: 1}, Months: 1}, now)
	agreement, _ := json.Marshal(map[string]string{"version": "test", "title": "test", "effective_at": "2026-10-21", "content": "test", "accepted_at": now.Format(time.RFC3339), "accepted_by": fmt.Sprint(f.user)})
	if _, err := billingrepo.CreateSubscriptionOrder(f.ctx, f.pool, f.org, f.user, "po_"+uuid.NewString(), "manual", "CNY", quote.ID, agreement, now); err != nil {
		t.Fatal(err)
	}
	response := f.redeem(code.Code)
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "PENDING_ORDER_EXISTS") {
		t.Fatalf("pending order: %d %s", response.Code, response.Body.String())
	}
	var used bool
	var periods int
	if err := f.pool.QueryRow(f.ctx, `SELECT used, (SELECT count(*) FROM subscription_periods WHERE org_id=$2) FROM redeem_codes WHERE id=$1`, code.ID, f.org).Scan(&used, &periods); err != nil || used || periods != 0 {
		t.Fatalf("refusal changed code or periods: used=%v periods=%d err=%v", used, periods, err)
	}
}

func TestPlanRedeemReplacesUnselectedAutoRenewal(t *testing.T) {
	f := newRedeemFixture(t)
	now := time.Now().UTC().Truncate(time.Microsecond)
	start, end := now.Add(-29*24*time.Hour), now.Add(time.Hour)
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO subscriptions
		(org_id,status,plan_key,term_start,term_end,stores,billing_anchor,updated_at)
		VALUES($1,'active','lite',$2,$3,1,$2,$4)`, f.org, start, end, now); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO subscription_periods
		(org_id,starts_at,ends_at,plan_key,stores,store_monthly_cents)
		VALUES($1,$2,$3,'lite',1,2000)`, f.org, start, end); err != nil {
		t.Fatal(err)
	}
	if n, err := billingrepo.IssueDueRenewals(f.ctx, f.pool, now); err != nil || n != 1 {
		t.Fatalf("automatic order: issued=%d err=%v", n, err)
	}
	issued := adminPost(f.handler, "redeem-admin", "/api/admin/redeem-codes", `{"plan_key":"pro","plan_stores":1,"plan_months":1,"quantity":1}`)
	if issued.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", issued.Code, issued.Body.String())
	}
	response := f.redeem(decodeCodes(t, issued.Body.Bytes())[0].Code)
	if response.Code != http.StatusOK {
		t.Fatalf("redeem: %d %s", response.Code, response.Body.String())
	}
	var status string
	var autoEnd *time.Time
	if err := f.pool.QueryRow(f.ctx, `SELECT status, auto_term_end FROM payment_orders WHERE org_id=$1 AND provider='unselected'`, f.org).Scan(&status, &autoEnd); err != nil || status != "canceled" || autoEnd != nil {
		t.Fatalf("old auto renewal: status=%q auto_end=%v err=%v", status, autoEnd, err)
	}
}
