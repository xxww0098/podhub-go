package adminhttp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
	delegatec "github.com/xxww0098/podhub-go/internal/delegate/contract"
)

func x2Resolve(p *Session, ref *Refusal, err error) Resolve {
	return func(*http.Request) (*Session, *Refusal, error) {
		return p, ref, err
	}
}

type x2Standing struct {
	standing domain.Standing
	publicID string
	err      error
}

func (s x2Standing) Standing(context.Context, int64, string) (domain.Standing, error) {
	return s.standing, s.err
}
func (s x2Standing) PublicID(context.Context, int64) (string, error) { return s.publicID, s.err }
func (s x2Standing) ListPlans(context.Context, domain.Actor) ([]byte, error) {
	return nil, nil
}
func (s x2Standing) ListOrders(context.Context, domain.Actor) ([]byte, error) { return nil, nil }
func (s x2Standing) GetOrder(context.Context, domain.Actor, string) ([]byte, error) {
	return nil, nil
}
func (s x2Standing) ConfirmOrder(context.Context, domain.Actor, string) ([]byte, error) {
	return nil, nil
}
func (s x2Standing) CancelOrder(context.Context, domain.Actor, string) ([]byte, error) {
	return nil, nil
}
func (s x2Standing) ListRedeem(context.Context, domain.Actor) ([]byte, error) { return nil, nil }
func (s x2Standing) CreateRedeem(context.Context, domain.Actor, domain.RedeemSpec) ([]byte, error) {
	return nil, nil
}
func (s x2Standing) GetRedeem(context.Context, domain.Actor, int64) ([]byte, error) {
	return nil, nil
}
func (s x2Standing) DeleteRedeem(context.Context, domain.Actor, int64) ([]byte, error) {
	return nil, nil
}
func (s x2Standing) RevokeRedeem(context.Context, domain.Actor, int64) ([]byte, error) {
	return nil, nil
}
func (s x2Standing) GetPayment(context.Context, domain.Actor) ([]byte, error) { return nil, nil }
func (s x2Standing) PutPayment(context.Context, domain.Actor, domain.PaymentReplace) ([]byte, error) {
	return nil, nil
}
func (s x2Standing) Wallet(context.Context, domain.Actor, string) ([]byte, error) { return nil, nil }
func (s x2Standing) GrantTopup(context.Context, domain.Actor, domain.TopupGrant) ([]byte, error) {
	return nil, nil
}
func (s x2Standing) RevokeTopup(context.Context, domain.Actor, string, string) ([]byte, error) {
	return nil, nil
}
func (s x2Standing) Scopes(context.Context, domain.Actor, domain.Scope) ([]byte, error) {
	return nil, nil
}
func (s x2Standing) Snapshot(context.Context, domain.Actor, domain.Scope) ([]byte, error) {
	return nil, nil
}
func (s x2Standing) Overview(context.Context, domain.Actor, domain.Scope) ([]byte, error) {
	return nil, nil
}
func (s x2Standing) Products(context.Context, domain.Actor, domain.ProductQuery) ([]byte, error) {
	return nil, nil
}
func (s x2Standing) Thumbnail(context.Context, domain.Actor, domain.Thumbnail) (domain.ImageBytes, error) {
	return domain.ImageBytes{}, nil
}
func (s x2Standing) ListErrors(context.Context, domain.Actor, domain.ErrorFilter) ([]byte, error) {
	return nil, nil
}
func (s x2Standing) DeleteErrors(context.Context, domain.Actor, domain.ErrorDelete) ([]byte, error) {
	return nil, nil
}
func (s x2Standing) ListDigest(context.Context, domain.Actor) ([]byte, error) {
	return []byte(`{"data":{"digests":[]}}`), nil
}

type delegateFake struct {
	body json.RawMessage
	err  error
	got  string
}

func (f *delegateFake) Dispatch(_ context.Context, _ int64, orderID string, body []byte, _ int64) (json.RawMessage, error) {
	f.got = "dispatch " + orderID + " " + string(body)
	return f.body, f.err
}
func (f *delegateFake) Receipt(_ context.Context, _ int64, orderID string, body []byte, _ int64) (json.RawMessage, error) {
	f.got = "receipt " + orderID + " " + string(body)
	return f.body, f.err
}
func (f *delegateFake) Cancel(_ context.Context, _ int64, orderID string, _ int64) (json.RawMessage, error) {
	f.got = "cancel " + orderID
	return f.body, f.err
}

func x2Router(p *Session, d DelegateWrites, s ShippingWrites, standing domain.Standing) http.Handler {
	r := chi.NewRouter()
	Mount(r, Deps{
		Resolve:        x2Resolve(p, nil, nil),
		DelegateWrites: d,
		ShippingWrites: s,
		AdminB:         x2Standing{standing: standing, publicID: "pub_1"},
	})
	return r
}

func x2Call(h http.Handler, method, path, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	h.ServeHTTP(rec, req)
	return rec
}

