package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	admindomain "github.com/xxww0098/podhub-go/internal/admin/domain"
	billing "github.com/xxww0098/podhub-go/internal/billing/contract"
	mcpdomain "github.com/xxww0098/podhub-go/internal/mcp/domain"
	mcphttp "github.com/xxww0098/podhub-go/internal/mcp/http"
	mcpsvc "github.com/xxww0098/podhub-go/internal/mcp/service"
)

func TestCodeAdminMatchesAdminRules(t *testing.T) {
	now := time.Date(2030, 1, 2, 3, 4, 5, 0, time.UTC)
	const plain = "POD-WALLET-PLAINTEXT"
	goodWallet := `{"wallet_cents":2500,"quantity":1,"expires_at":"2030-06-01T00:00:00Z","note":"甲"}`
	cases := []struct {
		name       string
		role       string
		kind       string
		body       string
		wantCode   string
		wantMsg    string
		wantCreate int
		wantList   int
	}{
		{"super quota", "super_admin", "quota", goodWallet, "", "", 1, 0},
		{"super list", "super_admin", "list", `{}`, "", "", 0, 1},
		{"member", "user", "quota", goodWallet, "forbidden", "需要超级管理员权限", 0, 0},
		{"platform admin", "admin", "quota", goodWallet, "forbidden", "需要超级管理员权限", 0, 0},
		{"org owner is not super", "user", "list", `{}`, "forbidden", "需要超级管理员权限", 0, 0},
		{"quantity", "super_admin", "quota", `{"wallet_cents":100,"quantity":501}`, "invalid_arguments", "兑换码数量需在 1-500 之间", 0, 0},
		{"retired seat field", "super_admin", "quota", `{"member_seats":1,"wallet_cents":100,"quantity":1}`, "invalid_arguments", "请求格式无效", 0, 0},
		{"retired product field", "super_admin", "quota", `{"product":"wallet_credits","wallet_cents":100,"quantity":1}`, "invalid_arguments", "请求格式无效", 0, 0},
		{"wallet amount", "super_admin", "quota", `{"wallet_cents":99,"quantity":1}`, "invalid_arguments", "钱包额度需在 ¥1-¥10000 之间", 0, 0},
		{"list filter", "super_admin", "list", `{"code":"POD-PLAN-SHOULD-NOT-QUERY"}`, "invalid_arguments", "请求格式无效", 0, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			spy := &billSpy{body: []byte(`{"data":{"codes":[{"code":"` + plain + `"}]}}`)}
			admin := codeAdmin{billing: spy, now: func() time.Time { return now }}
			caller := mcpdomain.Caller{UserID: 9, OrgID: 3, PlatformRole: tc.role, TokenHash: "hash"}
			var (
				raw json.RawMessage
				err error
			)
			switch tc.kind {
			case "quota":
				raw, err = admin.CreateQuota(context.Background(), caller, json.RawMessage(tc.body))
			default:
				raw, err = admin.ListCodes(context.Background(), caller, json.RawMessage(tc.body))
			}
			if spy.created != tc.wantCreate || spy.listed != tc.wantList {
				t.Fatalf("create %d list %d", spy.created, spy.listed)
			}
			if tc.wantMsg == "" {
				if err != nil || !bytes.Contains(raw, []byte(plain)) && tc.kind != "list" {
					t.Fatalf("%v %s", err, raw)
				}
				if tc.kind == "list" && (bytes.Contains(raw, []byte("POD-")) || !bytes.Contains(raw, []byte("••••-"))) {
					t.Fatalf("list %s", raw)
				}
				if tc.kind != "list" {
					want, fault := admindomain.ParseRedeemBody([]byte(tc.body), now)
					if fault != nil || !reflect.DeepEqual(spy.spec, want) {
						t.Fatalf("spec %+v\nwant %+v\nfault %v", spy.spec, want, fault)
					}
				}
				return
			}
			var coded *mcpsvc.CodeError
			if !errors.As(err, &coded) || coded.Code != tc.wantCode || coded.Message != tc.wantMsg {
				t.Fatalf("%v", err)
			}
			if strings.Contains(coded.Message, "POD-") {
				t.Fatal(coded.Message)
			}
		})
	}
}

