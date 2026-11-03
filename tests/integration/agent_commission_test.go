package integration

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	admincontract "github.com/xxww0098/podhub-go/internal/admin/core/contract"
	agentcontract "github.com/xxww0098/podhub-go/internal/agent/contract"
	agentrepo "github.com/xxww0098/podhub-go/internal/agent/repo"
	"github.com/xxww0098/podhub-go/internal/billing/contract"
	"github.com/xxww0098/podhub-go/internal/billing/domain"
	billinghttp "github.com/xxww0098/podhub-go/internal/billing/http"
	billingrepo "github.com/xxww0098/podhub-go/internal/billing/repo"
	"github.com/xxww0098/podhub-go/internal/platform/db/tenantx"
)

func TestAgentFirstQualifiedSubscriptionCommission(t *testing.T) {
	ctx, pool, org, user := subscriptionTenant(t)
	now := time.Now().Truncate(time.Second)
	seedMatchingLease(t, ctx, pool, "auth", "agent subscription commission")
	seedMatchingLease(t, ctx, pool, "entitlement", "agent subscription commission")
	agent, _ := insertWorkspace(t, ctx, pool, "subscription-agent@example.invalid", "Agent")
	if _, err := pool.Exec(ctx, `INSERT INTO agents(user_id,invite_code,status,created_by_user_id)
		VALUES($1,'FIRSTSUB','active',$1)`, agent); err != nil {
		t.Fatal(err)
	}
	if _, err := agentrepo.New(pool).Claim(ctx, agentcontract.Actor{UserID: user, OrgID: org}, "FIRSTSUB"); err != nil {
		t.Fatal(err)
	}
	q := subscriptionPreview(t, ctx, pool, org, contract.QuoteRequest{Action: "subscribe", Target: contract.Target{PlanKey: "lite", Stores: 5}}, now)
	if q.AmountCents < 10000 {
		t.Fatalf("subscription does not meet the seeded commission threshold: %d", q.AmountCents)
	}
	agreement, err := json.Marshal(map[string]string{
		"version": "test", "title": "test", "effective_at": "2026-10-23", "content": "test",
		"accepted_at": now.Format(time.RFC3339), "accepted_by": fmt.Sprint(user),
	})
	if err != nil {
		t.Fatal(err)
	}
	order, err := billingrepo.CreateSubscriptionOrder(ctx, pool, org, user, "agent-first-subscription", "manual", "CNY", q.ID, agreement, now)
	if err != nil {
		t.Fatal(err)
	}
	admin := entitlementWithBilling(pool)
	if _, err := admin.ConfirmOrder(ctx, admincontract.Actor{UserID: user, OrgID: org}, order.PublicID); err != nil {
		t.Fatal(err)
	}
	var status string
	var periods, commissions, balance, ledger int64
	if err := pool.QueryRow(ctx, `SELECT status,
		(SELECT count(*) FROM subscription_periods WHERE order_id=$1),
		(SELECT count(*) FROM agent_commissions WHERE payment_order_id=$1 AND status='credited'),
		COALESCE((SELECT balance_cents FROM agent_commission_wallets WHERE user_id=$2),0),
		(SELECT count(*) FROM agent_commission_ledger WHERE user_id=$2 AND entry_type='commission')
		FROM payment_orders WHERE id=$1`, order.ID, agent).Scan(&status, &periods, &commissions, &balance, &ledger); err != nil {
		t.Fatal(err)
	}
	if status != "paid" || periods != 1 {
		t.Fatalf("subscription was not fulfilled: status=%s periods=%d", status, periods)
	}
	if commissions != 1 || balance != q.AmountCents/10 || ledger != 1 {
		t.Fatalf("qualified first subscription lost commission: commissions=%d balance=%d want=%d ledger=%d", commissions, balance, q.AmountCents/10, ledger)
	}
}

