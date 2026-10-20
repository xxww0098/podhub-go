package adminhttp

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/podhub-go/internal/admin/domain"
)

type fakeAPI struct {
	standing domain.Standing
	err      error
	calls    int
	redeemID int64
}

func (f *fakeAPI) Standing(context.Context, int64, string) (domain.Standing, error) {
	return f.standing, f.err
}
func (f *fakeAPI) PublicID(context.Context, int64) (string, error) { return "pub", nil }
func (f *fakeAPI) ListPlans(context.Context, domain.Actor) ([]byte, error) {
	f.calls++
	return []byte(`{"data":{"plans":[]}}`), nil
}
func (f *fakeAPI) ListOrders(context.Context, domain.Actor) ([]byte, error) {
	return []byte(`{"data":{"orders":[]}}`), nil
}
func (f *fakeAPI) GetOrder(context.Context, domain.Actor, string) ([]byte, error) {
	return nil, domain.NotFound("NOT_FOUND", "订单不存在")
}
func (f *fakeAPI) ConfirmOrder(context.Context, domain.Actor, string) ([]byte, error) {
	return nil, nil
}
func (f *fakeAPI) CancelOrder(context.Context, domain.Actor, string) ([]byte, error) {
	return nil, nil
}
func (f *fakeAPI) ListRedeem(context.Context, domain.Actor) ([]byte, error) { return []byte(`{}`), nil }
func (f *fakeAPI) CreateRedeem(context.Context, domain.Actor, domain.RedeemSpec) ([]byte, error) {
	return nil, nil
}
func (f *fakeAPI) GetRedeem(_ context.Context, _ domain.Actor, id int64) ([]byte, error) {
	f.redeemID = id
	return nil, domain.NotFound("NOT_FOUND", "兑换码不存在")
}
func (f *fakeAPI) DeleteRedeem(context.Context, domain.Actor, int64) ([]byte, error) {
	return nil, nil
}
func (f *fakeAPI) RevokeRedeem(context.Context, domain.Actor, int64) ([]byte, error) {
	return nil, nil
}
func (f *fakeAPI) GetPayment(context.Context, domain.Actor) ([]byte, error) { return []byte(`{}`), nil }
func (f *fakeAPI) PutPayment(context.Context, domain.Actor, domain.PaymentReplace) ([]byte, error) {
	return nil, nil
}
func (f *fakeAPI) Wallet(context.Context, domain.Actor, string) ([]byte, error) {
	return []byte(`{}`), nil
}
func (f *fakeAPI) GrantTopup(context.Context, domain.Actor, domain.TopupGrant) ([]byte, error) {
	return nil, nil
}
func (f *fakeAPI) RevokeTopup(context.Context, domain.Actor, string, string) ([]byte, error) {
	return nil, nil
}
func (f *fakeAPI) Scopes(context.Context, domain.Actor, domain.Scope) ([]byte, error) {
	f.calls++
	return []byte(`{"data":{"workspaces":[],"stores":[]}}`), nil
}
func (f *fakeAPI) Snapshot(context.Context, domain.Actor, domain.Scope) ([]byte, error) {
	return []byte(`{}`), nil
}
func (f *fakeAPI) Overview(context.Context, domain.Actor, domain.Scope) ([]byte, error) {
	return []byte(`{}`), nil
}
func (f *fakeAPI) Products(context.Context, domain.Actor, domain.ProductQuery) ([]byte, error) {
	return []byte(`{}`), nil
}
func (f *fakeAPI) Thumbnail(context.Context, domain.Actor, domain.Thumbnail) (domain.ImageBytes, error) {
	return domain.ImageBytes{}, nil
}
func (f *fakeAPI) ListErrors(context.Context, domain.Actor, domain.ErrorFilter) ([]byte, error) {
	return []byte(`{}`), nil
}
func (f *fakeAPI) DeleteErrors(context.Context, domain.Actor, domain.ErrorDelete) ([]byte, error) {
	return nil, nil
}
func (f *fakeAPI) ListDigest(context.Context, domain.Actor) ([]byte, error) {
	return []byte(`{"data":{"digests":[]}}`), nil
}

func mountFake(api *fakeAPI, role string) http.Handler {
	r := chi.NewRouter()
	Mount(r, Deps{
		AdminB: api,
		Resolve: func(*http.Request) (*Session, *Refusal, error) {
			if role == "" {
				return nil, nil, nil
			}
			return &Session{UserID: 7, OrgID: 1, PlatformRole: role}, nil, nil
		},
	})
	return r
}

