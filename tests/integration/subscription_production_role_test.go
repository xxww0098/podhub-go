package integration

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/xxww0098/podhub-go/internal/app"
	"github.com/xxww0098/podhub-go/internal/billing/contract"
	"github.com/xxww0098/podhub-go/internal/billing/domain"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/internal/platform/db"
)

type subscriptionRuntimeFixture struct {
	identityRuntimeFixture
	server                                           *httptest.Server
	org, ownerMembership, member, memberMembership   int64
	workspace, foreignWorkspace, store, foreignStore string
	ownerToken, memberToken, foreignToken            string
}

type subscriptionHTTPResult struct {
	status int
	body   []byte
	header http.Header
	err    error
}

func newSubscriptionRuntimeFixture(t *testing.T, active bool) subscriptionRuntimeFixture {
	t.Helper()
	base := newIdentityRuntimeFixture(t)
	f := subscriptionRuntimeFixture{identityRuntimeFixture: base, server: httptest.NewServer(base.handler), store: uuid.NewString(), foreignStore: uuid.NewString()}
	t.Cleanup(f.server.Close)
	var foreignOrg int64
	if err := f.fixture.QueryRow(f.ctx, `SELECT o.id,o.uuid::text,m.id FROM organizations o JOIN organization_members m ON m.org_id=o.id AND m.role='owner' WHERE o.owner_user_id=96311`).Scan(&f.org, &f.workspace, &f.ownerMembership); err != nil {
		t.Fatal(err)
	}
	if err := f.fixture.QueryRow(f.ctx, `SELECT id,uuid::text FROM organizations WHERE owner_user_id=96312`).Scan(&foreignOrg, &f.foreignWorkspace); err != nil {
		t.Fatal(err)
	}
	if _, err := f.fixture.Exec(f.ctx, `INSERT INTO subscriptions(org_id,status,plan_key,updated_at) VALUES($1,'free','free',clock_timestamp()),($2,'free','free',clock_timestamp())`, f.org, foreignOrg); err != nil {
		t.Fatal(err)
	}
	if err := f.fixture.QueryRow(f.ctx, `INSERT INTO account_users(public_id,email,password_hash,name,created_at,updated_at) SELECT gen_random_uuid()::text,'subscription-member@example.invalid',password_hash,'Subscription member',clock_timestamp(),clock_timestamp() FROM account_users WHERE id=96311 RETURNING id`).Scan(&f.member); err != nil {
		t.Fatal(err)
	}
	f.memberMembership = seedCompanyMember(t, f.ctx, f.fixture, f.org, f.member, "member", 2)
	seedCompanyStore(t, f.ctx, f.fixture, f.org, f.store, 1, "Owned store", nil)
	seedCompanyStore(t, f.ctx, f.fixture, foreignOrg, f.foreignStore, 1, "Foreign private store", nil)
	if active {
		if _, err := f.fixture.Exec(f.ctx, `UPDATE subscriptions SET status='active',plan_key='lite',stores=8,term_start=clock_timestamp()-interval '1 day',term_end=clock_timestamp()+interval '29 days',billing_anchor=clock_timestamp()-interval '1 day' WHERE org_id=$1`, f.org); err != nil {
			t.Fatal(err)
		}
		if _, err := f.fixture.Exec(f.ctx, `INSERT INTO subscription_periods(org_id,starts_at,ends_at,plan_key,stores,store_monthly_cents) SELECT org_id,term_start,term_end,'lite',8,2000 FROM subscriptions WHERE org_id=$1`, f.org); err != nil {
			t.Fatal(err)
		}
	}
	f.ownerToken = f.login(t, "a96311@example.invalid")
	f.memberToken = f.login(t, "subscription-member@example.invalid")
	f.foreignToken = f.login(t, "a96312@example.invalid")
	f.assertClean(t)
	return f
}

