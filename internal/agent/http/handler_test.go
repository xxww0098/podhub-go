package agenthttp

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/podhub-go/internal/agent/contract"
	"github.com/xxww0098/podhub-go/internal/agent/domain"
	"github.com/xxww0098/podhub-go/tests/parity"
)

func signed(api API) http.Handler {
	r := chi.NewRouter()
	Mount(r, Deps{
		Service: api,
		Resolve: func(*http.Request) (contract.Actor, *Refusal, error) {
			return contract.Actor{UserID: 7, OrgID: 3}, nil, nil
		},
	})
	return r
}

func anon() http.Handler {
	r := chi.NewRouter()
	Mount(r, Deps{Resolve: func(*http.Request) (contract.Actor, *Refusal, error) {
		return contract.Actor{}, nil, nil
	}})
	return r
}

func jsonReq(method, path, body string) *http.Request {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	return req
}

func TestAnonymousIsAuthRequiredBeforeTheBody(t *testing.T) {
	routes := []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/api/agent"},
		{http.MethodPost, "/api/agent/claim"},
		{http.MethodGet, "/api/agent/ledger"},
		{http.MethodPut, "/api/agent/payout-account"},
		{http.MethodPost, "/api/agent/wallet-transfers"},
		{http.MethodGet, "/api/agent/withdrawals"},
		{http.MethodPost, "/api/agent/withdrawals"},
	}
	h := anon()
	for _, rt := range routes {
		rec := httptest.NewRecorder()
		req := jsonReq(rt.method, rt.path, `{`)
		h.ServeHTTP(rec, req)
		err := parity.DiffHTTP(parity.Exchange{Status: rec.Code, Body: rec.Body.Bytes()}, parity.Exchange{
			Status: http.StatusUnauthorized,
			Body:   []byte(`{"error":"未登录","code":"AUTH_REQUIRED"}`),
		})
		if err != nil {
			t.Fatalf("%s %s: %v", rt.method, rt.path, err)
		}
		if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Fatalf("%s %s missing nosniff", rt.method, rt.path)
		}
	}
}

func TestRefusalKeepsTheResolverMessage(t *testing.T) {
	r := chi.NewRouter()
	Mount(r, Deps{Resolve: func(*http.Request) (contract.Actor, *Refusal, error) {
		return contract.Actor{}, &Refusal{Status: http.StatusForbidden, Code: "FORBIDDEN", Message: "需要超级管理员权限"}, nil
	}})
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/agent", nil))
	if rec.Code != http.StatusForbidden || rec.Body.String() != `{"error":"需要超级管理员权限","code":"FORBIDDEN"}` {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("nosniff")
	}
}

func TestHTMLInTheErrorIsNotEscaped(t *testing.T) {
	r := chi.NewRouter()
	Mount(r, Deps{Resolve: func(*http.Request) (contract.Actor, *Refusal, error) {
		return contract.Actor{}, &Refusal{Status: http.StatusForbidden, Code: "FORBIDDEN", Message: "a<b&c"}, nil
	}})
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/agent", nil))
	if rec.Body.String() != `{"error":"a<b&c","code":"FORBIDDEN"}` {
		t.Fatal(rec.Body)
	}
}

func TestWorkbenchBytesOmitAnEmptyPayout(t *testing.T) {
	api := &fakeAPI{workbench: domain.Workbench{
		Agent:             &domain.Agent{InviteCode: "AB23CD45", Status: "active"},
		Wallet:            domain.Wallet{BalanceCents: 30000, HeldCents: 20000},
		AvailableCents:    10000,
		Policy:            domain.Policy{DefaultRebateBps: 1000, MinOrderCents: 10000, AttributionValidityDays: 365, MinWithdrawCents: 10000},
		TransferAvailable: true,
		InviteeCount:      3,
		CreditedCount:     2,
		CreditedTotal:     30000,
	}}
	rec := httptest.NewRecorder()
	signed(api).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/agent", nil))
	const want = `{"data":{"invite_code":"AB23CD45","status":"active","rebate_bps":1000,"min_order_cents":10000,"attribution_validity_days":365,"min_withdraw_cents":10000,"wallet":{"balance_cents":30000,"held_cents":20000,"available_cents":10000},"wallet_transfer_available":true,"invitee_count":3,"credited_count":2,"skipped_count":0,"credited_total_cents":30000,"commissions":[]}}`
	if err := parity.DiffHTTP(parity.Exchange{Status: rec.Code, Body: rec.Body.Bytes()}, parity.Exchange{Status: 200, Body: []byte(want)}); err != nil {
		t.Fatal(err)
	}
	if rec.Header().Get("X-Content-Type-Options") != "" {
		t.Fatal("success must not set nosniff")
	}
	if api.calls != 1 {
		t.Fatal(api.calls)
	}
}

