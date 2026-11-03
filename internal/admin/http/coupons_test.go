package adminhttp

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCouponAdminValidation(t *testing.T) {
	api := &fakeAPI{}
	handler := mountFake(api, "super_admin")
	valid := `{"code":"team10","discount_percent":10,"starts_at":"2098-01-01T00:00:00Z","expires_at":"2099-01-01T00:00:00Z","max_uses":5}`
	for _, body := range []string{
		strings.Replace(valid, `"team10"`, `"x"`, 1),
		strings.Replace(valid, `"team10"`, `"bad code"`, 1),
		strings.Replace(valid, `:10,`, `:100,`, 1),
		strings.Replace(valid, `:10,`, `:1.5,`, 1),
		strings.Replace(valid, `"starts_at":"2098-01-01T00:00:00Z",`, ``, 1),
		strings.Replace(valid, `2098-01-01`, `2099-01-01`, 1),
		strings.Replace(valid, `2098-01-01`, `2100-01-01`, 1),
		strings.Replace(valid, `2098-01-01T00:00:00Z`, `invalid`, 1),
		strings.Replace(valid, `2099-01-01`, `2020-01-01`, 1),
		strings.Replace(valid, `:5}`, `:-1}`, 1),
		strings.Replace(valid, `:5}`, `:1000001}`, 1),
		strings.Replace(valid, `:5}`, `:1.5}`, 1),
		strings.Replace(valid, `:5}`, `:null}`, 1),
		strings.Replace(valid, `,"max_uses":5`, ``, 1),
		strings.Replace(valid, `:5}`, `:5,"used_count":0}`, 1),
		valid + `{}`,
	} {
		req := httptest.NewRequest(http.MethodPost, "/api/admin/subscription-coupons", strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer token")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: %d %s", body, rec.Code, rec.Body.String())
		}
	}
	if api.calls != 0 {
		t.Fatal("invalid coupon reached persistence")
	}
	for i, body := range []string{valid, strings.Replace(valid, `:5}`, `:0}`, 1)} {
		req := httptest.NewRequest(http.MethodPost, "/api/admin/subscription-coupons", strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer token")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusCreated || api.calls != i+1 {
			t.Fatal(rec.Code, rec.Body.String(), api.calls)
		}
	}
	for _, role := range []string{"", "user", "admin"} {
		res := hit(mountFake(api, role), http.MethodGet, "/api/admin/subscription-coupons", "token", nil)
		if res.Code != http.StatusUnauthorized && res.Code != http.StatusForbidden {
			t.Fatalf("%q can list coupons: %d", role, res.Code)
		}
	}
}