func (f subscriptionRuntimeFixture) call(method, path, body, token string) subscriptionHTTPResult {
	r, err := http.NewRequestWithContext(f.ctx, method, f.server.URL+path, strings.NewReader(body))
	if err != nil {
		return subscriptionHTTPResult{err: err}
	}
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Idempotency-Key", uuid.NewString())
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := f.server.Client().Do(r)
	if err != nil {
		return subscriptionHTTPResult{err: err}
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	return subscriptionHTTPResult{status: response.StatusCode, body: raw, header: response.Header, err: err}
}

func (f subscriptionRuntimeFixture) expect(t *testing.T, method, path, body, token string, want int) []byte {
	t.Helper()
	result := f.call(method, path, body, token)
	if result.err != nil || result.status != want {
		t.Fatalf("%s %s: status=%d want=%d body=%s err=%v", method, path, result.status, want, result.body, result.err)
	}
	return result.body
}

func (f subscriptionRuntimeFixture) login(t *testing.T, email string) string {
	t.Helper()
	raw := f.expect(t, http.MethodPost, "/api/auth/login", fmt.Sprintf(`{"email":%q,"password":"original-password"}`, email), "", http.StatusOK)
	var result struct {
		Data struct {
			Token string `json:"token"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &result); err != nil || result.Data.Token == "" {
		t.Fatalf("login token: %s err=%v", raw, err)
	}
	return result.Data.Token
}

func (f subscriptionRuntimeFixture) quote(t *testing.T, action string, stores, months int) contract.Offered {
	t.Helper()
	body := fmt.Sprintf(`{"expected_workspace_uuid":%q,"action":%q,"target":{"plan_key":"lite","stores":%d},"months":%d}`, f.workspace, action, stores, months)
	raw := f.expect(t, http.MethodPost, "/api/billing/quotes", body, f.ownerToken, http.StatusOK)
	var q contract.Offered
	if err := json.Unmarshal(raw, &q); err != nil || q.ID == "" {
		t.Fatalf("quote: %s err=%v", raw, err)
	}
	return q
}

func (f subscriptionRuntimeFixture) view(t *testing.T) contract.View {
	t.Helper()
	result := f.call(http.MethodGet, "/api/billing/subscription", "", f.ownerToken)
	var view contract.View
	if result.err != nil || result.status != http.StatusOK || json.Unmarshal(result.body, &view) != nil || result.header.Get("Cache-Control") != "no-store" {
		t.Fatalf("view: status=%d body=%s err=%v", result.status, result.body, result.err)
	}
	return view
}

func subscriptionOrderBody(quote string) string {
	return fmt.Sprintf(`{"quote_id":%q,"accepted_version":"subscription-2026-10-31"}`, quote)
}

func subscriptionKeepBody(quote string, cancel bool) string {
	return fmt.Sprintf(`{"quote_id":%q,"cancel_pending":%t}`, quote, cancel)
}

func TestSubscriptionProductionRoleHTTP(t *testing.T) {
	f := newSubscriptionRuntimeFixture(t, false)
	t.Run("authority and workspace isolation", func(t *testing.T) {
		for _, route := range []struct{ method, path, body string }{
			{http.MethodGet, "/api/billing/subscription", ""},
			{http.MethodPost, "/api/billing/quotes", `{}`},
			{http.MethodPost, "/api/billing/keep", `{}`},
			{http.MethodPost, "/api/billing/orders", `{}`},
			{http.MethodGet, "/api/billing/orders/missing", ""},
		} {
			for _, token := range []string{"", "unknown-token"} {
				f.expect(t, route.method, route.path, route.body, token, http.StatusUnauthorized)
			}
			want := http.StatusForbidden
			if route.path == "/api/billing/subscription" {
				want = http.StatusOK
			}
			f.expect(t, route.method, route.path, route.body, f.memberToken, want)
		}
		for _, token := range []string{f.ownerToken, f.memberToken} {
			raw := f.expect(t, http.MethodGet, "/api/billing/subscription", "", token, http.StatusOK)
			if !strings.Contains(string(raw), f.store) || strings.Contains(string(raw), f.foreignStore) {
				t.Fatalf("workspace choices: %s", raw)
			}
		}
		raw := f.expect(t, http.MethodPost, "/api/billing/quotes", fmt.Sprintf(`{"expected_workspace_uuid":%q,"action":"subscribe","target":{"plan_key":"lite","stores":5}}`, f.foreignWorkspace), f.ownerToken, http.StatusConflict)
		if !strings.Contains(string(raw), "WORKSPACE_MISMATCH") {
			t.Fatalf("workspace mismatch: %s", raw)
		}
	})
	t.Run("quote validation and exact amount", func(t *testing.T) {
		base := fmt.Sprintf(`{"expected_workspace_uuid":%q,"action":"subscribe","target":{"plan_key":"lite","stores":%%d},"months":%%d}`, f.workspace)
		for _, input := range [][2]int{{-1, 1}, {0, 2}, {2147483648, 1}} {
			f.expect(t, http.MethodPost, "/api/billing/quotes", fmt.Sprintf(base, input[0], input[1]), f.ownerToken, http.StatusBadRequest)
		}
		f.expect(t, http.MethodPost, "/api/billing/quotes", fmt.Sprintf(base, 1, 1)+` {}`, f.ownerToken, http.StatusBadRequest)
		f.expect(t, http.MethodPost, "/api/billing/quotes", fmt.Sprintf(`{"expected_workspace_uuid":%q,"action":"subscribe","target":{"plan_key":"unknown","stores":5}}`, f.workspace), f.ownerToken, http.StatusBadRequest)
		for _, keep := range []string{fmt.Sprintf(`[%q]`, f.foreignStore), fmt.Sprintf(`[%q,%q]`, f.store, f.store)} {
			f.expect(t, http.MethodPost, "/api/billing/quotes", fmt.Sprintf(`{"expected_workspace_uuid":%q,"action":"subscribe","target":{"plan_key":"lite","stores":5},"keep_store_ids":%s}`, f.workspace, keep), f.ownerToken, http.StatusBadRequest)
		}
		q := f.quote(t, "subscribe", 7, 3)
		if q.AmountCents != 42000 || q.Target.Stores != 7 || q.FreeOnly {
			t.Fatalf("priced quote=%+v", q)
		}
		var saved int64
		if err := f.fixture.QueryRow(f.ctx, `SELECT amount_cents FROM subscription_quotes WHERE id=$1::uuid AND org_id=$2`, q.ID, f.org).Scan(&saved); err != nil || saved != 42000 {
			t.Fatalf("saved price=%d err=%v", saved, err)
		}
		f.expect(t, http.MethodPost, "/api/billing/orders", subscriptionOrderBody(q.ID), f.foreignToken, http.StatusNotFound)
		f.expect(t, http.MethodPost, "/api/billing/orders", fmt.Sprintf(`{"quote_id":%q,"accepted_version":"obsolete"}`, q.ID), f.ownerToken, http.StatusBadRequest)
		f.expect(t, http.MethodPost, "/api/billing/orders", fmt.Sprintf(`{"quote_id":%q,"accepted_version":"subscription-2026-10-31","amount_cents":1}`, q.ID), f.ownerToken, http.StatusBadRequest)
		f.expect(t, http.MethodPost, "/api/billing/keep", subscriptionKeepBody(q.ID, false), f.ownerToken, http.StatusBadRequest)
		var order contract.OrderBrief
		raw := f.expect(t, http.MethodPost, "/api/billing/orders", subscriptionOrderBody(q.ID), f.ownerToken, http.StatusCreated)
		if err := json.Unmarshal(raw, &order); err != nil || order.PublicID == "" || order.PaymentDeadlineAt == nil {
			t.Fatalf("created order=%s err=%v", raw, err)
		}
		raw = f.expect(t, http.MethodGet, "/api/billing/orders/"+order.PublicID, "", f.ownerToken, http.StatusOK)
		if !strings.Contains(string(raw), `"amount_cents":42000`) || !strings.Contains(string(raw), `"status":"pending"`) || !strings.Contains(string(raw), `"accepted_by":"96311"`) {
			t.Fatalf("order persisted terms=%s", raw)
		}
		f.expect(t, http.MethodGet, "/api/billing/orders/"+order.PublicID, "", f.foreignToken, http.StatusNotFound)
		f.expect(t, http.MethodGet, "/api/billing/orders/"+order.PublicID, "", f.memberToken, http.StatusForbidden)
		f.expect(t, http.MethodPost, "/api/billing/orders", subscriptionOrderBody(q.ID), f.ownerToken, http.StatusConflict)
		if view := f.view(t); !view.PendingOrder || view.PendingPublicID != order.PublicID || len(view.Periods) != 0 || view.Status != "free" {
			t.Fatalf("pending order granted entitlement: %+v", view)
		}
	})
	f.assertClean(t)
}

func TestSubscriptionProductionRoleQuoteRefusals(t *testing.T) {
	f := newSubscriptionRuntimeFixture(t, false)
	for _, reason := range []string{"expired", "stale"} {
		t.Run(reason, func(t *testing.T) {
			q := f.quote(t, "subscribe", 6, 1)
			var err error
			if reason == "expired" {
				_, err = f.fixture.Exec(f.ctx, `UPDATE subscription_quotes SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1::uuid`, q.ID)
			} else {
				_, err = f.fixture.Exec(f.ctx, `UPDATE subscriptions SET revision=revision+1 WHERE org_id=$1`, f.org)
			}
			if err != nil {
				t.Fatal(err)
			}
			raw := f.expect(t, http.MethodPost, "/api/billing/orders", subscriptionOrderBody(q.ID), f.ownerToken, http.StatusConflict)
			want := "QUOTE_EXPIRED"
			if reason == "stale" {
				want = "QUOTE_STALE"
			}
			if !strings.Contains(string(raw), want) {
				t.Fatalf("quote refusal=%s", raw)
			}
			var consumed bool
			var orders int
			if err := f.fixture.QueryRow(f.ctx, `SELECT consumed_at IS NOT NULL,(SELECT count(*) FROM payment_orders WHERE org_id=$2) FROM subscription_quotes WHERE id=$1::uuid`, q.ID, f.org).Scan(&consumed, &orders); err != nil || consumed || orders != 0 {
				t.Fatalf("refusal persisted consumed=%v orders=%d err=%v", consumed, orders, err)
			}
		})
	}
	t.Run("failed insert keeps quote reusable", func(t *testing.T) {
		q := f.quote(t, "subscribe", 6, 1)
		if _, err := f.fixture.Exec(f.ctx, `ALTER TABLE payment_orders ADD CONSTRAINT subscription_runtime_reject CHECK(product<>'subscription')`); err != nil {
			t.Fatal(err)
		}
		f.expect(t, http.MethodPost, "/api/billing/orders", subscriptionOrderBody(q.ID), f.ownerToken, http.StatusInternalServerError)
		if _, err := f.fixture.Exec(f.ctx, `ALTER TABLE payment_orders DROP CONSTRAINT subscription_runtime_reject`); err != nil {
			t.Fatal(err)
		}
		f.expect(t, http.MethodPost, "/api/billing/orders", subscriptionOrderBody(q.ID), f.ownerToken, http.StatusCreated)
		var orders, consumed int
		if err := f.fixture.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM payment_orders WHERE org_id=$1),(SELECT count(*) FROM subscription_quotes WHERE org_id=$1 AND consumed_at IS NOT NULL)`, f.org).Scan(&orders, &consumed); err != nil || orders != 1 || consumed != 1 {
			t.Fatalf("insert rollback orders=%d consumed=%d err=%v", orders, consumed, err)
		}
	})
	f.assertClean(t)
}