func TestWorkbenchIncludesPayoutWhenSet(t *testing.T) {
	api := &fakeAPI{workbench: domain.Workbench{
		Agent: &domain.Agent{
			InviteCode: "AB23CD45", Status: "active",
			Payout: domain.Payout{Channel: "alipay", Account: "agent@x.invalid", RealName: "代理人"},
		},
		Policy: domain.Policy{DefaultRebateBps: 1000, MinOrderCents: 10000, AttributionValidityDays: 365, MinWithdrawCents: 10000},
		Commissions: []domain.CommissionView{{
			ID: 9, InviteeEmail: "i***@example.invalid", WorkspaceName: "invitee-b 的工作空间",
			Product: "member_seats", OrderAmountCents: 10000, RebateBps: 1000, AmountCents: 1000,
			Status: "credited", Note: "代理佣金 · 订单 po_1", CreatedAt: "2026-08-21T17:30:00.000Z",
		}},
	}}
	rec := httptest.NewRecorder()
	signed(api).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/agent", nil))
	const want = `{"data":{"invite_code":"AB23CD45","status":"active","rebate_bps":1000,"min_order_cents":10000,"attribution_validity_days":365,"min_withdraw_cents":10000,"wallet":{"balance_cents":0,"held_cents":0,"available_cents":0},"payout_account":{"channel":"alipay","account":"agent@x.invalid","real_name":"代理人"},"wallet_transfer_available":false,"invitee_count":0,"credited_count":0,"skipped_count":0,"credited_total_cents":0,"commissions":[{"id":9,"invitee_email":"i***@example.invalid","workspace_name":"invitee-b 的工作空间","product":"member_seats","order_amount_cents":10000,"rebate_bps":1000,"amount_cents":1000,"status":"credited","note":"代理佣金 · 订单 po_1","created_at":"2026-08-21T17:30:00.000Z"}]}}`
	if err := parity.DiffHTTP(parity.Exchange{Status: rec.Code, Body: rec.Body.Bytes()}, parity.Exchange{Status: 200, Body: []byte(want)}); err != nil {
		t.Fatal(err)
	}
}

func TestNotAgentIs404(t *testing.T) {
	api := &fakeAPI{err: contract.Fail(contract.KindNotFound, "你不是代理")}
	rec := httptest.NewRecorder()
	signed(api).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/agent/ledger", nil))
	if rec.Body.String() != `{"error":"你不是代理","code":"NOT_FOUND"}` || rec.Code != 404 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
}

func TestJSONRejectionDoesNotCallTheStore(t *testing.T) {
	api := &fakeAPI{}
	h := signed(api)
	cases := []struct {
		method string
		path   string
		ctype  string
		body   string
	}{
		{http.MethodPost, "/api/agent/claim", "", `{"code":"ABCD"}`},
		{http.MethodPost, "/api/agent/claim", "text/plain", `{"code":"ABCD"}`},
		{http.MethodPost, "/api/agent/claim", "application/json", ``},
		{http.MethodPost, "/api/agent/claim", "application/json", `{"code":`},
		{http.MethodPost, "/api/agent/claim", "application/json", `{"inviteCode":"ABCD"}`},
		{http.MethodPost, "/api/agent/claim", "application/json", `{}`},
		{http.MethodPost, "/api/agent/claim", "application/json", `{"code":null}`},
		{http.MethodPost, "/api/agent/claim", "application/json", `{"code":"ABCD"}{"code":"EFGH"}`},
		{http.MethodPut, "/api/agent/payout-account", "application/json", `{"channel":"alipay"}`},
		{http.MethodPost, "/api/agent/wallet-transfers", "application/json", `{"operation_id":"op-1","amount_cents":1.5}`},
		{http.MethodPost, "/api/agent/wallet-transfers", "application/json", `{"operation_id":"op-1"}`},
		{http.MethodPost, "/api/agent/withdrawals", "application/json", `{"amount_cents":"100"}`},
	}
	for _, tc := range cases {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
		if tc.ctype != "" {
			req.Header.Set("Content-Type", tc.ctype)
		}
		h.ServeHTTP(rec, req)
		if rec.Code != 400 || rec.Body.String() != `{"error":"请求格式无效","code":"VALIDATION"}` {
			t.Fatalf("%s %s %q: %d %s", tc.method, tc.path, tc.body, rec.Code, rec.Body)
		}
	}
	if api.calls != 0 {
		t.Fatal(api.calls)
	}
}

