package integration

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/xxww0098/podhub-go/internal/agent/contract"
	agenthttp "github.com/xxww0098/podhub-go/internal/agent/http"
	agentrepo "github.com/xxww0098/podhub-go/internal/agent/repo"
	"github.com/xxww0098/podhub-go/internal/agent/service"
	"github.com/xxww0098/podhub-go/tests/parity"
)

func TestAgentFlows(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	seedMatchingLease(t, ctx, pool, "auth", "agent flow")
	stamp := strconv.FormatInt(time.Now().UnixNano(), 36)
	agentUser, agentOrg := insertWorkspace(t, ctx, pool, "agent-"+stamp+"@example.invalid", "甲的工作空间")
	claimer, claimerOrg := insertWorkspace(t, ctx, pool, "invitee@"+stamp+".example.invalid", "invitee-b 的工作空间")
	outsider, _ := insertWorkspace(t, ctx, pool, "out-"+stamp+"@example.invalid", "外人")
	code := "AG" + strings.ToUpper(stamp)
	if len(code) > 32 {
		code = code[:32]
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO public.agents (user_id, invite_code, status, created_by_user_id)
		VALUES ($1, $2, 'active', $1)`, agentUser, code); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO public.agent_commission_wallets (user_id, balance_cents)
		VALUES ($1, 60000)`, agentUser); err != nil {
		t.Fatal(err)
	}
	agent := mountAgent(pool, agentUser, agentOrg)
	claimH := mountAgent(pool, claimer, claimerOrg)
	outH := mountAgent(pool, outsider, 0)

	t.Run("outsider workbench is 404", func(t *testing.T) {
		rec := callAgent(outH, http.MethodGet, "/api/agent", "")
		if err := parity.DiffHTTP(parity.Exchange{Status: rec.Code, Body: rec.Body.Bytes()}, parity.Exchange{
			Status: http.StatusNotFound,
			Body:   []byte(`{"error":"你不是代理","code":"NOT_FOUND"}`),
		}); err != nil {
			t.Fatal(err)
		}
		if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Fatal(rec.Header())
		}
	})

	t.Run("workbench omits an empty payout and shows the seeded balance", func(t *testing.T) {
		rec := callAgent(agent, http.MethodGet, "/api/agent", "")
		if rec.Code != 200 {
			t.Fatal(rec.Body)
		}
		if rec.Header().Get("X-Content-Type-Options") != "" {
			t.Fatal("nosniff on success")
		}
		var body struct {
			Data struct {
				InviteCode string          `json:"invite_code"`
				Status     string          `json:"status"`
				RebateBps  int64           `json:"rebate_bps"`
				Transfer   bool            `json:"wallet_transfer_available"`
				Payout     json.RawMessage `json:"payout_account"`
				Wallet     struct {
					Balance int64 `json:"balance_cents"`
					Held    int64 `json:"held_cents"`
					Avail   int64 `json:"available_cents"`
				} `json:"wallet"`
				Commissions []json.RawMessage `json:"commissions"`
			} `json:"data"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if body.Data.InviteCode != code || body.Data.Status != "active" || body.Data.RebateBps != 1000 || !body.Data.Transfer {
			t.Fatalf("%+v", body.Data)
		}
		if body.Data.Payout != nil {
			t.Fatalf("payout key present: %s", body.Data.Payout)
		}
		if body.Data.Wallet.Balance != 60000 || body.Data.Wallet.Held != 0 || body.Data.Wallet.Avail != 60000 {
			t.Fatalf("%+v", body.Data.Wallet)
		}
		if body.Data.Commissions == nil {
			t.Fatal("null commissions")
		}
	})

	t.Run("claim binds once and audits", func(t *testing.T) {
		rec := callAgent(claimH, http.MethodPost, "/api/agent/claim", `{"code":" `+strings.ToLower(code)+` "}`)
		want := `{"data":{"agent_name":"甲的工作空间"}}`
		if err := parity.DiffHTTP(parity.Exchange{Status: rec.Code, Body: rec.Body.Bytes()}, parity.Exchange{Status: 200, Body: []byte(want)}); err != nil {
			t.Fatal(err)
		}
		var message string
		var orgID int64
		if err := pool.QueryRow(ctx, `
			SELECT message, org_id FROM audit_logs
			 WHERE action = 'agent_attribution_bound' AND user_id = $1`, claimer).Scan(&message, &orgID); err != nil {
			t.Fatal(err)
		}
		if orgID != claimerOrg {
			t.Fatal(orgID)
		}
		wantMsg := `{"summary":"绑定代理邀请码 ` + code + `","agent_user_id":` + strconv.FormatInt(agentUser, 10) + `,"agent_attribution_bps":1000}`
		if message != wantMsg {
			t.Fatalf("audit %s", message)
		}
		again := callAgent(claimH, http.MethodPost, "/api/agent/claim", `{"code":"`+code+`"}`)
		if again.Code != 409 || again.Body.String() != `{"error":"已绑定邀请码","code":"CONFLICT"}` {
			t.Fatal(again.Code, again.Body)
		}
		self := callAgent(agent, http.MethodPost, "/api/agent/claim", `{"code":"`+code+`"}`)
		if self.Code != 400 || self.Body.String() != `{"error":"邀请码无效","code":"VALIDATION"}` {
			t.Fatal(self.Code, self.Body)
		}
	})

	t.Run("workbench masks the invitee from the commission row", func(t *testing.T) {
		var orderID int64
		if err := pool.QueryRow(ctx, `
			INSERT INTO public.payment_orders (
				public_id, org_id, months, amount_cents, currency, provider, status,
				created_by_user_id, paid_at, created_at, updated_at, product, topup_microfen)
			VALUES ($1, $2, 1, 10000, 'CNY', 'mock', 'paid', $3, clock_timestamp(), clock_timestamp(), clock_timestamp(), 'wallet_topup', 1000000)
			RETURNING id`, "comm-"+stamp, claimerOrg, claimer).Scan(&orderID); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO public.agent_commissions (
				agent_user_id, invitee_user_id, payment_order_id, org_id,
				order_amount_cents, rebate_bps, amount_cents, ledger_idempotency_key, status, note)
			VALUES ($1, $2, $3, $4, 10000, 1000, 1000, $5, 'credited', '代理佣金 · 订单 comm')`,
			agentUser, claimer, orderID, claimerOrg, "commission:"+stamp); err != nil {
			t.Fatal(err)
		}
		rec := callAgent(agent, http.MethodGet, "/api/agent", "")
		if rec.Code != 200 {
			t.Fatal(rec.Body)
		}
		email := "invitee@" + stamp + ".example.invalid"
		masked := "i***@" + stamp + ".example.invalid"
		if !strings.Contains(rec.Body.String(), `"invitee_email":"`+masked+`"`) || strings.Contains(rec.Body.String(), email) {
			t.Fatal(rec.Body)
		}
		if !strings.Contains(rec.Body.String(), `"workspace_name":"invitee-b 的工作空间"`) || !strings.Contains(rec.Body.String(), `"product":"wallet_topup"`) {
			t.Fatal(rec.Body)
		}
		if !strings.Contains(rec.Body.String(), `"invitee_count":1`) || !strings.Contains(rec.Body.String(), `"credited_count":1`) || !strings.Contains(rec.Body.String(), `"credited_total_cents":1000`) {
			t.Fatal(rec.Body)
		}
	})

	t.Run("a paid order blocks a later claim", func(t *testing.T) {
		buyer, buyerOrg := insertWorkspace(t, ctx, pool, "paid-"+stamp+"@example.invalid", "已付款")
		if _, err := pool.Exec(ctx, `
			INSERT INTO public.payment_orders (
				public_id, org_id, months, amount_cents, currency, provider, status,
				created_by_user_id, paid_at, created_at, updated_at, product, topup_microfen)
			VALUES ($1, $2, 1, 100, 'CNY', 'mock', 'paid', $3, clock_timestamp(), clock_timestamp(), clock_timestamp(), 'wallet_topup', 1000000)`,
			"pay-"+stamp, buyerOrg, buyer); err != nil {
			t.Fatal(err)
		}
		rec := callAgent(mountAgent(pool, buyer, buyerOrg), http.MethodPost, "/api/agent/claim", `{"code":"`+code+`"}`)
		if rec.Code != 409 || rec.Body.String() != `{"error":"已有订单，无法绑定","code":"CONFLICT"}` {
			t.Fatal(rec.Code, rec.Body)
		}
	})

	t.Run("disabled code is invalid and the agent can still read", func(t *testing.T) {
		if _, err := pool.Exec(ctx, `UPDATE public.agents SET status = 'disabled' WHERE user_id = $1`, agentUser); err != nil {
			t.Fatal(err)
		}
		fresh, freshOrg := insertWorkspace(t, ctx, pool, "fresh-"+stamp+"@example.invalid", "新人")
		rec := callAgent(mountAgent(pool, fresh, freshOrg), http.MethodPost, "/api/agent/claim", `{"code":"`+code+`"}`)
		if rec.Code != 400 || rec.Body.String() != `{"error":"邀请码无效","code":"VALIDATION"}` {
			t.Fatal(rec.Code, rec.Body)
		}
		got := callAgent(agent, http.MethodGet, "/api/agent", "")
		if got.Code != 200 || !strings.Contains(got.Body.String(), `"status":"disabled"`) {
			t.Fatal(got.Code, got.Body)
		}
		if _, err := pool.Exec(ctx, `UPDATE public.agents SET status = 'active' WHERE user_id = $1`, agentUser); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("payout save and clear", func(t *testing.T) {
		rec := callAgent(agent, http.MethodPut, "/api/agent/payout-account", `{"channel":" Alipay ","account":" 13800000000 ","real_name":" 甲乙 "}`)
		const want = `{"data":{"channel":"alipay","account":"13800000000","real_name":"甲乙"}}`
		if err := parity.DiffHTTP(parity.Exchange{Status: rec.Code, Body: rec.Body.Bytes()}, parity.Exchange{Status: 200, Body: []byte(want)}); err != nil {
			t.Fatal(err)
		}
		var message string
		if err := pool.QueryRow(ctx, `
			SELECT message FROM audit_logs
			 WHERE action = 'agent_payout_account_saved' AND user_id = $1
			 ORDER BY id DESC LIMIT 1`, agentUser).Scan(&message); err != nil {
			t.Fatal(err)
		}
		if message != `{"summary":"保存收款方式","channel":"alipay"}` {
			t.Fatal(message)
		}
		cleared := callAgent(agent, http.MethodPut, "/api/agent/payout-account", `{"channel":null,"account":null,"real_name":null}`)
		if cleared.Body.String() != `{"data":null}` {
			t.Fatal(cleared.Body)
		}
		restored := callAgent(agent, http.MethodPut, "/api/agent/payout-account", `{"channel":"alipay","account":"13800000000","real_name":"甲乙"}`)
		if restored.Code != 200 {
			t.Fatal(restored.Body)
		}
	})

	t.Run("transfer moves cents once and a mismatch conflicts", func(t *testing.T) {
		var uuid string
		if err := pool.QueryRow(ctx, `SELECT lower(uuid::text) FROM organizations WHERE id = $1`, agentOrg).Scan(&uuid); err != nil {
			t.Fatal(err)
		}
		rec := callAgent(agent, http.MethodPost, "/api/agent/wallet-transfers", `{"operation_id":" op-1 ","amount_cents":10000}`)
		want := `{"data":{"operation_id":"op-1","amount_cents":10000,"wallet_balance_microfen":10000000000,"workspace_uuid":"` + uuid + `","workspace_name":"甲的工作空间"}}`
		if err := parity.DiffHTTP(parity.Exchange{Status: rec.Code, Body: rec.Body.Bytes()}, parity.Exchange{Status: 200, Body: []byte(want)}); err != nil {
			t.Fatal(err)
		}
		replay := callAgent(agent, http.MethodPost, "/api/agent/wallet-transfers", `{"operation_id":"op-1","amount_cents":10000}`)
		if replay.Body.String() != want {
			t.Fatal(replay.Body)
		}
		var transfers, walletRows int
		var balance, commission int64
		if err := pool.QueryRow(ctx, `
			SELECT count(*) FROM agent_commission_ledger
			 WHERE user_id = $1 AND entry_type = 'transfer_out' AND idempotency_key = 'agent_transfer:op-1'`, agentUser).Scan(&transfers); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, `
			SELECT count(*) FROM wallet_ledger
			 WHERE org_id = $1 AND entry_type = 'adjustment' AND idempotency_key = 'agent_transfer:op-1'`, agentOrg).Scan(&walletRows); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, `SELECT balance_microfen FROM user_wallets WHERE user_id = $1`, agentUser).Scan(&balance); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, `SELECT balance_cents FROM agent_commission_wallets WHERE user_id = $1`, agentUser).Scan(&commission); err != nil {
			t.Fatal(err)
		}
		if transfers != 1 || walletRows != 1 || balance != 10_000_000_000 || commission != 50000 {
			t.Fatalf("transfers %d wallet %d balance %d commission %d", transfers, walletRows, balance, commission)
		}
		mismatch := callAgent(agent, http.MethodPost, "/api/agent/wallet-transfers", `{"operation_id":"op-1","amount_cents":5000}`)
		if mismatch.Code != 409 || mismatch.Body.String() != `{"error":"operation_id 与已提交参数不一致","code":"CONFLICT"}` {
			t.Fatal(mismatch.Code, mismatch.Body)
		}
		if err := pool.QueryRow(ctx, `SELECT balance_cents FROM agent_commission_wallets WHERE user_id = $1`, agentUser).Scan(&commission); err != nil {
			t.Fatal(err)
		}
		if commission != 50000 {
			t.Fatal(commission)
		}
	})

	t.Run("withdrawal freezes held and a second pending conflicts", func(t *testing.T) {
		rec := callAgent(agent, http.MethodPost, "/api/agent/withdrawals", `{"amount_cents":10000}`)
		if rec.Code != 200 {
			t.Fatal(rec.Code, rec.Body)
		}
		var body struct {
			Data struct {
				PublicID string          `json:"public_id"`
				Status   string          `json:"status"`
				Channel  string          `json:"channel"`
				Account  string          `json:"account"`
				RealName string          `json:"real_name"`
				Amount   int64           `json:"amount_cents"`
				Ref      json.RawMessage `json:"reference"`
				Reason   json.RawMessage `json:"reject_reason"`
				Decided  json.RawMessage `json:"decided_at"`
			} `json:"data"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if !regexp.MustCompile(`^wd_[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$`).MatchString(body.Data.PublicID) {
			t.Fatal(body.Data.PublicID)
		}
		if body.Data.Status != "pending" || body.Data.Amount != 10000 || body.Data.Channel != "alipay" || body.Data.Account != "13800000000" || body.Data.RealName != "甲乙" {
			t.Fatalf("%+v", body.Data)
		}
		if body.Data.Ref != nil || body.Data.Reason != nil || body.Data.Decided != nil {
			t.Fatalf("optional keys %s %s %s", body.Data.Ref, body.Data.Reason, body.Data.Decided)
		}
		if !strings.Contains(rec.Body.String(), `"requested_at":"`) {
			t.Fatal(rec.Body)
		}
		var held int64
		if err := pool.QueryRow(ctx, `SELECT held_cents FROM agent_commission_wallets WHERE user_id = $1`, agentUser).Scan(&held); err != nil {
			t.Fatal(err)
		}
		if held != 10000 {
			t.Fatal(held)
		}
		var audit string
		if err := pool.QueryRow(ctx, `
			SELECT message FROM audit_logs WHERE action = 'agent_withdrawal_requested' AND user_id = $1`, agentUser).Scan(&audit); err != nil {
			t.Fatal(err)
		}
		if audit != `{"summary":"申请提现 `+body.Data.PublicID+`","amount_cents":10000}` {
			t.Fatal(audit)
		}
		again := callAgent(agent, http.MethodPost, "/api/agent/withdrawals", `{"amount_cents":10000}`)
		if again.Code != 409 || again.Body.String() != `{"error":"已有在途提现","code":"CONFLICT"}` {
			t.Fatal(again.Code, again.Body)
		}
		ledger := callAgent(agent, http.MethodGet, "/api/agent/ledger", "")
		if !strings.Contains(ledger.Body.String(), `"entry_type":"transfer_out"`) || strings.Contains(ledger.Body.String(), "withdrawal_hold") {
			t.Fatal(ledger.Body)
		}
	})

	t.Run("no live workspace refuses the transfer", func(t *testing.T) {
		lonely := insertUser(t, ctx, pool, "lonely-"+stamp+"@example.invalid", "无空间")
		lonelyCode := "ZZ" + strings.ToUpper(stamp)
		if len(lonelyCode) > 32 {
			lonelyCode = lonelyCode[len(lonelyCode)-32:]
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO public.agents (user_id, invite_code, status, created_by_user_id)
			VALUES ($1, $2, 'active', $1)`, lonely, lonelyCode); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO public.agent_commission_wallets (user_id, balance_cents) VALUES ($1, 20000)`, lonely); err != nil {
			t.Fatal(err)
		}
		h := mountAgent(pool, lonely, 0)
		rec := callAgent(h, http.MethodGet, "/api/agent", "")
		if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"wallet_transfer_available":false`) {
			t.Fatal(rec.Body)
		}
		moved := callAgent(h, http.MethodPost, "/api/agent/wallet-transfers", `{"operation_id":"op-off","amount_cents":10000}`)
		if moved.Code != 409 || moved.Body.String() != `{"error":"没有可转入的工作空间","code":"CONFLICT"}` {
			t.Fatal(moved.Code, moved.Body)
		}
	})

	t.Run("an auth lease disables the write and an empty table refuses it", func(t *testing.T) {
		tag := "agent-flow-" + stamp
		if _, err := pool.Exec(ctx, `DELETE FROM public.writer_leases WHERE domain = 'auth' AND revoked_at_ms IS NULL`); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO public.writer_leases (
				domain, holder, holder_instance, fence_token,
				granted_at_ms, expires_at_ms, heartbeat_at_ms, grant_reason)
			VALUES ('auth', 'axum', $1, 1, 1, 9, 1, 'test')`, tag); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			_, _ = pool.Exec(context.Background(), `DELETE FROM public.writer_leases WHERE holder_instance = $1`, tag)
		})
		blocked := callAgent(agent, http.MethodPut, "/api/agent/payout-account", `{"channel":"wechat","account":"wxid_agent","real_name":"甲乙"}`)
		if blocked.Code != 503 || blocked.Body.String() != `{"error":"认证域写入未启用","code":"INTERNAL"}` {
			t.Fatal(blocked.Code, blocked.Body)
		}
		var channel *string
		if err := pool.QueryRow(ctx, `SELECT payout_channel FROM agents WHERE user_id = $1`, agentUser).Scan(&channel); err != nil {
			t.Fatal(err)
		}
		if channel == nil || *channel != "alipay" {
			t.Fatalf("payout changed to %v", channel)
		}
		if _, err := pool.Exec(ctx, `UPDATE public.writer_leases SET revoked_at_ms = 2 WHERE holder_instance = $1`, tag); err != nil {
			t.Fatal(err)
		}
		still := callAgent(agent, http.MethodPut, "/api/agent/payout-account", `{"channel":"wechat","account":"wxid_agent","real_name":"甲乙"}`)
		if still.Code != 503 {
			t.Fatal(still.Code, still.Body)
		}
		if _, err := pool.Exec(ctx, `DELETE FROM public.writer_leases WHERE holder_instance = $1`, tag); err != nil {
			t.Fatal(err)
		}
		empty := callAgent(agent, http.MethodPut, "/api/agent/payout-account", `{"channel":"wechat","account":"wxid_agent","real_name":"甲乙"}`)
		if empty.Code != 503 || empty.Body.String() != `{"error":"认证域写入未启用","code":"INTERNAL"}` {
			t.Fatal(empty.Code, empty.Body)
		}
		seedMatchingLease(t, ctx, pool, "auth", "agent flow")
		ok := callAgent(agent, http.MethodPut, "/api/agent/payout-account", `{"channel":"wechat","account":"wxid_agent","real_name":"甲乙"}`)
		if ok.Code != 200 || !strings.Contains(ok.Body.String(), `"channel":"wechat"`) {
			t.Fatal(ok.Code, ok.Body)
		}
	})

	t.Run("wallet rows stay hidden without the wallet guc", func(t *testing.T) {
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		if _, err := tx.Exec(ctx, `SELECT set_config('role', 'podhub_app', true)`); err != nil {
			t.Fatal(err)
		}
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM public.user_wallets WHERE user_id = $1`, agentUser).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 0 {
			t.Fatalf("missing guc saw %d wallet rows", n)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO public.user_wallets (user_id) VALUES ($1)`, outsider); err == nil {
			t.Fatal("insert without guc")
		}
	})
}