func TestAgentCommissionPaymentPaths(t *testing.T) {
	for _, path := range []string{"admin", "webhook", "replay"} {
		t.Run(path, func(t *testing.T) {
			ctx, pool, agent, user, org := agentCommissionTenant(t)
			order := agentCommissionTopup(t, ctx, pool, user, org, "first", 10000)
			switch path {
			case "admin":
				admin := entitlementWithBilling(pool)
				actor := admincontract.Actor{UserID: user, OrgID: org}
				if _, err := admin.ConfirmOrder(ctx, actor, "first"); err != nil {
					t.Fatal(err)
				}
				if _, err := admin.ConfirmOrder(ctx, actor, "first"); err == nil {
					t.Fatal("already-paid order was confirmed again")
				}
			case "webhook":
				for range 2 {
					if code := agentCommissionCallback(pool, "first", 10000); code != 200 {
						t.Fatalf("callback status=%d", code)
					}
				}
			case "replay":
				if _, err := pool.Exec(ctx, `INSERT INTO payment_callback_ledger(payment_reference,org_id,plan,status,applied_at_ms,created_at)
					VALUES('first',$1,'lite','paid',1,clock_timestamp())`, org); err != nil {
					t.Fatal(err)
				}
				for _, want := range []int{1, 0} {
					if n, err := billingrepo.ReconcilePayments(ctx, pool, 0); err != nil || n != want {
						t.Fatalf("replayed=%d want=%d err=%v", n, want, err)
					}
				}
			}
			assertAgentCommission(t, ctx, pool, agent, user, 1, 1000, 1)
			var status string
			var wallet, credits int64
			if err := pool.QueryRow(ctx, `SELECT p.status,w.balance_microfen,
				(SELECT count(*) FROM wallet_ledger WHERE payment_order_id=p.id AND entry_type='topup')
				FROM payment_orders p JOIN workspace_wallets w ON w.org_id=$2 WHERE p.id=$1`, order, org).Scan(&status, &wallet, &credits); err != nil {
				t.Fatal(err)
			}
			if status != "paid" || wallet != 10000*1_000_000 || credits != 1 {
				t.Fatalf("payment replay: status=%s wallet=%d topup entries=%d", status, wallet, credits)
			}
		})
	}
}

func TestAgentCommissionQualificationAndRollback(t *testing.T) {
	for _, scenario := range []string{"below threshold", "expired attribution", "disabled agent", "wallet overflow"} {
		t.Run(scenario, func(t *testing.T) {
			ctx, pool, agent, user, org := agentCommissionTenant(t)
			amount := int64(10000)
			var mutation string
			var target int64
			switch scenario {
			case "below threshold":
				amount = 9999
			case "expired attribution":
				mutation = `UPDATE account_users SET agent_attributed_at=clock_timestamp()-interval '366 days' WHERE id=$1`
				target = user
			case "disabled agent":
				mutation = `UPDATE agents SET status='disabled' WHERE user_id=$1`
				target = agent
			case "wallet overflow":
				if _, err := pool.Exec(ctx, `INSERT INTO workspace_wallets(org_id,balance_microfen) VALUES($1,$2)`, org, int64(math.MaxInt64)); err != nil {
					t.Fatal(err)
				}
			}
			if mutation != "" {
				// 00009 freezes agent_attributed_at once bound, so ageing the
				// attribution needs the trigger off. replica mode skips user
				// triggers for this transaction only; the pool is a superuser.
				if err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
					if _, err := tx.Exec(ctx, `SET LOCAL session_replication_role = replica`); err != nil {
						return err
					}
					_, err := tx.Exec(ctx, mutation, target)
					return err
				}); err != nil {
					t.Fatal(err)
				}
			}
			order := agentCommissionTopup(t, ctx, pool, user, org, "qualification", amount)
			code := agentCommissionCallback(pool, "qualification", amount)
			if scenario == "wallet overflow" {
				if code == 200 {
					t.Fatal("overflowing wallet credit succeeded")
				}
				assertAgentCommission(t, ctx, pool, agent, user, 0, 0, 0)
				var status string
				if err := pool.QueryRow(ctx, `SELECT status FROM payment_orders WHERE id=$1`, order).Scan(&status); err != nil || status != "pending" {
					t.Fatalf("failed payment was partly committed: status=%s err=%v", status, err)
				}
				return
			}
			if code != 200 {
				t.Fatalf("callback status=%d", code)
			}
			if scenario == "below threshold" {
				assertAgentCommission(t, ctx, pool, agent, user, 0, 0, 0)
				agentCommissionTopup(t, ctx, pool, user, org, "qualified", 10000)
				if code := agentCommissionCallback(pool, "qualified", 10000); code != 200 {
					t.Fatal(code)
				}
				assertAgentCommission(t, ctx, pool, agent, user, 1, 1000, 1)
				return
			}
			assertAgentCommission(t, ctx, pool, agent, user, 1, 0, 0)
			var status, note string
			if err := pool.QueryRow(ctx, `SELECT status,note FROM agent_commissions WHERE payment_order_id=$1`, order).Scan(&status, &note); err != nil {
				t.Fatal(err)
			}
			wantNote := "归因已过期"
			if scenario == "disabled agent" {
				wantNote = "代理已停用"
			}
			if status != "skipped" || note != wantNote {
				t.Fatalf("skip reason changed: %s %s", status, note)
			}
		})
	}
}

