package integration

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	admincontract "github.com/xxww0098/podhub-go/internal/admin/core/contract"
	usersrepo "github.com/xxww0098/podhub-go/internal/admin/users/repo"
	"github.com/xxww0098/podhub-go/internal/billing/contract"
	"github.com/xxww0098/podhub-go/internal/billing/domain"
	billinghttp "github.com/xxww0098/podhub-go/internal/billing/http"
	billingrepo "github.com/xxww0098/podhub-go/internal/billing/repo"
	"github.com/xxww0098/podhub-go/internal/platform/db"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
	"github.com/xxww0098/podhub-go/internal/platform/seal"
	sellercontract "github.com/xxww0098/podhub-go/internal/seller/contract"
	sellerrepo "github.com/xxww0098/podhub-go/internal/seller/ozon/repo"
	storedomain "github.com/xxww0098/podhub-go/internal/store/domain"
	storerepo "github.com/xxww0098/podhub-go/internal/store/repo"
)

func TestSubscriptionAdminCapacityOverrides(t *testing.T) {
	ctx, pool, org, user := subscriptionTenant(t)
	now := time.Now().Truncate(time.Second)
	q := subscriptionPreview(t, ctx, pool, org, contract.QuoteRequest{Action: "subscribe", Target: contract.Target{PlanKey: "lite", Stores: 5}}, now)
	subscriptionPay(t, ctx, pool, org, user, q, now)
	stores := make([]string, 7)
	for i := range stores {
		stores[i] = uuid.NewString()
		seedCompanyStore(t, ctx, pool, org, stores[i], i+1, "synthetic store", nil)
	}
	var memberUser int64
	if err := pool.QueryRow(ctx, `INSERT INTO account_users(public_id,email,password_hash,role,name,target,supplier_id,plan,created_at,updated_at)
 VALUES('override-member','override-member@example.invalid','x','user','synthetic','/workspace','','lite',clock_timestamp(),clock_timestamp()) RETURNING id`).Scan(&memberUser); err != nil {
		t.Fatal(err)
	}
	member := seedCompanyMember(t, ctx, pool, org, memberUser, "manager", 2)
	seedMatchingLease(t, ctx, pool, "admin", "synthetic capacity regression")
	admin := usersrepo.NewUsers(pool, func() time.Time { return now })
	actor := admincontract.Actor{ID: user, OrgID: org, Role: "super_admin"}
	// Members go through the admin endpoint's repo; the store override has no
	// admin surface, so the fixture writes it and re-projects the subscription.
	apply := func(members, storeOverride *int64) {
		t.Helper()
		if _, fault := admin.SetSeats(ctx, actor, "a96171", "/synthetic/seats", members); fault != nil {
			t.Fatalf("set seats: %+v", fault)
		}
		if _, err := pool.Exec(ctx, `UPDATE organizations SET store_limit_override=$2 WHERE id=$1`, org, storeOverride); err != nil {
			t.Fatal(err)
		}
		if err := db.InTx(ctx, pool, db.App(org), func(tx pgx.Tx) error {
			_, err := billingrepo.ProjectSubscription(ctx, tx, org, now)
			return err
		}); err != nil {
			t.Fatalf("project: %v", err)
		}
	}
	memberLimit, storeLimit := int64(3), int64(8)
	apply(&memberLimit, &storeLimit)
	t.Run("persisted", func(t *testing.T) {
		var seats, stores int64
		if err := pool.QueryRow(ctx, `SELECT member_seat_limit_override,store_limit_override FROM organizations WHERE id=$1`, org).Scan(&seats, &stores); err != nil || seats != 3 || stores != 8 {
			t.Fatalf("stored overrides: %d/%d %v", seats, stores, err)
		}
	})
	t.Run("read", func(t *testing.T) {
		v := subscriptionRead(t, ctx, pool, org, now)
		if v.Members.Limit != 3 || v.Stores.Limit != 8 {
			t.Fatalf("effective read limits: members=%d stores=%d", v.Members.Limit, v.Stores.Limit)
		}
		q := subscriptionPreview(t, ctx, pool, org, contract.QuoteRequest{Action: "change", Target: contract.Target{PlanKey: "pro", Stores: 8}}, now)
		if q.Current.Stores != 8 || q.Current.Members != 3 {
			t.Errorf("quote current capacity ignores overrides: %+v", q.Current)
		}
		roster, api := storerepo.New(pool, tenantx.BeginApp).LoadRoster(ctx, org, storedomain.Actor{UserID: user, Role: "owner"})
		if api != nil || roster.StoreLimit != 8 {
			t.Errorf("store roster limit=%d err=%v", roster.StoreLimit, api)
		}
	})
	t.Run("admission", func(t *testing.T) {
		var allowed bool
		if err := pool.QueryRow(ctx, `SELECT public.subscription_member_allowed($1,$2,$3)`, org, member, now).Scan(&allowed); err != nil || !allowed {
			t.Errorf("member override ignored: allowed=%v err=%v", allowed, err)
		}
		if !subscriptionAllowed(t, ctx, pool, org, stores[6], now) {
			t.Error("store override ignored")
		}
		// Reaching the missing-credential check proves both hot-path capacity gates passed.
		_, _, err := sellerrepo.NewAdmitStore(pool, seal.Ring{}, false).Admit(ctx, org, memberUser, "manager", stores[6], now.UnixMilli())
		var refusal *sellercontract.AdmitError
		if !errors.As(err, &refusal) || refusal.Code != "CONFLICT" {
			t.Errorf("seller capacity gates: %v", err)
		}
	})
	t.Run("projection", func(t *testing.T) {
		if err := db.InTx(ctx, pool, db.App(org), func(tx pgx.Tx) error {
			p, err := billingrepo.ProjectSubscription(ctx, tx, org, now)
			if err == nil && (p.SeatLimit != 3 || p.StoreLimit != 8) {
				t.Errorf("projected overrides: %+v", p)
			}
			return err
		}); err != nil {
			t.Fatal(err)
		}
		var seats, stores int64
		var suspended bool
		if err := pool.QueryRow(ctx, `SELECT member_seat_limit_override,store_limit,(SELECT quota_suspended FROM organization_members WHERE id=$2) FROM organizations WHERE id=$1`, org, member).Scan(&seats, &stores, &suspended); err != nil || seats != 3 || stores != 8 || suspended {
			t.Fatalf("cached capacity: %d/%d suspended=%v err=%v", seats, stores, suspended, err)
		}
	})
	t.Run("retention and manual exclusions", func(t *testing.T) {
		if _, err := pool.Exec(ctx, `UPDATE subscription_periods SET keep_store_ids=$2 WHERE org_id=$1`, org, stores[1:6]); err != nil {
			t.Fatal(err)
		}
		if !subscriptionAllowed(t, ctx, pool, org, stores[6], now) {
			t.Error("paid retention list blocked the override")
		}
		if _, err := pool.Exec(ctx, `UPDATE organization_stores SET manual_disabled=true WHERE uuid=$1`, stores[6]); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE organization_members SET manual_disabled=true WHERE id=$1`, member); err != nil {
			t.Fatal(err)
		}
		var allowed bool
		if err := pool.QueryRow(ctx, `SELECT public.subscription_member_allowed($1,$2,$3)`, org, member, now).Scan(&allowed); err != nil || allowed {
			t.Errorf("override restored manual-disabled member: %v %v", allowed, err)
		}
		if subscriptionAllowed(t, ctx, pool, org, stores[6], now) {
			t.Error("override restored manual-disabled store")
		}
	})
	t.Run("lower and expired overrides", func(t *testing.T) {
		memberLimit, storeLimit = 1, 2
		apply(&memberLimit, &storeLimit)
		if subscriptionAllowed(t, ctx, pool, org, stores[2], now) {
			t.Error("lower override ignored")
		}
		boundary := domain.TermEnd(now, 1)
		v := subscriptionRead(t, ctx, pool, org, boundary)
		if v.Stores.Limit != 2 || v.Members.Limit != 1 || v.Status != "expired" {
			t.Errorf("expired overrides: stores=%d members=%d status=%s", v.Stores.Limit, v.Members.Limit, v.Status)
		}
		if !subscriptionAllowed(t, ctx, pool, org, stores[1], boundary) || subscriptionAllowed(t, ctx, pool, org, stores[2], boundary) {
			t.Error("expired admission differs from effective override")
		}
	})
	t.Run("follow purchased", func(t *testing.T) {
		apply(nil, nil)
		v := subscriptionRead(t, ctx, pool, org, now)
		if v.Members.Limit != domain.MemberCap || v.Stores.Limit != 5 {
			t.Fatalf("cleared overrides: %+v", v)
		}
		var mismatch int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM organization_stores WHERE org_id=$1 AND deleted_at_ms IS NULL AND NOT manual_disabled
 AND quota_suspended IS DISTINCT FROM NOT public.subscription_store_allowed($1,uuid,$2)`, org, now).Scan(&mismatch); err != nil || mismatch != 0 {
			t.Errorf("cleared-override flags disagree with paid retention: %d %v", mismatch, err)
		}
		if subscriptionAllowed(t, ctx, pool, org, stores[0], now) || !subscriptionAllowed(t, ctx, pool, org, stores[5], now) {
			t.Error("clearing override did not restore the purchased retention list")
		}
	})
}

