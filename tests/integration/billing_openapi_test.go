package integration

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	billingdomain "github.com/xxww0098/podhub-go/internal/billing/domain"
	billinghttp "github.com/xxww0098/podhub-go/internal/billing/http"
	access "github.com/xxww0098/podhub-go/internal/identity/contract"
	"github.com/xxww0098/podhub-go/tests/testkit"
)

// TestBillingResponsesMatchOpenAPI drives every billinghttp.Register route and
// checks status, media type, and JSON body against api/openapi.yaml.
func TestBillingResponsesMatchOpenAPI(t *testing.T) {
	spec, err := testkit.LoadOpenAPI()
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	pool := migratedPool(t, ctx)
	if err := purgeAIFixtures(ctx, pool); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM redeem_codes WHERE code = 'WALLET96043'`)
		if err := purgeAIFixtures(context.Background(), pool); err != nil {
			t.Errorf("purge ai fixtures: %v", err)
		}
	})
	seedMatchingLease(t, ctx, pool, "billing", "billing openapi test")
	org, user := seedAITenant(t, ctx, pool, 96043)
	easyOrg, easyUser := seedAITenant(t, ctx, pool, 96044)
	if _, err := pool.Exec(ctx, `
		INSERT INTO payment_orders
		    (public_id, org_id, plan, months, amount_cents, currency, provider, status,
		     created_by_user_id, created_at, updated_at, product, topup_microfen)
		VALUES ('po_spec_96043', $1, 'lite', 1, 100, 'CNY', 'alipay', 'pending',
		        $2, clock_timestamp(), clock_timestamp(), 'wallet_topup', 100000000),
		       ('po_spec_easy_96043', $3, 'lite', 1, 100, 'CNY', 'easypay', 'pending',
		        $4, clock_timestamp(), clock_timestamp(), 'wallet_topup', 100000000)`, org, user, easyOrg, easyUser); err != nil {
		t.Fatal(err)
	}
	var workspace string
	if err := pool.QueryRow(ctx, `SELECT uuid::text FROM organizations WHERE id = $1`, org).Scan(&workspace); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO redeem_codes
		    (code, plan, duration_days, used, created_at, updated_at, product, member_seats, ocr_credits, wallet_cents, tier)
		VALUES ('WALLET96043', 'pro', 30, false, clock_timestamp(), clock_timestamp(),
		        'wallet_credits', 0, 0, 100, NULL)`); err != nil {
		t.Fatal(err)
	}

	key, err := rsaKey()
	if err != nil {
		t.Fatal(err)
	}
	const stripeSecret = "whsec_spec"
	router := func(p *access.Principal, payments billinghttp.Payments) http.Handler {
		r := chi.NewRouter()
		billinghttp.Register(r, billinghttp.Deps{Pool: pool, Access: access.FixedResolver{Principal: p}, Payments: payments})
		return r
	}
	paid := router(nil, billinghttp.Payments{
		Alipay:     &billinghttp.AlipayKey{AppID: "2021000000000000", Public: &key.PublicKey},
		Stripe:     &billinghttp.StripeKey{Secret: stripeSecret},
		EasyPayPID: "1000", EasyPayKey: "secret",
	})
	closed := router(nil, billinghttp.Payments{})
	owner := router(&access.Principal{UserID: user, OrgID: org, WorkspaceRole: "owner"}, billinghttp.Payments{})
	admin := router(&access.Principal{UserID: user, OrgID: org, WorkspaceRole: "admin"}, billinghttp.Payments{})
	viewer := router(&access.Principal{UserID: user, OrgID: org, WorkspaceRole: "viewer"}, billinghttp.Payments{})
	anonymous := router(nil, billinghttp.Payments{})

	easy := map[string]string{
		"pid": "1000", "money": "1.00", "out_trade_no": "po_spec_easy_96043",
		"trade_no": "spec-trade", "trade_status": "TRADE_SUCCESS",
	}
	easy["sign"] = billingdomain.EasyPayMD5(easy, "secret")
	easyQuery := url.Values{}
	for k, v := range easy {
		easyQuery.Set(k, v)
	}
	stripeBody := `{"type":"customer.created","data":{"object":{}}}`
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	mac := hmac.New(sha256.New, []byte(stripeSecret))
	mac.Write([]byte(ts + "." + stripeBody))
	stripeSig := "t=" + ts + ",v1=" + hex.EncodeToString(mac.Sum(nil))

	type call struct {
		name    string
		handler http.Handler
		method  string
		path    string
		spec    string
		ctype   string
		header  map[string]string
		body    string
		status  int
		want    string
	}
	for _, c := range []call{
		{name: "alipay paid", handler: paid, method: "POST", path: "/api/billing/callback", ctype: "application/x-www-form-urlencoded", body: string(signedAlipay(t, key, "po_spec_96043", "1.00")), status: 200, want: "success"},
		{name: "alipay bad sign", handler: paid, method: "POST", path: "/api/billing/callback", ctype: "application/x-www-form-urlencoded", body: "out_trade_no=po_spec_96043&sign=bm8", status: 400},
		{name: "alipay closed", handler: closed, method: "POST", path: "/api/billing/callback", ctype: "application/x-www-form-urlencoded", body: "a=b", status: 503},
		{name: "webhook unknown provider", handler: paid, method: "POST", path: "/api/billing/webhooks/nope", spec: "/api/billing/webhooks/{provider}", body: "{}", status: 404},
		{name: "webhook stripe ignored", handler: paid, method: "POST", path: "/api/billing/webhooks/stripe", spec: "/api/billing/webhooks/{provider}", ctype: "application/json", header: map[string]string{"Stripe-Signature": stripeSig}, body: stripeBody, status: 200, want: ""},
		{name: "webhook stripe bad sign", handler: paid, method: "POST", path: "/api/billing/webhooks/stripe", spec: "/api/billing/webhooks/{provider}", ctype: "application/json", header: map[string]string{"Stripe-Signature": "t=1,v1=00"}, body: stripeBody, status: 400},
		{name: "webhook wechat closed", handler: paid, method: "POST", path: "/api/billing/webhooks/wechat", spec: "/api/billing/webhooks/{provider}", ctype: "application/json", body: "{}", status: 503},
		{name: "webhook easypay get", handler: paid, method: "GET", path: "/api/billing/webhooks/easypay?" + easyQuery.Encode(), spec: "/api/billing/webhooks/{provider}", status: 200, want: "success"},
		{name: "webhook get other provider", handler: paid, method: "GET", path: "/api/billing/webhooks/stripe", spec: "/api/billing/webhooks/{provider}", status: 405},
		{name: "webhook easypay get closed", handler: closed, method: "GET", path: "/api/billing/webhooks/easypay?a=b", spec: "/api/billing/webhooks/{provider}", status: 503},
		{name: "complete succeeded", handler: anonymous, method: "GET", path: "/api/billing/callback/complete?payment_id=po_1&status=succeeded", spec: "/api/billing/callback/complete", status: 200},
		{name: "complete bare", handler: anonymous, method: "GET", path: "/api/billing/callback/complete", status: 200},
		{name: "redeem", handler: owner, method: "POST", path: "/api/redeem", ctype: "application/json", body: fmt.Sprintf(`{"code":"wallet96043","expected_workspace_uuid":%q}`, workspace), status: 200},
		{name: "redeem used", handler: owner, method: "POST", path: "/api/redeem", ctype: "application/json", body: fmt.Sprintf(`{"code":"wallet96043","expected_workspace_uuid":%q}`, workspace), status: 400},
		{name: "redeem bad body", handler: owner, method: "POST", path: "/api/redeem", ctype: "application/json", body: `{"x":1}`, status: 400},
		{name: "redeem other workspace", handler: owner, method: "POST", path: "/api/redeem", ctype: "application/json", body: `{"code":"wallet96043","expected_workspace_uuid":"00000000-0000-0000-0000-000000000000"}`, status: 409},
		{name: "redeem admin not owner", handler: admin, method: "POST", path: "/api/redeem", ctype: "application/json", body: `{"code":"x"}`, status: 403},
		{name: "redeem viewer", handler: viewer, method: "POST", path: "/api/redeem", ctype: "application/json", body: `{"code":"x"}`, status: 403},
		{name: "redeem signed out", handler: anonymous, method: "POST", path: "/api/redeem", ctype: "application/json", body: `{"code":"x"}`, status: 401},
	} {
		t.Run(c.name, func(t *testing.T) {
			req := httptest.NewRequest(c.method, c.path, strings.NewReader(c.body))
			if c.ctype != "" {
				req.Header.Set("Content-Type", c.ctype)
			}
			for k, v := range c.header {
				req.Header.Set(k, v)
			}
			rec := httptest.NewRecorder()
			c.handler.ServeHTTP(rec, req)
			if rec.Code != c.status {
				t.Fatalf("status %d want %d body %s", rec.Code, c.status, rec.Body.Bytes())
			}
			if c.status == 200 && c.want != "" && rec.Body.String() != c.want {
				t.Fatalf("body %q want %q", rec.Body.String(), c.want)
			}
			path := c.spec
			if path == "" {
				path = c.path
			}
			if err := spec.CheckResponse(c.method, path, rec.Code, rec.Header(), rec.Body.Bytes()); err != nil {
				t.Fatalf("%v\n%s", err, rec.Body.Bytes())
			}
		})
	}
}