func TestAgentConcurrentFirstQualifiedOrders(t *testing.T) {
	ctx, pool, agent, user, org := agentCommissionTenant(t)
	var otherOrg int64
	if err := pool.QueryRow(ctx, `INSERT INTO organizations(owner_user_id,name,created_at,updated_at)
		VALUES($1,'Second workspace',clock_timestamp(),clock_timestamp()) RETURNING id`, user).Scan(&otherOrg); err != nil {
		t.Fatal(err)
	}
	blocker, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(ctx)
	if _, err := blocker.Exec(ctx, `SELECT user_id FROM agents WHERE user_id=$1 FOR UPDATE`, agent); err != nil {
		t.Fatal(err)
	}
	results := make(chan error, 2)
	pids := make([]int32, 2)
	for i, orgID := range []int64{org, otherOrg} {
		publicID := fmt.Sprintf("concurrent-%d", i)
		order := agentCommissionTopup(t, ctx, pool, user, orgID, publicID, 10000)
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		pids[i] = int32(tx.Conn().PgConn().PID())
		if err := tenantx.EnterApp(ctx, tx, orgID); err != nil {
			t.Fatal(err)
		}
		go func() {
			defer tx.Rollback(ctx)
			if _, err := billingrepo.MarkOrderPaid(ctx, tx, order, "test", time.Now()); err != nil {
				results <- err
				return
			}
			if _, err := billingrepo.TopupTx(ctx, tx, orgID, publicID, order, 10000*1_000_000); err != nil {
				results <- err
				return
			}
			results <- tx.Commit(ctx)
		}()
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		var waiting int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE pid=ANY($1::int[]) AND wait_event_type='Lock'`, pids).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("both payments did not reach the commission lock: %d", waiting)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := blocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := <-results; err != nil {
			t.Error(err)
		}
	}
	assertAgentCommission(t, ctx, pool, agent, user, 1, 1000, 1)
	var paid int64
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM payment_orders WHERE org_id=ANY($1::bigint[]) AND status='paid'`, []int64{org, otherOrg}).Scan(&paid); err != nil {
		t.Fatal(err)
	}
	if paid != 2 {
		t.Fatalf("concurrent payment lost: paid=%d", paid)
	}
	// Each workspace owns its wallet: the owner's two workspaces are credited
	// separately and never pool into one balance.
	for _, orgID := range []int64{org, otherOrg} {
		var balance int64
		if err := pool.QueryRow(ctx, `SELECT balance_microfen FROM workspace_wallets WHERE org_id=$1`, orgID).Scan(&balance); err != nil {
			t.Fatal(err)
		}
		if balance != 10000*1_000_000 {
			t.Fatalf("org %d balance=%d, want its own single top-up", orgID, balance)
		}
	}
}

