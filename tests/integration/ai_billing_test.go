package integration

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/ai"
	_ "github.com/xxww0098/podhub-go/internal/billing"
	billingcontract "github.com/xxww0098/podhub-go/internal/billing/contract"
	billingdomain "github.com/xxww0098/podhub-go/internal/billing/domain"
	billinghttp "github.com/xxww0098/podhub-go/internal/billing/http"
	billingrepo "github.com/xxww0098/podhub-go/internal/billing/repo"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/internal/platform/llm"
)

func TestAIBillingParity(t *testing.T) {
	ctx := context.Background()
	pool := migratedPool(t, ctx)
	if err := purgeAIFixtures(ctx, pool); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := purgeAIFixtures(context.Background(), pool); err != nil {
			t.Errorf("purge ai fixtures: %v", err)
		}
	})
	seedMatchingLease(t, ctx, pool, "billing", "ai billing test")
	org, user := seedAITenant(t, ctx, pool, 96021)
	priceID := insertPrice(t, ctx, pool, "parity-model")
	if _, err := billingrepo.Adjust(ctx, pool, org, "seed:96021", 300_000_000, "seed"); err != nil {
		t.Fatal(err)
	}

	t.Run("ledger invariant and replay", func(t *testing.T) {
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		first, err := billingrepo.HoldTx(ctx, tx, org, "air_replay", nil, 1_000)
		if err != nil {
			t.Fatal(err)
		}
		second, err := billingrepo.HoldTx(ctx, tx, org, "air_replay", nil, 1_000)
		if err != nil {
			t.Fatal(err)
		}
		if first != second || first.HeldMicrofen != 1_000 || first.BalanceMicrofen != 300_000_000 {
			t.Fatalf("replay %+v %+v", first, second)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		tx, err = pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		settled, err := billingrepo.SettleTx(ctx, tx, org, "air_replay", nil, 1_000, 400)
		if err != nil {
			t.Fatal(err)
		}
		if settled.ChargedMicrofen != 400 || settled.AbsorbedMicrofen != 0 || settled.Wallet.BalanceMicrofen != 299_999_600 || settled.Wallet.HeldMicrofen != 0 {
			t.Fatalf("%+v", settled)
		}
		again, err := billingrepo.SettleTx(ctx, tx, org, "air_replay", nil, 1_000, 400)
		if err != nil || again.Wallet != settled.Wallet {
			t.Fatalf("settle replay %+v %v", again, err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		mismatches, err := billingrepo.CheckInvariant(ctx, pool)
		if err != nil {
			t.Fatal(err)
		}
		for _, row := range mismatches {
			if row.UserID == user {
				t.Fatalf("invariant %+v", row)
			}
		}
		_, err = pool.Exec(ctx, `UPDATE wallet_ledger SET note = 'rewrite' WHERE idempotency_key = 'air_replay'`)
		if err == nil || !bytes.Contains([]byte(err.Error()), []byte("wallet_ledger rows are immutable")) {
			t.Fatal(err)
		}
	})

	t.Run("missing guc hides the wallet", func(t *testing.T) {
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		if _, err := tx.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
			t.Fatal(err)
		}
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM user_wallets WHERE user_id = $1`, user).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 0 {
			t.Fatalf("missing guc saw %d", n)
		}
		if _, err := tx.Exec(ctx, `SELECT set_config('app.current_wallet_user_id', $1, true)`, fmt.Sprintf("%d", user+1)); err != nil {
			t.Fatal(err)
		}
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM user_wallets WHERE user_id = $1`, user).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 0 {
			t.Fatalf("cross tenant saw %d", n)
		}
	})

	t.Run("concurrent holds", func(t *testing.T) {
		org2, user2 := seedAITenant(t, ctx, pool, 96022)
		if _, err := billingrepo.Adjust(ctx, pool, org2, "seed:96022", 1_000, "seed"); err != nil {
			t.Fatal(err)
		}
		var wg sync.WaitGroup
		errs := make(chan error, 2)
		for i := 0; i < 2; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				tx, err := pool.Begin(ctx)
				if err != nil {
					errs <- err
					return
				}
				defer tx.Rollback(ctx)
				_, err = billingrepo.HoldTx(ctx, tx, org2, fmt.Sprintf("hold-%d", i), nil, 1_000)
				if err != nil {
					errs <- err
					return
				}
				errs <- tx.Commit(ctx)
			}(i)
		}
		wg.Wait()
		close(errs)
		ok, denied := 0, 0
		for err := range errs {
			if err == nil {
				ok++
				continue
			}
			var funds *billingcontract.Error
			if errorsAs(err, &funds) && funds.Insufficient {
				denied++
				continue
			}
			t.Fatal(err)
		}
		if ok != 1 || denied != 1 {
			t.Fatalf("ok %d denied %d", ok, denied)
		}
		_ = user2
	})

	var calls int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		body, _ := io.ReadAll(r.Body)
		var stamped map[string]any
		if err := json.Unmarshal(body, &stamped); err != nil || stamped["stream"] != false || stamped["model"] != "parity-model" {
			t.Errorf("posted %s", body)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"cmpl_1","model":"parity-model","choices":[{"message":{"role":"assistant","content":"ok"}}],"usage":{"prompt_tokens":1000,"completion_tokens":0}}`))
	}))
	defer upstream.Close()
	limits := ai.Limits{}
	router := chi.NewRouter()
	ai.Register(router, ai.HTTPDeps{
		Deps: ai.Deps{
			Pool: pool, BaseURL: upstream.URL, Limits: &limits, Converter: llm.Default(),
			Upstream: ai.HTTPUpstream{Client: upstream.Client()},
		},
		Access: access.FixedResolver{Principal: &access.Principal{UserID: user, OrgID: org, WorkspaceRole: "owner", PlatformRole: "user"}},
	})

	t.Run("chat settle and replay", func(t *testing.T) {
		status, raw := postAI(t, router, "/api/ai/chat/completions", "chat-1", `{"model":"parity-model","messages":[{"role":"user","content":"hi"}]}`)
		if status != 200 || calls != 1 {
			t.Fatalf("status %d calls %d body %s", status, calls, raw)
		}
		var payload struct {
			Billing struct {
				Total    int64  `json:"total_microfen"`
				Charged  int64  `json:"charged_microfen"`
				Absorbed int64  `json:"absorbed_microfen"`
				Status   string `json:"status"`
				Price    struct {
					Max int64 `json:"max_request_microfen"`
				} `json:"price"`
			} `json:"billing"`
		}
		if err := json.Unmarshal(raw, &payload); err != nil {
			t.Fatal(err)
		}
		// "hi" estimates 1 token, so the hold is 1. Upstream reports 1000.
		// The copied formula bills 1000; the wallet charges the hold and absorbs the rest.
		bill := payload.Billing
		if bill.Total != 1000 || bill.Charged != 1 || bill.Absorbed != 999 || bill.Status != "settled" || bill.Price.Max != 1 {
			t.Fatalf("%s", raw)
		}
		var quota, logs int
		var deducted, absorbed, group, source string
		if err := pool.QueryRow(ctx, `
			SELECT count(*), max(quota), max(other->>'wallet_quota_deducted'),
			       max(other->>'absorbed_microfen'), max("group"), max(other->>'billing_source')
			  FROM ai_consume_logs WHERE org_id = $1 AND request_id IN (
			      SELECT public_id FROM ai_requests WHERE org_id = $1 AND idempotency_key = 'chat-1')`,
			org).Scan(&logs, &quota, &deducted, &absorbed, &group, &source); err != nil {
			t.Fatal(err)
		}
		if logs != 1 || quota != 1000 || deducted != "1" || absorbed != "999" || group != "default" || source != "wallet" {
			t.Fatalf("log rows %d quota %d deducted %s absorbed %s group %s source %s", logs, quota, deducted, absorbed, group, source)
		}
		status, _ = postAI(t, router, "/api/ai/chat/completions", "chat-1", `{"model":"parity-model","messages":[{"role":"user","content":"hi"}]}`)
		if status != 200 || calls != 1 {
			t.Fatalf("replay status %d calls %d", status, calls)
		}
		var rows int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM ai_requests WHERE org_id = $1 AND idempotency_key = 'chat-1'`, org).Scan(&rows); err != nil || rows != 1 {
			t.Fatalf("rows %d %v", rows, err)
		}
		_ = priceID
	})

	t.Run("sse fold settles the same usage", func(t *testing.T) {
		sse := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, "data: {\"id\":\"cmpl_sse\",\"model\":\"parity-model\",\"choices\":[{\"delta\":{\"content\":\"ab\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"c\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1000,\"completion_tokens\":0}}\n\ndata: [DONE]\n")
		}))
		defer sse.Close()
		local := chi.NewRouter()
		ai.Register(local, ai.HTTPDeps{
			Deps:   ai.Deps{Pool: pool, BaseURL: sse.URL, Limits: &limits, Converter: llm.Default(), Upstream: ai.HTTPUpstream{Client: sse.Client()}},
			Access: access.FixedResolver{Principal: &access.Principal{UserID: user, OrgID: org, WorkspaceRole: "owner"}},
		})
		status, raw := postAI(t, local, "/api/ai/chat/completions", "chat-sse", `{"model":"parity-model","messages":[{"role":"user","content":"hi"}]}`)
		if status != 200 || !bytes.Contains(raw, []byte(`"content":"abc"`)) {
			t.Fatalf("%d %s", status, raw)
		}
	})

	t.Run("stream true releases the hold", func(t *testing.T) {
		status, raw := postAI(t, router, "/api/ai/chat/completions", "chat-stream", `{"model":"parity-model","stream":true,"messages":[{"role":"user","content":"hi"}]}`)
		if status != 502 || !bytes.Contains(raw, []byte(`UPSTREAM_FAILED`)) {
			t.Fatalf("%d %s", status, raw)
		}
		var state, class string
		var held int64
		if err := pool.QueryRow(ctx, `SELECT status, error_class, held_microfen FROM ai_requests WHERE org_id = $1 AND idempotency_key = 'chat-stream'`, org).Scan(&state, &class, &held); err != nil {
			t.Fatal(err)
		}
		if state != "failed" || class != "invalid_request" {
			t.Fatalf("%s %s held %d", state, class, held)
		}
		var walletHeld int64
		if err := pool.QueryRow(ctx, `SELECT held_microfen FROM user_wallets WHERE user_id = $1`, user).Scan(&walletHeld); err != nil || walletHeld != 0 {
			t.Fatalf("held %d %v", walletHeld, err)
		}
	})

	t.Run("insufficient balance writes no request", func(t *testing.T) {
		org3, user3 := seedAITenant(t, ctx, pool, 96023)
		local := chi.NewRouter()
		ai.Register(local, ai.HTTPDeps{
			Deps:   ai.Deps{Pool: pool, BaseURL: upstream.URL, Limits: &limits, Converter: llm.Default()},
			Access: access.FixedResolver{Principal: &access.Principal{UserID: user3, OrgID: org3, WorkspaceRole: "owner"}},
		})
		before := calls
		status, raw := postAI(t, local, "/api/ai/chat/completions", "chat-poor", `{"model":"parity-model","messages":[{"role":"user","content":"hi"}]}`)
		if status != 402 || calls != before || !bytes.Contains(raw, []byte("available 0, required 1")) {
			t.Fatalf("%d calls %d %s", status, calls, raw)
		}
		var n int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM ai_requests WHERE org_id = $1`, org3).Scan(&n); err != nil || n != 0 {
			t.Fatalf("rows %d %v", n, err)
		}
	})

	t.Run("empty estimate absorbs the whole charge", func(t *testing.T) {
		org4, user4 := seedAITenant(t, ctx, pool, 96024)
		local := chi.NewRouter()
		ai.Register(local, ai.HTTPDeps{
			Deps:   ai.Deps{Pool: pool, BaseURL: upstream.URL, Limits: &limits, Converter: llm.Default()},
			Access: access.FixedResolver{Principal: &access.Principal{UserID: user4, OrgID: org4, WorkspaceRole: "owner"}},
		})
		before := calls
		status, raw := postAI(t, local, "/api/ai/chat/completions", "chat-empty", `{"model":"parity-model","messages":[]}`)
		if status != 200 || calls != before+1 {
			t.Fatalf("%d calls %d %s", status, calls, raw)
		}
		var payload struct {
			Billing struct {
				Charged  int64 `json:"charged_microfen"`
				Absorbed int64 `json:"absorbed_microfen"`
				Total    int64 `json:"total_microfen"`
			} `json:"billing"`
		}
		if err := json.Unmarshal(raw, &payload); err != nil {
			t.Fatal(err)
		}
		if payload.Billing.Charged != 0 || payload.Billing.Absorbed != 1000 || payload.Billing.Total != 1000 {
			t.Fatalf("%s", raw)
		}
		var balance int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM user_wallets WHERE user_id = $1 AND (balance_microfen <> 0 OR held_microfen <> 0)`, user4).Scan(&balance); err != nil || balance != 0 {
			t.Fatalf("wallet rows %d %v", balance, err)
		}
	})

	t.Run("ocr post does not hold", func(t *testing.T) {
		status, raw := postAI(t, router, "/api/ai/ocr/completions", "ocr-1", `{"uploadTicket":"t"}`)
		if status != 400 || !bytes.Contains(raw, []byte("请求格式无效")) {
			t.Fatalf("%d %s", status, raw)
		}
	})

	t.Run("non loopback is refused before hold", func(t *testing.T) {
		var hit bool
		local := chi.NewRouter()
		ai.Register(local, ai.HTTPDeps{
			Deps:   ai.Deps{Pool: pool, BaseURL: "https://api.openai.com/v1", Limits: &limits, Upstream: hitUpstream{hit: &hit}},
			Access: access.FixedResolver{Principal: &access.Principal{UserID: user, OrgID: org, WorkspaceRole: "owner"}},
		})
		status, _ := postAI(t, local, "/api/ai/chat/completions", "chat-remote", `{"model":"parity-model","messages":[]}`)
		if status != 503 || hit {
			t.Fatalf("status %d hit %v", status, hit)
		}
	})

	t.Run("stranded reaper releases", func(t *testing.T) {
		if _, err := pool.Exec(ctx, `
			INSERT INTO ai_requests
			    (public_id, org_id, user_id, idempotency_key, operation, model, upstream_account_id,
			     status, price_schedule_id, billing_mode, per_request_microfen,
			     input_microfen_per_million, cached_input_microfen_per_million,
			     output_microfen_per_million, reasoning_microfen_per_million, held_microfen,
			     api_format, dispatched_at, updated_at)
			VALUES ('air_stranded', $1, $2, 'stranded-1', 'ai_token', 'parity-model', 'loopback',
			        'dispatching', $3, 'token', 0, 1000000, 0, 1000000, 0, 1000,
			        'chat_completions', clock_timestamp(), clock_timestamp() - interval '901 seconds')`,
			org, user, priceID); err != nil {
			t.Fatal(err)
		}
		var requestID int64
		if err := pool.QueryRow(ctx, `SELECT id FROM ai_requests WHERE public_id = 'air_stranded'`).Scan(&requestID); err != nil {
			t.Fatal(err)
		}
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := billingrepo.HoldTx(ctx, tx, org, "air_stranded", &requestID, 1000); err != nil {
			tx.Rollback(ctx)
			t.Fatal(err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		n, err := ai.SweepStranded(ctx, pool)
		if err != nil || n < 1 {
			t.Fatalf("swept %d %v", n, err)
		}
		var state, class string
		if err := pool.QueryRow(ctx, `SELECT status, error_class FROM ai_requests WHERE public_id = 'air_stranded'`).Scan(&state, &class); err != nil {
			t.Fatal(err)
		}
		if state != "unbilled_unknown" || class != "stranded_request" {
			t.Fatalf("%s %s", state, class)
		}
	})

	t.Run("alipay topup replay", func(t *testing.T) {
		if _, err := pool.Exec(ctx, `
			INSERT INTO payment_orders
			    (public_id, org_id, plan, months, amount_cents, currency, provider, status,
			     created_by_user_id, created_at, updated_at, product, topup_microfen)
			VALUES ('po_ai_96021', $1, 'lite', 1, 100, 'CNY', 'alipay', 'pending',
			        $2, clock_timestamp(), clock_timestamp(), 'wallet_topup', 100000000)`, org, user); err != nil {
			t.Fatal(err)
		}
		pay := chi.NewRouter()
		key, err := rsaKey()
		if err != nil {
			t.Fatal(err)
		}
		billinghttp.Register(pay, billinghttp.Deps{Pool: pool, Payments: billinghttp.Payments{Alipay: &billingdomain.AlipayKey{AppID: "2021000000000000", Public: &key.PublicKey}}})
		body := signedAlipay(t, key, "po_ai_96021", "1.00")
		status, raw := postForm(t, pay, "/api/billing/callback", body)
		if status != 200 || string(raw) != "success" {
			t.Fatalf("%d %s", status, raw)
		}
		status, raw = postForm(t, pay, "/api/billing/callback", body)
		if status != 200 || string(raw) != "success" {
			t.Fatalf("replay %d %s", status, raw)
		}
		var balance int64
		var orders int
		if err := pool.QueryRow(ctx, `SELECT balance_microfen FROM user_wallets WHERE user_id = $1`, user).Scan(&balance); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM payment_orders WHERE public_id = 'po_ai_96021' AND status = 'paid'`).Scan(&orders); err != nil || orders != 1 {
			t.Fatalf("orders %d %v", orders, err)
		}
		if balance < 100_000_000 {
			t.Fatalf("balance %d", balance)
		}
		status, raw = postForm(t, pay, "/api/billing/callback", []byte("out_trade_no=po_ai_96021&sign=bm8"))
		if status != 400 || string(raw) != "invalid notification\n" && string(raw) != "invalid notification" {
			t.Fatalf("bad sign %d %q", status, raw)
		}
	})

	t.Run("redeem wallet credits", func(t *testing.T) {
		var workspace string
		if err := pool.QueryRow(ctx, `SELECT uuid::text FROM organizations WHERE id = $1`, org).Scan(&workspace); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO redeem_codes
			    (code, plan, duration_days, used, created_at, updated_at, product, member_seats, ocr_credits, wallet_cents, tier)
			VALUES ('WALLET96021', 'pro', 30, false, clock_timestamp(), clock_timestamp(),
			        'wallet_credits', 0, 0, 100, NULL)`); err != nil {
			t.Fatal(err)
		}
		pay := chi.NewRouter()
		billinghttp.Register(pay, billinghttp.Deps{Pool: pool, Access: access.FixedResolver{Principal: &access.Principal{UserID: user, OrgID: org, WorkspaceRole: "owner"}}})
		before := walletBalance(t, ctx, pool, user)
		status, raw := postAIJSON(t, pay, "/api/redeem", fmt.Sprintf(`{"code":"wallet96021","expected_workspace_uuid":%q}`, workspace))
		if status != 200 || !bytes.Contains(raw, []byte(`"wallet_cents":100`)) || !bytes.Contains(raw, []byte(`"ocr_credits":0`)) {
			t.Fatalf("%d %s", status, raw)
		}
		if got := walletBalance(t, ctx, pool, user); got != before+100_000_000 {
			t.Fatalf("balance %d before %d", got, before)
		}
	})

	t.Run("lease refuses the second slot", func(t *testing.T) {
		held, status, message := ai.Acquire(ctx, pool, ai.Limits{User: 1, LeaseTTL: 90 * time.Second}, user, "loopback", false)
		if status != 0 {
			t.Fatalf("first %d %s", status, message)
		}
		defer held.Release(ctx)
		_, status, message = ai.Acquire(ctx, pool, ai.Limits{User: 1, LeaseTTL: 90 * time.Second}, user, "loopback", false)
		if status != 429 || message != "当前用户的 AI 并发已达上限，请稍后重试" {
			t.Fatalf("second %d %s", status, message)
		}
	})

	t.Run("listing charge ignores a missing job", func(t *testing.T) {
		if err := billingrepo.ChargeListingSubmit(ctx, pool, org, "00000000-0000-0000-0000-000000000099", 100); err != nil {
			t.Fatal(err)
		}
		if billingrepo.ListingSubmitPriceMicrofen() != 0 {
			t.Fatal("unset price")
		}
	})

	t.Run("entitlement sweep", func(t *testing.T) {
		if _, err := pool.Exec(ctx, `INSERT INTO subscriptions(org_id,status,plan_key,term_start,term_end,billing_anchor,extra_members,updated_at)
 VALUES($1,'active','pro',clock_timestamp()-interval '1 month',clock_timestamp()-interval '1 day',clock_timestamp()-interval '1 month',2,clock_timestamp())`, org); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE organizations SET plan = 'pro', seat_limit = 3 WHERE id = $1`, org); err != nil {
			t.Fatal(err)
		}
		n, err := billingrepo.SweepEntitlements(ctx, pool)
		if err != nil || n < 1 {
			t.Fatalf("swept %d %v", n, err)
		}
		var plan string
		var seats int64
		if err := pool.QueryRow(ctx, `SELECT plan, seat_limit FROM organizations WHERE id = $1`, org).Scan(&plan, &seats); err != nil {
			t.Fatal(err)
		}
		if plan != "free" || seats != 1 {
			t.Fatalf("plan %s seats %d", plan, seats)
		}
	})
}

func purgeAIFixtures(ctx context.Context, pool *pgxpool.Pool) error {
	_, err := pool.Exec(ctx, `
		ALTER TABLE wallet_ledger DISABLE TRIGGER wallet_ledger_no_rewrite;
		DELETE FROM wallet_ledger WHERE org_id IN (SELECT id FROM organizations WHERE owner_user_id BETWEEN 96000 AND 96999);
		ALTER TABLE wallet_ledger ENABLE TRIGGER wallet_ledger_no_rewrite;
		DELETE FROM ai_consume_logs WHERE org_id IN (SELECT id FROM organizations WHERE owner_user_id BETWEEN 96000 AND 96999);
		DELETE FROM ai_requests WHERE org_id IN (SELECT id FROM organizations WHERE owner_user_id BETWEEN 96000 AND 96999);
		DELETE FROM writer_leases WHERE domain = 'billing';
		DELETE FROM billing_operations WHERE org_id IN (SELECT id FROM organizations WHERE owner_user_id BETWEEN 96000 AND 96999);
		DELETE FROM lease_slot WHERE namespace = 'ai-lease' AND scope IN (
			SELECT 'user:' || id::text FROM account_users WHERE id BETWEEN 96000 AND 96999
			UNION ALL
			SELECT 'rate:user:' || id::text FROM account_users WHERE id BETWEEN 96000 AND 96999
		);
		DELETE FROM lease_window WHERE namespace = 'ai-lease' AND scope IN (
			SELECT 'rate:user:' || id::text FROM account_users WHERE id BETWEEN 96000 AND 96999
		);
		DELETE FROM payment_orders WHERE org_id IN (SELECT id FROM organizations WHERE owner_user_id BETWEEN 96000 AND 96999);
		DELETE FROM member_seat_lots WHERE org_id IN (SELECT id FROM organizations WHERE owner_user_id BETWEEN 96000 AND 96999);
		DELETE FROM redeem_codes WHERE code IN ('WALLET96021');
		DELETE FROM user_wallets WHERE user_id BETWEEN 96000 AND 96999;
		DELETE FROM organization_members WHERE user_id BETWEEN 96000 AND 96999;
		DELETE FROM organizations WHERE owner_user_id BETWEEN 96000 AND 96999;
		DELETE FROM account_users WHERE id BETWEEN 96000 AND 96999;
		DELETE FROM ai_price_schedules WHERE model = 'parity-model'`)
	return err
}

func seedAITenant(t *testing.T, ctx context.Context, pool *pgxpool.Pool, userID int64) (int64, int64) {
	t.Helper()
	tag := fmt.Sprintf("a%d", userID)
	if _, err := pool.Exec(ctx, `
		INSERT INTO account_users (id, public_id, email, password_hash, role, name, target, supplier_id, plan, created_at, updated_at)
		VALUES ($1, $2, $3, 'x', 'user', 'AI', '/workspace', '', 'lite', clock_timestamp(), clock_timestamp())`,
		userID, tag, tag+"@example.invalid"); err != nil {
		t.Fatal(err)
	}
	var orgID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO organizations (owner_user_id, name, plan, created_at, updated_at)
		VALUES ($1, $2, 'lite', clock_timestamp(), clock_timestamp()) RETURNING id`, userID, "org-"+tag).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO organization_members (org_id, user_id, role, status, display_name, created_at, updated_at, join_order)
		VALUES ($1, $2, 'owner', 'active', 'AI', clock_timestamp(), clock_timestamp(), 1)`, orgID, userID); err != nil {
		t.Fatal(err)
	}
	return orgID, userID
}

func insertPrice(t *testing.T, ctx context.Context, pool *pgxpool.Pool, model string) int64 {
	t.Helper()
	var id int64
	err := pool.QueryRow(ctx, `
		INSERT INTO ai_price_schedules
		    (model, billing_mode, input_microfen_per_million, cached_input_microfen_per_million,
		     output_microfen_per_million, reasoning_microfen_per_million, per_request_microfen,
		     max_request_microfen, effective_from)
		VALUES ($1, 'token', 1000000, 0, 1000000, 0, 0, 50000000, clock_timestamp())
		RETURNING id`, model).Scan(&id)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func postAI(t *testing.T, handler http.Handler, path, key, body string) (int, []byte) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewBufferString(body))
	req.RemoteAddr = "198.51.100.10:443"
	req.Header.Set("Idempotency-Key", key)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	raw, _ := io.ReadAll(rec.Body)
	return rec.Code, raw
}

func postAIJSON(t *testing.T, handler http.Handler, path, body string) (int, []byte) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	raw, _ := io.ReadAll(rec.Body)
	return rec.Code, raw
}

func postForm(t *testing.T, handler http.Handler, path string, body []byte) (int, []byte) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	raw, _ := io.ReadAll(rec.Body)
	return rec.Code, raw
}

func walletBalance(t *testing.T, ctx context.Context, pool *pgxpool.Pool, user int64) int64 {
	t.Helper()
	var n int64
	if err := pool.QueryRow(ctx, `SELECT balance_microfen FROM user_wallets WHERE user_id = $1`, user).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

type hitUpstream struct{ hit *bool }

func (h hitUpstream) Complete(context.Context, string, []byte) (int, []byte, error) {
	*h.hit = true
	return 200, []byte(`{}`), nil
}

func errorsAs(err error, target **billingcontract.Error) bool {
	return errors.As(err, target)
}

func rsaKey() (*rsa.PrivateKey, error) {
	return rsa.GenerateKey(rand.Reader, 2048)
}

func signedAlipay(t *testing.T, key *rsa.PrivateKey, publicID, yuan string) []byte {
	t.Helper()
	fields := map[string]string{
		"app_id": "2021000000000000", "out_trade_no": publicID, "total_amount": yuan,
		"trade_status": "TRADE_SUCCESS", "trade_no": "202608192200140000", "sign_type": "RSA2",
	}
	sum := sha256.Sum256([]byte(billingdomain.CanonicalAlipay(fields)))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sum[:])
	if err != nil {
		t.Fatal(err)
	}
	values := url.Values{}
	for key, value := range fields {
		values.Set(key, value)
	}
	values.Set("sign", base64.StdEncoding.EncodeToString(sig))
	return []byte(values.Encode())
}