func TestMCPHTTPSessionGate(t *testing.T) {
	const secret = "session-secret-token"
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })

	spy := &billSpy{body: []byte(`{"data":{"codes":[{"code":"POD-PLAN-PLAINTEXT"}]}}`)}
	svc := mcpsvc.New(grantStore{grant: sampleGrant()}).WithCodes(codeAdmin{billing: spy, now: func() time.Time {
		return time.Date(2030, 1, 2, 3, 4, 5, 0, time.UTC)
	}})
	r := chi.NewRouter()
	sessionCalls := 0
	mcphttp.Mount(r, mcphttp.Deps{
		Handler: svc,
		Session: func(req *http.Request) (*mcpdomain.Caller, error) {
			sessionCalls++
			if req.Header.Get("Authorization") == "Bearer "+secret {
				return nil, errors.New(secret)
			}
			if req.Header.Get("Authorization") == "Bearer super" {
				return &mcpdomain.Caller{UserID: 9, PlatformRole: "super_admin", TokenHash: "hash"}, nil
			}
			return nil, nil
		},
	})

	noToken := postMCP(r, "", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"generateQuotaCards","arguments":{}}}`)
	if noToken.Code != http.StatusUnauthorized || noToken.Body.String() != `{"error":"invalid or expired automation grant token"}` || sessionCalls != 1 {
		t.Fatalf("no token %d %s calls %d", noToken.Code, noToken.Body.String(), sessionCalls)
	}
	bad := postMCP(r, secret, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"generateQuotaCards","arguments":{}}}`)
	if bad.Code != http.StatusUnauthorized || strings.Contains(buf.String(), secret) || spy.created != 0 {
		t.Fatalf("bad %d log %q created %d", bad.Code, buf.String(), spy.created)
	}
	before := sessionCalls
	grant := postMCP(r, "opa_secret", `{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}`)
	if grant.Code != http.StatusOK || !strings.Contains(grant.Body.String(), `"search"`) || strings.Contains(grant.Body.String(), secret) || sessionCalls != before {
		t.Fatalf("grant %d calls %d %s", grant.Code, sessionCalls, grant.Body.String())
	}
	again := postMCP(r, "opa_secret", `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"generateQuotaCards","arguments":{"quantity":1,"wallet_cents":100}}}`)
	if sessionCalls != before || spy.created != 0 || !strings.Contains(again.Body.String(), "管理操作需要超级管理员会话") {
		t.Fatalf("calls %d created %d %s", sessionCalls, spy.created, again.Body.String())
	}
	ok := postMCP(r, "super", `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"generateQuotaCards","arguments":{"wallet_cents":100,"quantity":1,"expires_at":"2030-06-01T00:00:00Z"}}}`)
	if ok.Code != http.StatusOK || spy.created != 1 || !strings.Contains(ok.Body.String(), "POD-PLAN-PLAINTEXT") || strings.Contains(buf.String(), "POD-PLAN-PLAINTEXT") {
		t.Fatalf("ok %d created %d log %q body %s", ok.Code, spy.created, buf.String(), ok.Body.String())
	}
}

func postMCP(h http.Handler, token, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(body))
	req.Host = "localhost"
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

type billSpy struct {
	spec    admindomain.RedeemSpec
	created int
	listed  int
	body    []byte
}