func hit(handler http.Handler, method, path, auth string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, nil)
	if auth != "" {
		req.Header.Set("Authorization", "Bearer "+auth)
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func TestAdminBAuthFamilies(t *testing.T) {
	api := &fakeAPI{standing: domain.Standing{Enrolled: true, Elevated: true}}
	cases := []struct {
		name, method, path, role string
		want                     int
		body                     string
	}{
		{"anon plans", http.MethodGet, "/api/admin/plans", "", 401, `"code":"AUTH_INVALID"`},
		{"staff plans", http.MethodGet, "/api/admin/plans", "user", 403, "需要超级管理员权限"},
		{"anon wallet", http.MethodGet, "/api/admin/workspaces/11111111-1111-4111-8111-111111111111/wallet", "", 401, `"code":"AUTH_REQUIRED"`},
		{"anon ops", http.MethodGet, "/api/admin/ops/scopes", "", 401, `"code":"auth_required"`},
		{"anon logs", http.MethodGet, "/api/admin/error-logs", "", 401, `"code":"AUTH_REQUIRED"`},
		{"super plans", http.MethodGet, "/api/admin/plans", "super_admin", 200, `"plans"`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := hit(mountFake(api, tc.role), tc.method, tc.path, "token", nil)
			if rec.Code != tc.want || !strings.Contains(rec.Body.String(), tc.body) {
				t.Fatalf("%d %s", rec.Code, rec.Body.String())
			}
		})
	}
}

func TestAdminBStepUp(t *testing.T) {
	handler := func(standing domain.Standing) http.Handler {
		return mountFake(&fakeAPI{standing: standing}, "super_admin")
	}
	missing := hit(handler(domain.Standing{Missing: true}), http.MethodGet, "/api/admin/plans", "token", nil)
	if missing.Code != 500 || !strings.Contains(missing.Body.String(), "服务暂不可用") {
		t.Fatal(missing.Code, missing.Body.String())
	}
	enroll := hit(handler(domain.Standing{}), http.MethodGet, "/api/admin/plans", "token", nil)
	if enroll.Code != 403 || !strings.Contains(enroll.Body.String(), "请先绑定验证器") {
		t.Fatal(enroll.Code, enroll.Body.String())
	}
	step := hit(handler(domain.Standing{Enrolled: true}), http.MethodGet, "/api/admin/plans", "token", nil)
	if step.Code != 403 || !strings.Contains(step.Body.String(), "管理操作需要重新验证") {
		t.Fatal(step.Code, step.Body.String())
	}
}

func TestAdminBCSRFAndValidation(t *testing.T) {
	api := &fakeAPI{standing: domain.Standing{Enrolled: true, Elevated: true}}
	handler := mountFake(api, "super_admin")
	req := httptest.NewRequest(http.MethodPost, "/api/admin/redeem-codes", strings.NewReader(`{}`))
	req.Header.Set("Cookie", "sid=abc")
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	req.Header.Set("Authorization", "Bearer token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != 403 || !strings.Contains(rec.Body.String(), `"code":"csrf_rejected"`) || !strings.HasPrefix(rec.Body.String(), `{"code":`) {
		t.Fatal(rec.Code, rec.Body.String())
	}
	bad := httptest.NewRequest(http.MethodPost, "/api/admin/redeem-codes", strings.NewReader(`{"extra":1}`))
	bad.Header.Set("Authorization", "Bearer token")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, bad)
	if rec.Code != 400 || !strings.Contains(rec.Body.String(), "请求格式无效") {
		t.Fatal(rec.Code, rec.Body.String())
	}
	logs := hit(handler, http.MethodGet, "/api/admin/error-logs?page=0", "token", nil)
	if logs.Code != 400 || !strings.Contains(logs.Body.String(), "page 必须是正整数") {
		t.Fatal(logs.Code, logs.Body.String())
	}
	ops := hit(handler, http.MethodGet, "/api/admin/ops/scopes?nope=1", "token", nil)
	if ops.Code != 400 || !strings.Contains(ops.Body.String(), `"code":"validation"`) {
		t.Fatal(ops.Code, ops.Body.String())
	}
}