func agentCommissionTenant(t *testing.T) (context.Context, *pgxpool.Pool, int64, int64, int64) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	t.Cleanup(cancel)
	pool := migratedPool(t, ctx)
	seedMatchingLease(t, ctx, pool, "auth", "agent commission")
	seedMatchingLease(t, ctx, pool, "entitlement", "agent commission")
	agent, _ := insertWorkspace(t, ctx, pool, "commission-agent@example.invalid", "Agent")
	user, org := insertWorkspace(t, ctx, pool, "commission-buyer@example.invalid", "Buyer")
	if _, err := pool.Exec(ctx, `INSERT INTO agents(user_id,invite_code,status,created_by_user_id)
		VALUES($1,'COMMISSION','active',$1)`, agent); err != nil {
		t.Fatal(err)
	}
	if _, err := agentrepo.New(pool).Claim(ctx, agentcontract.Actor{UserID: user, OrgID: org}, "COMMISSION"); err != nil {
		t.Fatal(err)
	}
	return ctx, pool, agent, user, org
}

func agentCommissionTopup(t *testing.T, ctx context.Context, pool *pgxpool.Pool, user, org int64, publicID string, cents int64) int64 {
	t.Helper()
	var id int64
	if err := pool.QueryRow(ctx, `INSERT INTO payment_orders
		(public_id,org_id,product,plan,months,amount_cents,currency,provider,status,created_by_user_id,topup_microfen,created_at,updated_at)
		VALUES($1,$2,'wallet_topup','lite',1,$3,'CNY','easypay','pending',$4,$5,clock_timestamp()-interval '1 minute',clock_timestamp()) RETURNING id`,
		publicID, org, cents, user, cents*1_000_000).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func agentCommissionCallback(pool *pgxpool.Pool, publicID string, cents int64) int {
	router := chi.NewRouter()
	billinghttp.Register(router, billinghttp.Deps{Billing: billingHTTPPort(), Pool: pool, Payments: billinghttp.Payments{EasyPayPID: "1000", EasyPayKey: "synthetic-secret"}})
	form := map[string]string{"pid": "1000", "money": fmt.Sprintf("%d.%02d", cents/100, cents%100), "out_trade_no": publicID, "trade_no": "synthetic-" + publicID, "trade_status": "TRADE_SUCCESS"}
	form["sign"] = domain.EasyPayMD5(form, "synthetic-secret")
	body := url.Values{}
	for key, value := range form {
		body.Set(key, value)
	}
	req := httptest.NewRequest("POST", "/api/billing/webhooks/easypay", strings.NewReader(body.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec.Code
}

func assertAgentCommission(t *testing.T, ctx context.Context, pool *pgxpool.Pool, agent, invitee, wantRows, wantBalance, wantCredits int64) {
	t.Helper()
	var rows, balance, ledger, audits, notifications int64
	if err := pool.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM agent_commissions WHERE invitee_user_id=$2),
		COALESCE((SELECT balance_cents FROM agent_commission_wallets WHERE user_id=$1),0),
		(SELECT count(*) FROM agent_commission_ledger WHERE user_id=$1 AND entry_type='commission'),
		(SELECT count(*) FROM audit_logs WHERE module='agent_commissions' AND action IN('agent_commission_credited','agent_commission_skipped')),
		(SELECT count(*) FROM notifications WHERE user_id=$1 AND kind='agent_commission_credited')`, agent, invitee).Scan(&rows, &balance, &ledger, &audits, &notifications); err != nil {
		t.Fatal(err)
	}
	if rows != wantRows || balance != wantBalance || ledger != wantCredits || audits != wantRows || notifications != wantCredits {
		t.Fatalf("commission rows=%d balance=%d ledger=%d audits=%d notifications=%d; want rows=%d balance=%d credits=%d", rows, balance, ledger, audits, notifications, wantRows, wantBalance, wantCredits)
	}
}