func (s *billSpy) PublicID(context.Context, int64) (string, error) { return "pub", nil }
func (s *billSpy) ListPlans(context.Context, admindomain.Actor) ([]byte, error) {
	return []byte(`{}`), nil
}
func (s *billSpy) ListOrders(context.Context, admindomain.Actor) ([]byte, error) {
	return []byte(`{}`), nil
}
func (s *billSpy) GetOrder(context.Context, admindomain.Actor, string) ([]byte, error) {
	return nil, nil
}
func (s *billSpy) ConfirmOrder(context.Context, admindomain.Actor, string) ([]byte, error) {
	return nil, nil
}
func (s *billSpy) CancelOrder(context.Context, admindomain.Actor, string) ([]byte, error) {
	return nil, nil
}
func (s *billSpy) ListRedeem(context.Context, admindomain.Actor) ([]byte, error) {
	s.listed++
	return []byte(`{"data":{"codes":[{"code_preview":"••••-TEXT"}]}}`), nil
}
func (s *billSpy) CreateRedeem(_ context.Context, _ admindomain.Actor, spec admindomain.RedeemSpec) ([]byte, error) {
	s.created++
	s.spec = spec
	return s.body, nil
}
func (s *billSpy) GetRedeem(context.Context, admindomain.Actor, int64) ([]byte, error) {
	return nil, nil
}
func (s *billSpy) DeleteRedeem(context.Context, admindomain.Actor, int64) ([]byte, error) {
	return nil, nil
}
func (s *billSpy) RevokeRedeem(context.Context, admindomain.Actor, int64) ([]byte, error) {
	return nil, nil
}
func (s *billSpy) ListCoupons(context.Context, admindomain.Actor) ([]byte, error) {
	panic("unexpected ListCoupons")
}
func (s *billSpy) CreateCoupon(context.Context, admindomain.Actor, billing.CouponSpec) ([]byte, error) {
	panic("unexpected CreateCoupon")
}
func (s *billSpy) SetCouponEnabled(context.Context, admindomain.Actor, string, bool) ([]byte, error) {
	panic("unexpected SetCouponEnabled")
}
func (s *billSpy) GetPayment(context.Context, admindomain.Actor) ([]byte, error) { return nil, nil }
func (s *billSpy) PutPayment(context.Context, admindomain.Actor, admindomain.PaymentReplace) ([]byte, error) {
	return nil, nil
}
func (s *billSpy) Wallet(context.Context, admindomain.Actor, string) ([]byte, error) {
	return nil, nil
}
func (s *billSpy) GrantTopup(context.Context, admindomain.Actor, admindomain.TopupGrant) ([]byte, error) {
	return nil, nil
}
func (s *billSpy) RevokeTopup(context.Context, admindomain.Actor, string, string) ([]byte, error) {
	return nil, nil
}
func (s *billSpy) Scopes(context.Context, admindomain.Actor, admindomain.Scope) ([]byte, error) {
	return nil, nil
}
func (s *billSpy) Snapshot(context.Context, admindomain.Actor, admindomain.Scope) ([]byte, error) {
	return nil, nil
}
func (s *billSpy) Overview(context.Context, admindomain.Actor, admindomain.Scope) ([]byte, error) {
	return nil, nil
}
func (s *billSpy) Products(context.Context, admindomain.Actor, admindomain.ProductQuery) ([]byte, error) {
	return nil, nil
}
func (s *billSpy) Thumbnail(context.Context, admindomain.Actor, admindomain.Thumbnail) (admindomain.ImageBytes, error) {
	return admindomain.ImageBytes{}, nil
}
func (s *billSpy) ListErrors(context.Context, admindomain.Actor, admindomain.ErrorFilter) ([]byte, error) {
	return nil, nil
}
func (s *billSpy) DeleteErrors(context.Context, admindomain.Actor, admindomain.ErrorDelete) ([]byte, error) {
	return nil, nil
}
func (s *billSpy) ListDigest(context.Context, admindomain.Actor) ([]byte, error) {
	return nil, nil
}

type grantStore struct{ grant mcpdomain.Grant }

func (f grantStore) Resolve(context.Context, string) (*mcpdomain.Grant, error) {
	g := f.grant
	return &g, nil
}
func (grantStore) Begin(context.Context, mcpdomain.Grant, string, string, string) (mcpdomain.Start, error) {
	return mcpdomain.Start{}, mcpdomain.NewHost("internal", "Service is temporarily unavailable")
}
func (grantStore) Finish(context.Context, mcpdomain.Grant, mcpdomain.Claim, string, *mcpdomain.HostError, int) (mcpdomain.Envelope, error) {
	return mcpdomain.Envelope{}, mcpdomain.NewHost("internal", "Service is temporarily unavailable")
}
func (grantStore) WorkspaceName(context.Context, mcpdomain.Grant, mcpdomain.Claim) (string, error) {
	return "", mcpdomain.NewHost("internal", "Service is temporarily unavailable")
}
func (grantStore) ExecutionView(context.Context, mcpdomain.Grant, mcpdomain.Claim, string) (mcpdomain.Envelope, error) {
	return mcpdomain.Envelope{}, mcpdomain.NewHost("internal", "Service is temporarily unavailable")
}

func sampleGrant() mcpdomain.Grant {
	return mcpdomain.Grant{
		ID: "11111111-1111-4111-8111-111111111111", UserID: 7, OrgID: 3,
		ScopeKind: "workspace", Actions: []string{"read"}, WorkspaceRole: "owner", PlatformRole: "super_admin",
	}
}