func TestDelegateAdminBytes(t *testing.T) {
	okBody := []byte(`{"data":{"order":{"state":"dispatched"}}}`)
	staff := &Session{UserID: 7, OrgID: 1, PlatformRole: "admin"}
	order := "/api/admin/delegate-orders/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
	h := x2Router(staff, &delegateFake{body: okBody}, nil, domain.Standing{})

	rec := x2Call(h, http.MethodPost, order+"/dispatch", `{}`)
	if rec.Code != 200 || rec.Body.String() != string(okBody) || rec.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("dispatch %d %s", rec.Code, rec.Body.String())
	}
	rec = x2Call(h, http.MethodPost, order+"/receipt", `{"trackingNo":"TN"}`)
	if rec.Code != 200 || rec.Body.String() != string(okBody) {
		t.Fatalf("receipt %d %s", rec.Code, rec.Body.String())
	}
	rec = x2Call(h, http.MethodPost, order+"/cancel", ``)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"state":"dispatched"`) {
		t.Fatalf("cancel %d %s", rec.Code, rec.Body.String())
	}

	cases := []struct {
		name   string
		sess   Resolve
		path   string
		body   string
		status int
		want   string
		err    error
	}{
		{"anon", nil, order + "/dispatch", `{}`, 401, `{"error":"未登录","code":"auth_invalid"}`, nil},
		{"user", x2Resolve(&Session{UserID: 1, PlatformRole: "user"}, nil, nil), order + "/cancel", ``, 403, `{"error":"需要平台管理员权限","code":"forbidden"}`, nil},
		{"auth500", x2Resolve(nil, nil, context.Canceled), order + "/dispatch", `{}`, 500, `{"error":"服务暂不可用","code":"internal"}`, nil},
		{"other", x2Resolve(nil, &Refusal{Status: 409, Message: "nope"}, nil), order + "/dispatch", `{}`, 500, `{"error":"服务暂不可用","code":"internal"}`, nil},
		{"json", x2Resolve(staff, nil, nil), order + "/dispatch", `{`, 400, `{"error":"请求格式无效","code":"validation"}`, delegatec.Validation("请求格式无效")},
		{"missing", x2Resolve(staff, nil, nil), "/api/admin/delegate-orders/nope/dispatch", `{}`, 404, `{"error":"委托单不存在","code":"not_found"}`, delegatec.NotFound("委托单不存在")},
		{"conflict", x2Resolve(staff, nil, nil), order + "/cancel", ``, 409, `{"error":"委托单已是终态","code":"conflict"}`, delegatec.Conflict("委托单已是终态")},
		{"lines", x2Resolve(staff, nil, nil), order + "/dispatch", `{}`, 422, `{"error":"这张单没有可派发的行（未绑定、缺已核验原图或已在途）","code":"validation"}`, delegatec.Unprocessable("这张单没有可派发的行（未绑定、缺已核验原图或已在途）")},
		{"gate", x2Resolve(staff, nil, nil), order + "/receipt", `{}`, 503, `{"error":"委托订单写入未启用","code":"writes_disabled"}`, delegatec.WritesDisabled()},
		{"lock", x2Resolve(staff, nil, nil), order + "/dispatch", `{}`, 503, `{"error":"资源正在更新，请稍后重试","code":"internal"}`, delegatec.Locked()},
		{"media", x2Resolve(staff, nil, nil), order + "/dispatch", `{}`, 409, `{"error":"媒体对象已进入回收，请重新上传","code":"internal"}`, delegatec.MediaGone()},
	}
	for _, c := range cases {
		fake := &delegateFake{err: c.err}
		r := chi.NewRouter()
		Mount(r, Deps{Resolve: c.sess, DelegateWrites: fake})
		rec := x2Call(r, http.MethodPost, c.path, c.body)
		if rec.Code != c.status || rec.Body.String() != c.want {
			t.Fatalf("%s %d %s", c.name, rec.Code, rec.Body.String())
		}
		if c.name == "lock" && rec.Header().Get("Retry-After") != "1" {
			t.Fatal("retry")
		}
	}

	big := strings.Repeat("a", x2BodyLimit+1)
	rec = x2Call(h, http.MethodPost, order+"/dispatch", big)
	if rec.Code != 400 || rec.Body.String() != `{"error":"请求格式无效","code":"validation"}` {
		t.Fatalf("oversize %d %s", rec.Code, rec.Body.String())
	}
	rec = x2Call(x2Router(staff, nil, nil, domain.Standing{}), http.MethodPost, order+"/cancel", ``)
	if rec.Code != 501 || rec.Body.String() != `{"error":"not_ported","code":"not_ported"}` {
		t.Fatalf("nil %d %s", rec.Code, rec.Body.String())
	}
	rec = x2Call(x2Router(staff, &delegateFake{}, nil, domain.Standing{}), http.MethodGet, "/api/admin/delegate-orders", ``)
	if rec.Code != 501 || rec.Body.String() != `{"error":"not_ported","code":"not_ported"}` {
		t.Fatalf("list stays 501 %d %s", rec.Code, rec.Body.String())
	}
}