// All callbacks below are signed with a test-only secret and served by httptest.
func subscriptionTestCallback(t *testing.T, handler *chi.Mux, publicID string, cents int64) {
	t.Helper()
	form := map[string]string{"pid": "1000", "money": fmt.Sprintf("%d.%02d", cents/100, cents%100), "out_trade_no": publicID, "trade_no": "synthetic-" + publicID, "trade_status": "TRADE_SUCCESS"}
	form["sign"] = domain.EasyPayMD5(form, "synthetic-secret")
	body := url.Values{}
	for k, v := range form {
		body.Set(k, v)
	}
	req := httptest.NewRequest("POST", "/api/billing/webhooks/easypay", strings.NewReader(body.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("synthetic callback: %d %s", rec.Code, rec.Body.String())
	}
}

func TestSubscriptionChangeQuotedPeriods(t *testing.T) {
	for _, delayed := range []bool{false, true} {
		t.Run(fmt.Sprintf("delayed=%v", delayed), func(t *testing.T) {
			ctx, pool, org, user := subscriptionTenant(t)
			now := subscriptionTime(10, 21)
			q := subscriptionPreview(t, ctx, pool, org, contract.QuoteRequest{Action: "subscribe", Target: contract.Target{PlanKey: "lite", Stores: 5}}, now)
			subscriptionPay(t, ctx, pool, org, user, q, now)
			q = subscriptionPreview(t, ctx, pool, org, contract.QuoteRequest{Action: "renew"}, now)
			subscriptionPay(t, ctx, pool, org, user, q, now)
			now = subscriptionTime(10, 30)
			q = subscriptionPreview(t, ctx, pool, org, contract.QuoteRequest{Action: "change", Target: contract.Target{PlanKey: "pro", Stores: 5}}, now)
			agreement := []byte(fmt.Sprintf(`{"version":"test","title":"test","effective_at":"test","content":"test","accepted_at":"test","accepted_by":"%d"}`, user))
			pending, err := billingrepo.CreateSubscriptionOrder(ctx, pool, org, user, "po_"+uuid.NewString(), "easypay", "CNY", q.ID, agreement, now)
			if err != nil {
				t.Fatal(err)
			}
			if delayed {
				if _, err = pool.Exec(ctx, `UPDATE payment_orders SET status='canceled' WHERE id=$1`, pending.ID); err != nil {
					t.Fatal(err)
				}
				renew := subscriptionPreview(t, ctx, pool, org, contract.QuoteRequest{Action: "renew"}, now)
				subscriptionPay(t, ctx, pool, org, user, renew, now)
				now = subscriptionTime(10, 31)
			}
			router := chi.NewRouter()
			billinghttp.Register(router, billinghttp.Deps{Billing: billingHTTPPort(), Pool: pool, Now: func() time.Time { return now }, Payments: billinghttp.Payments{EasyPayPID: "1000", EasyPayKey: "synthetic-secret"}})
			for i := 0; i < 2; i++ {
				subscriptionTestCallback(t, router, pending.PublicID, q.AmountCents)
			}
			v := subscriptionRead(t, ctx, pool, org, now)
			want := 2
			if delayed {
				want = 3
			}
			if len(v.Periods) != want || v.Periods[0].PlanKey != "pro" || v.Periods[1].PlanKey != "pro" {
				t.Fatalf("quoted periods were not upgraded: %+v", v.Periods)
			}
			if delayed && v.Periods[2].PlanKey != "lite" {
				t.Errorf("unquoted renewal upgraded without charge: %+v", v.Periods[2])
			}
			var events int
			if err = pool.QueryRow(ctx, `SELECT count(*) FROM subscription_events WHERE order_id=$1`, pending.ID).Scan(&events); err != nil || events != 1 {
				t.Errorf("duplicate callback events=%d err=%v", events, err)
			}
		})
	}
}

func TestSubscriptionWalletCallbackBoundary(t *testing.T) {
	ctx, pool, org, user := subscriptionTenant(t)
	if _, err := pool.Exec(ctx, `INSERT INTO workspace_wallets(org_id,balance_microfen,held_microfen) VALUES($1,0,0)`, org); err != nil {
		t.Fatal(err)
	}
	for _, status := range []string{"pending", "canceled"} {
		t.Run(status, func(t *testing.T) {
			publicID := "po_" + uuid.NewString()
			if _, err := pool.Exec(ctx, `INSERT INTO payment_orders(public_id,org_id,product,plan,months,amount_cents,currency,provider,status,created_by_user_id,topup_microfen,created_at,updated_at,canceled_at)
 VALUES($1,$2,'wallet_topup','lite',1,100,'CNY','easypay',$3::text,$4,100000000,clock_timestamp(),clock_timestamp(),CASE WHEN $3::text='canceled' THEN clock_timestamp() END)`, publicID, org, status, user); err != nil {
				t.Fatal(err)
			}
			before := walletBalance(t, ctx, pool, org)
			router := chi.NewRouter()
			billinghttp.Register(router, billinghttp.Deps{Billing: billingHTTPPort(), Pool: pool, Payments: billinghttp.Payments{EasyPayPID: "1000", EasyPayKey: "synthetic-secret"}})
			for i := 0; i < 2; i++ {
				subscriptionTestCallback(t, router, publicID, 100)
			}
			want := before + 100000000
			if got := walletBalance(t, ctx, pool, org); got != want {
				t.Errorf("%s wallet callback: balance=%d want=%d", status, got, want)
			}
			var ledger int
			var paid, reason string
			var cancellationRetained bool
			if err := pool.QueryRow(ctx, `SELECT status,COALESCE(reconciliation_reason,''),canceled_at IS NOT NULL,(SELECT count(*) FROM wallet_ledger l WHERE l.payment_order_id=p.id) FROM payment_orders p WHERE public_id=$1`, publicID).Scan(&paid, &reason, &cancellationRetained, &ledger); err != nil || paid != "paid" || ledger != 1 || (status == "canceled" && (reason != "fulfilled_after_cancel" || !cancellationRetained)) {
				t.Fatalf("receipt paid=%s reason=%s ledger=%d retained=%v err=%v", paid, reason, ledger, cancellationRetained, err)
			}
		})
	}
}

func TestSubscriptionChangeReconciliation(t *testing.T) {
	for _, mutation := range []string{"missing scope", "changed price", "expired"} {
		t.Run(mutation, func(t *testing.T) {
			ctx, pool, org, user := subscriptionTenant(t)
			now := subscriptionTime(10, 21)
			q := subscriptionPreview(t, ctx, pool, org, contract.QuoteRequest{Action: "subscribe", Target: contract.Target{PlanKey: "lite", Stores: 5}}, now)
			subscriptionPay(t, ctx, pool, org, user, q, now)
			now = subscriptionTime(10, 30)
			q = subscriptionPreview(t, ctx, pool, org, contract.QuoteRequest{Action: "change", Target: contract.Target{PlanKey: "pro", Stores: 5}}, now)
			agreement := []byte(fmt.Sprintf(`{"version":"test","title":"test","effective_at":"test","content":"test","accepted_at":"test","accepted_by":"%d"}`, user))
			pending, err := billingrepo.CreateSubscriptionOrder(ctx, pool, org, user, "po_"+uuid.NewString(), "easypay", "CNY", q.ID, agreement, now)
			if err != nil {
				t.Fatal(err)
			}
			if mutation == "missing scope" {
				// Model a pre-fix order at INSERT; the database forbids editing a frozen snapshot.
				if _, err = pool.Exec(ctx, `UPDATE payment_orders SET status='canceled' WHERE id=$1`, pending.ID); err != nil {
					t.Fatal(err)
				}
				pending.PublicID = "po_legacy_" + uuid.NewString()
				err = pool.QueryRow(ctx, `INSERT INTO payment_orders(public_id,org_id,product,plan,months,amount_cents,currency,provider,status,
 created_by_user_id,subscription_snapshot,purchase_agreement,created_at,updated_at)
 SELECT $1,org_id,product,plan,months,amount_cents,currency,provider,'pending',created_by_user_id,
 subscription_snapshot-'change_periods',purchase_agreement,created_at,updated_at FROM payment_orders WHERE id=$2 RETURNING id`, pending.PublicID, pending.ID).Scan(&pending.ID)
			} else if mutation == "changed price" {
				_, err = pool.Exec(ctx, `UPDATE subscription_periods SET store_monthly_cents=store_monthly_cents+1 WHERE org_id=$1`, org)
			} else {
				now = subscriptionTime(11, 21)
			}
			if err != nil {
				t.Fatal(err)
			}
			router := chi.NewRouter()
			billinghttp.Register(router, billinghttp.Deps{Billing: billingHTTPPort(), Pool: pool, Now: func() time.Time { return now }, Payments: billinghttp.Payments{EasyPayPID: "1000", EasyPayKey: "synthetic-secret"}})
			for i := 0; i < 2; i++ {
				subscriptionTestCallback(t, router, pending.PublicID, q.AmountCents)
			}
			var status string
			var reason *string
			var changed int
			if err := pool.QueryRow(ctx, `SELECT status,reconciliation_reason,(SELECT count(*) FROM subscription_periods WHERE org_id=$2 AND plan_key='pro') FROM payment_orders WHERE id=$1`, pending.ID, org).Scan(&status, &reason, &changed); err != nil {
				t.Fatal(err)
			}
			if status != "paid" || reason == nil || changed != 0 {
				t.Fatalf("receipt or scope lost: status=%s reason=%v upgraded=%d", status, reason, changed)
			}
		})
	}
}

func TestSubscriptionChangeQuoteStaleAfterPurchase(t *testing.T) {
	ctx, pool, org, user := subscriptionTenant(t)
	now := subscriptionTime(10, 21)
	q := subscriptionPreview(t, ctx, pool, org, contract.QuoteRequest{Action: "subscribe", Target: contract.Target{PlanKey: "lite", Stores: 5}}, now)
	subscriptionPay(t, ctx, pool, org, user, q, now)
	change := subscriptionPreview(t, ctx, pool, org, contract.QuoteRequest{Action: "change", Target: contract.Target{PlanKey: "pro", Stores: 5}}, now)
	q = subscriptionPreview(t, ctx, pool, org, contract.QuoteRequest{Action: "renew"}, now)
	subscriptionPay(t, ctx, pool, org, user, q, now)
	_, err := billingrepo.CreateSubscriptionOrder(ctx, pool, org, user, "po_"+uuid.NewString(), "manual", "CNY", change.ID, nil, now)
	var refusal *domain.QuoteError
	if !errors.As(err, &refusal) || refusal.Code != domain.CodeQuoteStale {
		t.Fatalf("accepted a quote preceding another purchase: %v", err)
	}
	// The persisted scope is server-owned, with the exact IDs and purchased interval.
	var raw []byte
	if err := pool.QueryRow(ctx, `SELECT payload->'change_periods' FROM subscription_quotes WHERE id=$1`, change.ID).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var periods []domain.Period
	if err := json.Unmarshal(raw, &periods); err != nil || len(periods) != 1 || periods[0].ID == 0 || !periods[0].Start.Equal(now) || !periods[0].End.Equal(domain.TermEnd(now, 1)) {
		t.Fatalf("quote scope not frozen: %s err=%v", raw, err)
	}
}
