package aihttp

import (
	"context"
	"errors"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	billing "github.com/xxww0098/podhub-go/internal/billing/contract"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
)

func TestImageCapabilityNeverPurchases(t *testing.T) {
	member := access.FixedResolver{Principal: &access.Principal{UserID: 1, OrgID: 2, WorkspaceRole: "member"}}
	for _, tc := range []struct {
		name    string
		access  access.Resolver
		runtime *ImageRuntime
		status  int
		body    string
	}{
		{"anonymous", nil, nil, 401, ""},
		{"missing runtime", member, nil, 200, `{"available":false}`},
		{"missing discovery", member, &ImageRuntime{}, 200, `{"available":false}`},
		{"invalid configuration", member, &ImageRuntime{Account: func(context.Context) (string, error) { return "", errors.New("private configuration") }}, 200, `{"available":false}`},
		{"price database unavailable", member, &ImageRuntime{Account: func(context.Context) (string, error) { return "image-account", nil }}, 500, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if tc.runtime != nil {
				tc.runtime.Resolve = func(context.Context, string, string) (ImageGenerator, ImageAssets, error) {
					t.Fatal("capability must not resolve or call a paid model")
					return nil, nil, nil
				}
			}
			r := chi.NewRouter()
			Register(r, HTTPDeps{Deps: Deps{Images: tc.runtime}, Access: tc.access})
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/ai/image-sets/capability", nil))
			if rec.Code != tc.status || (tc.body != "" && rec.Body.String() != tc.body) {
				t.Fatalf("%d %s", rec.Code, rec.Body.String())
			}
		})
	}
}

func TestImageUnitPriceBounds(t *testing.T) {
	valid := billing.Price{BillingMode: billing.ModePerRequest, PerRequest: 25_000_000, MaxRequest: 25_000_000}
	if unit, err := imageUnitPrice(valid); err != nil || unit != 25_000_000 || 3*unit != 75_000_000 {
		t.Fatalf("unit=%d err=%v", unit, err)
	}
	for _, price := range []billing.Price{
		{},
		{BillingMode: billing.ModeToken, PerRequest: 1, MaxRequest: 1},
		{BillingMode: billing.ModePerRequest, PerRequest: 0, MaxRequest: 1},
		{BillingMode: billing.ModePerRequest, PerRequest: -1, MaxRequest: 1},
		{BillingMode: billing.ModePerRequest, PerRequest: 2, MaxRequest: 1},
		{BillingMode: billing.ModePerRequest, PerRequest: math.MaxInt64/3 + 1, MaxRequest: math.MaxInt64},
	} {
		if _, err := imageUnitPrice(price); err == nil {
			t.Fatalf("invalid price accepted: %+v", price)
		}
	}
}

func TestImageLookupRequiresMemberAndOriginalKey(t *testing.T) {
	for _, tc := range []struct {
		principal *access.Principal
		key       string
		status    int
	}{
		{nil, "original", 401},
		{&access.Principal{UserID: 1, OrgID: 2, WorkspaceRole: "member"}, "", 400},
		{&access.Principal{UserID: 1, OrgID: 2, WorkspaceRole: "member"}, "original", 500},
	} {
		r := chi.NewRouter()
		Register(r, HTTPDeps{Access: access.FixedResolver{Principal: tc.principal}})
		req := httptest.NewRequest(http.MethodGet, "/api/ai/image-sets", nil)
		req.Header.Set("Idempotency-Key", tc.key)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		if rec.Code != tc.status {
			t.Fatalf("status %d want %d", rec.Code, tc.status)
		}
	}
}