func TestSubscriptionProductionRoleFutureKeep(t *testing.T) {
	f := newSubscriptionRuntimeFixture(t, true)
	before := f.view(t)
	if before.Stores.Limit != 8 || before.Members.Limit != domain.MemberCap || len(before.Periods) != 1 {
		t.Fatalf("paid fixture=%+v", before)
	}
	renewal := f.quote(t, "renew", 5, 1)
	if renewal.FreeOnly || renewal.AmountCents != 10000 {
		t.Fatalf("reduced future renewal price=%+v", renewal)
	}
	subscriptionPay(t, f.ctx, f.fixture, f.org, 96311, renewal, time.Now())
	before = f.view(t)
	future := before.Periods[1]
	quoteBody := fmt.Sprintf(`{"expected_workspace_uuid":%q,"action":"keep","period_id":%d,"target":{"plan_key":"lite","stores":5},"keep_store_ids":[%q]}`, f.workspace, future.ID, f.store)
	var q contract.Offered
	if err := json.Unmarshal(f.expect(t, http.MethodPost, "/api/billing/quotes", quoteBody, f.ownerToken, http.StatusOK), &q); err != nil {
		t.Fatal(err)
	}
	if !q.FreeOnly || q.AmountCents != 0 || q.Target.Stores != 5 {
		t.Fatalf("future keep quote=%+v", q)
	}
	if preview := f.view(t); preview.Revision != before.Revision || preview.NextRenewal.Stores != 8 {
		t.Fatalf("preview mutated subscription: %+v", preview)
	}
	f.expect(t, http.MethodPost, "/api/billing/keep", subscriptionKeepBody(q.ID, false), f.foreignToken, http.StatusNotFound)
	f.expect(t, http.MethodPost, "/api/billing/orders", subscriptionOrderBody(q.ID), f.ownerToken, http.StatusBadRequest)
	// The final event write fails after quote consumption, pending cancellation,
	// and keep-list changes; none of those writes may survive independently.
	renewal = f.quote(t, "renew", 8, 1)
	var order contract.OrderBrief
	if err := json.Unmarshal(f.expect(t, http.MethodPost, "/api/billing/orders", subscriptionOrderBody(renewal.ID), f.ownerToken, http.StatusCreated), &order); err != nil {
		t.Fatal(err)
	}
	f.expect(t, http.MethodPost, "/api/billing/keep", subscriptionKeepBody(q.ID, false), f.ownerToken, http.StatusConflict)
	if _, err := f.fixture.Exec(f.ctx, `ALTER TABLE subscription_events ADD CONSTRAINT subscription_runtime_reject_keep CHECK(kind<>'keep')`); err != nil {
		t.Fatal(err)
	}
	f.expect(t, http.MethodPost, "/api/billing/keep", subscriptionKeepBody(q.ID, true), f.ownerToken, http.StatusInternalServerError)
	var consumed bool
	var status string
	var events int
	if err := f.fixture.QueryRow(f.ctx, `SELECT q.consumed_at IS NOT NULL,o.status,(SELECT count(*) FROM subscription_events WHERE org_id=$3 AND kind='keep') FROM subscription_quotes q CROSS JOIN payment_orders o WHERE q.id=$1::uuid AND o.public_id=$2`, q.ID, order.PublicID, f.org).Scan(&consumed, &status, &events); err != nil || consumed || status != "pending" || events != 0 {
		t.Fatalf("keep rollback consumed=%v order=%s events=%d err=%v", consumed, status, events, err)
	}
	if view := f.view(t); view.Revision != before.Revision || len(view.Periods[1].KeepStores) != 0 {
		t.Fatalf("failed keep edit persisted: %+v", view)
	}
	if _, err := f.fixture.Exec(f.ctx, `ALTER TABLE subscription_events DROP CONSTRAINT subscription_runtime_reject_keep`); err != nil {
		t.Fatal(err)
	}
	f.expect(t, http.MethodPost, "/api/billing/keep", subscriptionKeepBody(q.ID, true), f.ownerToken, http.StatusOK)
	after := f.view(t)
	if after.Revision != before.Revision+1 || after.Stores.Limit != 8 || after.Members.Limit != domain.MemberCap || after.NextRenewal.Stores != 8 || after.NextRenewal.AmountCents != 16000 || after.PendingOrder || len(after.Periods) != 2 || after.Periods[0].ID != before.Periods[0].ID || !after.Periods[0].EndsAt.Equal(before.Periods[0].EndsAt) || after.Periods[1].ID != future.ID || after.Periods[1].Stores != 5 || !after.Periods[1].EndsAt.Equal(future.EndsAt) || len(after.Periods[1].KeepStores) != 1 || after.Periods[1].KeepStores[0] != f.store {
		t.Fatalf("keep edit changed paid entitlement: before=%+v after=%+v", before, after)
	}
	f.expect(t, http.MethodPost, "/api/billing/keep", subscriptionKeepBody(q.ID, true), f.ownerToken, http.StatusConflict)
	if err := f.fixture.QueryRow(f.ctx, `SELECT q.consumed_at IS NOT NULL,o.status,(SELECT count(*) FROM subscription_events WHERE org_id=$3 AND kind='keep') FROM subscription_quotes q CROSS JOIN payment_orders o WHERE q.id=$1::uuid AND o.public_id=$2`, q.ID, order.PublicID, f.org).Scan(&consumed, &status, &events); err != nil || !consumed || status != "canceled" || events != 1 {
		t.Fatalf("keep persistence consumed=%v order=%s events=%d err=%v", consumed, status, events, err)
	}
	var remaining int
	if err := f.fixture.QueryRow(f.ctx, `SELECT count(*) FROM subscription_periods WHERE org_id=$1`, f.org).Scan(&remaining); err != nil || remaining != 2 {
		t.Fatalf("keep edit created periods=%d err=%v", remaining, err)
	}
	f.assertClean(t)
}