func TestAgentReviewFlag(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	pool := migratedPool(t, ctx)
	seedMatchingLease(t, ctx, pool, "auth", "agent review")
	stamp := strconv.FormatInt(time.Now().UnixNano(), 36)
	agentUser, _ := insertWorkspace(t, ctx, pool, "flag-agent-"+stamp+"@example.invalid", "标记代理")
	code := "FL" + strings.ToUpper(stamp)
	if len(code) > 32 {
		code = code[:32]
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO public.agents (user_id, invite_code, status, created_by_user_id)
		VALUES ($1, $2, 'active', $1)`, agentUser, code); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 20; i++ {
		id := insertUser(t, ctx, pool, "flag-"+stamp+"-"+strconv.Itoa(i)+"@example.invalid", "被邀")
		if _, err := pool.Exec(ctx, `
			UPDATE public.account_users
			   SET invited_by_agent_user_id = $2,
			       agent_attributed_at = clock_timestamp(),
			       agent_attribution_bps = 1000,
			       agent_attribution_source = 'claim'
			 WHERE id = $1`, id, agentUser); err != nil {
			t.Fatal(err)
		}
	}
	last, lastOrg := insertWorkspace(t, ctx, pool, "flag-last-"+stamp+"@example.invalid", "第二十一")
	rec := callAgent(mountAgent(pool, last, lastOrg), http.MethodPost, "/api/agent/claim", `{"code":"`+code+`"}`)
	if rec.Code != 200 {
		t.Fatal(rec.Code, rec.Body)
	}
	var flagged *time.Time
	if err := pool.QueryRow(ctx, `SELECT review_flagged_at FROM agents WHERE user_id = $1`, agentUser).Scan(&flagged); err != nil {
		t.Fatal(err)
	}
	if flagged == nil {
		t.Fatal("review flag not set")
	}
}

func mountAgent(pool *pgxpool.Pool, userID, orgID int64) http.Handler {
	r := chi.NewRouter()
	agenthttp.Mount(r, agenthttp.Deps{
		Service: service.New(agentrepo.New(pool)),
		Resolve: func(*http.Request) (contract.Actor, *agenthttp.Refusal, error) {
			return contract.Actor{UserID: userID, OrgID: orgID}, nil, nil
		},
	})
	return r
}

func callAgent(h http.Handler, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if method == http.MethodPost || method == http.MethodPut {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func insertUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool, email, name string) int64 {
	t.Helper()
	var id int64
	err := pool.QueryRow(ctx, `
		INSERT INTO public.account_users (public_id, email, password_hash, name, created_at, updated_at)
		VALUES ($1, $2, 'x', $3, clock_timestamp(), clock_timestamp())
		RETURNING id`, email, email, name).Scan(&id)
	if err != nil {
		t.Fatal(err)
	}
	return id
}