func TestOversizeBodyIsValidation(t *testing.T) {
	api := &fakeAPI{}
	body := append([]byte(`{"code":"`), bytes.Repeat([]byte("A"), int(domain.BodyLimitBytes))...)
	body = append(body, '"', '}')
	req := httptest.NewRequest(http.MethodPost, "/api/agent/claim", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	signed(api).ServeHTTP(rec, req)
	if rec.Code != 400 || rec.Body.String() != `{"error":"请求格式无效","code":"VALIDATION"}` {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	if api.calls != 0 {
		t.Fatal(api.calls)
	}
}

func TestPayoutNullClearsAndPartialIsRejected(t *testing.T) {
	api := &fakeAPI{cleared: true}
	rec := httptest.NewRecorder()
	signed(api).ServeHTTP(rec, jsonReq(http.MethodPut, "/api/agent/payout-account", `{"channel":null,"account":null,"real_name":null}`))
	if rec.Code != 200 || rec.Body.String() != `{"data":null}` {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	if api.channel != nil || api.account != nil || api.realName != nil {
		t.Fatalf("nulls became values")
	}
	api.saved = domain.Payout{Channel: "wechat", Account: "wxid", RealName: "甲乙"}
	api.cleared = false
	rec = httptest.NewRecorder()
	signed(api).ServeHTTP(rec, jsonReq(http.MethodPut, "/api/agent/payout-account", `{"channel":" WeChat ","account":" wxid ","real_name":"甲乙"}`))
	const want = `{"data":{"channel":"wechat","account":"wxid","real_name":"甲乙"}}`
	if rec.Body.String() != want {
		t.Fatal(rec.Body)
	}
}

func TestClaimAndTransferAndWithdrawalBytes(t *testing.T) {
	ref := "流水"
	api := &fakeAPI{
		name: "Agent J",
		moved: domain.Transfer{
			OperationID: "op-1", AmountCents: 10000, WalletBalanceMicrofen: 10000 * 1000000,
			WorkspaceUUID: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", WorkspaceName: "甲的工作空间",
		},
		withdrawal: domain.WithdrawalView{
			PublicID: "wd_ABCDEFGHJKLM", AmountCents: 10000, Channel: "alipay",
			Account: "a@pay", RealName: "甲乙", Status: "pending", RequestedAt: "2026-08-21T17:30:00.000Z",
		},
		withdrawals: []domain.WithdrawalView{{
			PublicID: "wd_ABCDEFGHJKLM", AmountCents: 10000, Channel: "alipay",
			Account: "a@pay", RealName: "甲乙", Status: "paid", Reference: &ref,
			RequestedAt: "2026-08-21T17:30:00.000Z", DecidedAt: strPtr("2026-08-21T18:00:00.000Z"),
		}},
		entries: []domain.LedgerView{{
			EntryType: "transfer_out", AmountCents: -10000, BalanceAfterCents: 50000,
			Note: "转入钱包 · op-1", CreatedAt: "2026-08-21T17:30:00.000Z",
		}},
	}
	h := signed(api)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, jsonReq(http.MethodPost, "/api/agent/claim", `{"code":" ab12 "}`))
	if rec.Body.String() != `{"data":{"agent_name":"Agent J"}}` || api.code != " ab12 " {
		t.Fatalf("claim %s code %q", rec.Body, api.code)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, jsonReq(http.MethodPost, "/api/agent/wallet-transfers", `{"operation_id":"op-1","amount_cents":10000}`))
	const transfer = `{"data":{"operation_id":"op-1","amount_cents":10000,"wallet_balance_microfen":10000000000,"workspace_uuid":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","workspace_name":"甲的工作空间"}}`
	if err := parity.DiffHTTP(parity.Exchange{Status: rec.Code, Body: rec.Body.Bytes()}, parity.Exchange{Status: 200, Body: []byte(transfer)}); err != nil {
		t.Fatal(err)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, jsonReq(http.MethodPost, "/api/agent/withdrawals", `{"amount_cents":10000}`))
	const pending = `{"data":{"public_id":"wd_ABCDEFGHJKLM","amount_cents":10000,"channel":"alipay","account":"a@pay","real_name":"甲乙","status":"pending","requested_at":"2026-08-21T17:30:00.000Z"}}`
	if rec.Body.String() != pending {
		t.Fatal(rec.Body)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/agent/withdrawals", nil))
	const listed = `{"data":{"withdrawals":[{"public_id":"wd_ABCDEFGHJKLM","amount_cents":10000,"channel":"alipay","account":"a@pay","real_name":"甲乙","status":"paid","reference":"流水","requested_at":"2026-08-21T17:30:00.000Z","decided_at":"2026-08-21T18:00:00.000Z"}]}}`
	if rec.Body.String() != listed {
		t.Fatal(rec.Body)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/agent/ledger", nil))
	const ledger = `{"data":{"entries":[{"entry_type":"transfer_out","amount_cents":-10000,"held_delta_cents":0,"balance_after_cents":50000,"note":"转入钱包 · op-1","created_at":"2026-08-21T17:30:00.000Z"}]}}`
	if rec.Body.String() != ledger {
		t.Fatal(rec.Body)
	}
}

func TestFailureKinds(t *testing.T) {
	cases := []struct {
		err    error
		status int
		body   string
		retry  string
	}{
		{contract.Fail(contract.KindValidation, "邀请码无效"), 400, `{"error":"邀请码无效","code":"VALIDATION"}`, ""},
		{contract.Fail(contract.KindConflict, "可用余额不足"), 409, `{"error":"可用余额不足","code":"CONFLICT"}`, ""},
		{contract.Fail(contract.KindDisabled, "认证域写入未启用"), 503, `{"error":"认证域写入未启用","code":"INTERNAL"}`, ""},
		{contract.FailBusy(), 503, `{"error":"资源正在更新，请稍后重试","code":"INTERNAL"}`, "1"},
		{contract.Fail(contract.KindMedia, "媒体对象已进入回收，请重新上传"), 409, `{"error":"媒体对象已进入回收，请重新上传","code":"INTERNAL"}`, ""},
		{contract.Fail(contract.KindInternal, "服务暂不可用"), 500, `{"error":"服务暂不可用","code":"INTERNAL"}`, ""},
	}
	for _, tc := range cases {
		api := &fakeAPI{err: tc.err}
		rec := httptest.NewRecorder()
		signed(api).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/agent", nil))
		if rec.Code != tc.status || rec.Body.String() != tc.body || rec.Header().Get("Retry-After") != tc.retry {
			t.Fatalf("%v: %d %s retry %q", tc.err, rec.Code, rec.Body, rec.Header().Get("Retry-After"))
		}
	}
}

func strPtr(s string) *string { return &s }

type fakeAPI struct {
	calls       int
	workbench   domain.Workbench
	entries     []domain.LedgerView
	withdrawals []domain.WithdrawalView
	withdrawal  domain.WithdrawalView
	moved       domain.Transfer
	name        string
	saved       domain.Payout
	cleared     bool
	err         error
	code        string
	channel     *string
	account     *string
	realName    *string
}

func (f *fakeAPI) Workbench(context.Context, contract.Actor) (domain.Workbench, error) {
	f.calls++
	return f.workbench, f.err
}
func (f *fakeAPI) Ledger(context.Context, contract.Actor) ([]domain.LedgerView, error) {
	f.calls++
	return f.entries, f.err
}
func (f *fakeAPI) Withdrawals(context.Context, contract.Actor) ([]domain.WithdrawalView, error) {
	f.calls++
	return f.withdrawals, f.err
}
func (f *fakeAPI) Claim(_ context.Context, _ contract.Actor, code string) (string, error) {
	f.calls++
	f.code = code
	return f.name, f.err
}
func (f *fakeAPI) SavePayout(_ context.Context, _ contract.Actor, channel, account, realName *string) (domain.Payout, bool, error) {
	f.calls++
	f.channel, f.account, f.realName = channel, account, realName
	return f.saved, f.cleared, f.err
}
func (f *fakeAPI) Transfer(context.Context, contract.Actor, string, int64) (domain.Transfer, error) {
	f.calls++
	return f.moved, f.err
}
func (f *fakeAPI) RequestWithdrawal(context.Context, contract.Actor, int64) (domain.WithdrawalView, error) {
	f.calls++
	return f.withdrawal, f.err
}