func TestSubscriptionProductionRoleConcurrentOrders(t *testing.T) {
	f := newSubscriptionRuntimeFixture(t, false)
	q := f.quote(t, "subscribe", 6, 1)
	secondPool, err := db.Connect(f.ctx, config.Config{DatabaseURL: f.runtime.Config().ConnString()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(secondPool.Close)
	second := f
	second.runtime = secondPool
	second.handler = app.Handler(secondPool)
	second.server = httptest.NewServer(second.handler)
	t.Cleanup(second.server.Close)
	second.ownerToken = second.login(t, "a96311@example.invalid")
	second.assertClean(t)
	blocker, err := f.fixture.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(f.ctx)
	if _, err := blocker.Exec(f.ctx, `SELECT id FROM organizations WHERE id=$1 FOR UPDATE`, f.org); err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	done := make(chan subscriptionHTTPResult, 2)
	for _, client := range []subscriptionRuntimeFixture{f, second} {
		go func() {
			<-start
			done <- client.call(http.MethodPost, "/api/billing/orders", subscriptionOrderBody(q.ID), client.ownerToken)
		}()
	}
	close(start)
	deadline := time.Now().Add(5 * time.Second)
	for {
		var waiting int
		if _, err := blocker.Exec(f.ctx, `SELECT pg_stat_clear_snapshot()`); err != nil {
			t.Fatal(err)
		}
		if err := blocker.QueryRow(f.ctx, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND usename='podhub_login_api' AND wait_event_type='Lock' AND query LIKE $1`, "%SELECT id FROM organizations WHERE id = $1 FOR UPDATE%").Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("only %d production connections reached the subscription lock", waiting)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := blocker.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
	counts := map[int]int{}
	for range 2 {
		select {
		case result := <-done:
			if result.err != nil {
				t.Fatal(result.err)
			}
			counts[result.status]++
		case <-time.After(10 * time.Second):
			t.Fatal("concurrent order requests did not complete")
		}
	}
	if counts[http.StatusCreated] != 1 || counts[http.StatusConflict] != 1 {
		t.Fatalf("concurrent responses=%v", counts)
	}
	var orders, consumed int
	if err := f.fixture.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM payment_orders WHERE org_id=$1 AND status='pending'),(SELECT count(*) FROM subscription_quotes WHERE org_id=$1 AND consumed_at IS NOT NULL)`, f.org).Scan(&orders, &consumed); err != nil || orders != 1 || consumed != 1 {
		t.Fatalf("concurrent persistence orders=%d consumed=%d err=%v", orders, consumed, err)
	}
	f.assertClean(t)
	second.assertClean(t)
}
