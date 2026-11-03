package integration

import (
	"bytes"
	"crypto"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/xxww0098/podhub-go/internal/app"
	domain "github.com/xxww0098/podhub-go/internal/billing/domain"
	billinghttp "github.com/xxww0098/podhub-go/internal/billing/http"
	"github.com/xxww0098/podhub-go/internal/identity"
	"github.com/xxww0098/podhub-go/internal/platform/config"
	"github.com/xxww0098/podhub-go/tests/testkit"
)

const paymentRuntimeTestKey = "qa-payment-runtime-master-key-32-bytes-minimum"

type paymentHTTPTransport struct {
	target *url.URL
	base   http.RoundTripper
}

func (t paymentHTTPTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	copy := r.Clone(r.Context())
	u := *r.URL
	copy.URL = &u
	copy.URL.Scheme = t.target.Scheme
	copy.URL.Host = t.target.Host
	copy.Host = r.URL.Host
	return t.base.RoundTrip(copy)
}

type paymentPeer struct {
	mu                 sync.Mutex
	server             *httptest.Server
	merchant, platform *rsa.PrivateKey
	amounts            map[string]int64
	creates            map[string]int
	queryPaid          map[string]bool
	uncertain          bool
}

func newPaymentPeer(t *testing.T) *paymentPeer {
	t.Helper()
	m, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	p, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	f := &paymentPeer{merchant: m, platform: p, amounts: map[string]int64{}, creates: map[string]int{}, queryPaid: map[string]bool{}}
	f.server = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.server.Close)
	return f
}

func peerRSA(key *rsa.PrivateKey, message []byte) string {
	sum := sha256.Sum256(message)
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sum[:])
	if err != nil {
		panic(err)
	}
	return base64.StdEncoding.EncodeToString(sig)
}
func peerVerify(pub *rsa.PublicKey, message []byte, encoded string) bool {
	sig, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return false
	}
	sum := sha256.Sum256(message)
	return rsa.VerifyPKCS1v15(pub, crypto.SHA256, sum[:], sig) == nil
}
func peerCanonical(v url.Values) string {
	keys := []string{}
	for k := range v {
		if k != "sign" && v.Get(k) != "" {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	out := []string{}
	for _, k := range keys {
		out = append(out, k+"="+v.Get(k))
	}
	return strings.Join(out, "&")
}

func (p *paymentPeer) serve(w http.ResponseWriter, r *http.Request) {
	p.mu.Lock()
	defer p.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	raw, _ := io.ReadAll(r.Body)
	switch {
	case r.URL.Path == "/gateway.do":
		v, _ := url.ParseQuery(string(raw))
		if !peerVerify(&p.merchant.PublicKey, []byte(peerCanonical(v)), v.Get("sign")) {
			http.Error(w, "bad merchant signature", 401)
			return
		}
		var biz struct {
			Out    string `json:"out_trade_no"`
			Amount string `json:"total_amount"`
		}
		_ = json.Unmarshal([]byte(v.Get("biz_content")), &biz)
		response := map[string]any{"code": "10000", "out_trade_no": biz.Out}
		switch v.Get("method") {
		case "alipay.trade.precreate":
			p.creates[biz.Out]++
			p.amounts[biz.Out], _ = domain.PaymentCents(biz.Amount)
			if p.uncertain {
				http.Error(w, "uncertain after accepted", 502)
				return
			}
			response["qr_code"] = p.server.URL + "/checkout/" + biz.Out
		case "alipay.trade.query":
			response["trade_no"] = "trade-" + biz.Out
			response["total_amount"] = fmt.Sprintf("%d.%02d", p.amounts[biz.Out]/100, p.amounts[biz.Out]%100)
			response["trade_status"] = "WAIT_BUYER_PAY"
			if p.queryPaid[biz.Out] {
				response["trade_status"] = "TRADE_SUCCESS"
			}
		case "alipay.trade.close":
		default:
			http.Error(w, "unknown method", 400)
			return
		}
		body, _ := json.Marshal(response)
		envelope := map[string]any{strings.ReplaceAll(v.Get("method"), ".", "_") + "_response": json.RawMessage(body), "sign": peerRSA(p.platform, body)}
		_ = json.NewEncoder(w).Encode(envelope)
	case strings.HasPrefix(r.URL.Path, "/v3/pay/transactions/"):
		auth := map[string]string{}
		parts := strings.Split(strings.TrimPrefix(r.Header.Get("Authorization"), "WECHATPAY2-SHA256-RSA2048 "), ",")
		for _, part := range parts {
			k, v, _ := strings.Cut(part, "=")
			auth[k] = strings.Trim(v, `"`)
		}
		if auth["mchid"] != "qa-merchant" || !peerVerify(&p.merchant.PublicKey, []byte(r.Method+"\n"+r.URL.RequestURI()+"\n"+auth["timestamp"]+"\n"+auth["nonce_str"]+"\n"+string(raw)+"\n"), auth["signature"]) {
			http.Error(w, "bad native request", 401)
			return
		}
		var body []byte
		if r.URL.Path == "/v3/pay/transactions/native" {
			var in struct {
				Out    string `json:"out_trade_no"`
				App    string `json:"appid"`
				Amount struct {
					Total    int64  `json:"total"`
					Currency string `json:"currency"`
				} `json:"amount"`
			}
			_ = json.Unmarshal(raw, &in)
			if in.App != "qa-app" || in.Amount.Currency != "CNY" {
				http.Error(w, "invalid native amount", 400)
				return
			}
			p.creates[in.Out]++
			p.amounts[in.Out] = in.Amount.Total
			body, _ = json.Marshal(map[string]string{"code_url": "weixin://qa-local/" + in.Out})
		} else if strings.HasSuffix(r.URL.Path, "/close") {
			body = []byte{}
		} else {
			id := strings.TrimPrefix(r.URL.Path, "/v3/pay/transactions/out-trade-no/")
			state := "NOTPAY"
			transactionID := ""
			if p.queryPaid[id] {
				state = "SUCCESS"
				transactionID = "wx-" + id
			}
			body, _ = json.Marshal(map[string]any{"appid": "qa-app", "mchid": "qa-merchant", "out_trade_no": id, "transaction_id": transactionID, "trade_state": state, "amount": map[string]any{"total": p.amounts[id], "currency": "CNY"}})
		}
		ts := strconv.FormatInt(time.Now().Unix(), 10)
		w.Header().Set("Wechatpay-Serial", "QA_PUBLIC_KEY")
		w.Header().Set("Wechatpay-Timestamp", ts)
		w.Header().Set("Wechatpay-Nonce", "qa-response")
		w.Header().Set("Wechatpay-Signature", peerRSA(p.platform, []byte(ts+"\nqa-response\n"+string(body)+"\n")))
		if len(body) == 0 {
			w.WriteHeader(204)
		} else {
			_, _ = w.Write(body)
		}
	case strings.HasPrefix(r.URL.Path, "/v1/checkout/sessions"):
		if r.Header.Get("Authorization") != "Bearer sk_test_qa_local" {
			http.Error(w, "bad stripe credential", 401)
			return
		}
		if r.URL.Path == "/v1/checkout/sessions" {
			v, _ := url.ParseQuery(string(raw))
			id := v.Get("client_reference_id")
			if v.Get("metadata[order_id]") != id || r.Header.Get("Idempotency-Key") != id || v.Get("line_items[0][price_data][currency]") != "cny" {
				http.Error(w, "bad checkout request", 400)
				return
			}
			p.amounts[id], _ = strconv.ParseInt(v.Get("line_items[0][price_data][unit_amount]"), 10, 64)
			p.creates[id]++
			_ = json.NewEncoder(w).Encode(map[string]string{"id": "cs_" + id, "url": p.server.URL + "/checkout/" + id})
		} else {
			id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/v1/checkout/sessions/cs_"), "/expire")
			status, payment := "open", "unpaid"
			if p.queryPaid[id] {
				status, payment = "complete", "paid"
			}
			if strings.HasSuffix(r.URL.Path, "/expire") {
				status = "expired"
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "cs_" + id, "status": status, "payment_status": payment, "amount_total": p.amounts[id], "currency": "cny", "metadata": map[string]string{"order_id": id}})
		}
	case r.URL.Path == "/api/v1/authentication/login":
		if r.Header.Get("x-client-id") != "qa-air-client" || r.Header.Get("x-api-key") != "qa-air-api-key" {
			http.Error(w, "bad auth", 401)
			return
		}
		_, _ = w.Write([]byte(`{"token":"qa-local-access-token"}`))
	case strings.HasPrefix(r.URL.Path, "/api/v1/pa/payment_links/"):
		if r.Header.Get("Authorization") != "Bearer qa-local-access-token" {
			http.Error(w, "bad bearer", 401)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/create") {
			var in struct {
				Reference string            `json:"reference"`
				Amount    json.Number       `json:"amount"`
				Currency  string            `json:"currency"`
				Reusable  bool              `json:"reusable"`
				Metadata  map[string]string `json:"metadata"`
			}
			_ = json.Unmarshal(raw, &in)
			if in.Reusable || in.Currency != "CNY" || in.Metadata["order_id"] != in.Reference {
				http.Error(w, "bad payment link", 400)
				return
			}
			p.amounts[in.Reference], _ = domain.PaymentCents(string(in.Amount))
			p.creates[in.Reference]++
			_ = json.NewEncoder(w).Encode(map[string]string{"id": "link_" + in.Reference, "reference": in.Reference, "url": p.server.URL + "/checkout/" + in.Reference})
		} else {
			id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/v1/pa/payment_links/link_"), "/deactivate")
			status := "UNPAID"
			if p.queryPaid[id] {
				status = "PAID"
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "link_" + id, "reference": id, "amount": json.Number(fmt.Sprintf("%d.%02d", p.amounts[id]/100, p.amounts[id]%100)), "currency": "CNY", "status": status})
		}
	case r.URL.Path == "/submit.php":
		fields := map[string]string{}
		for k := range r.URL.Query() {
			fields[k] = r.URL.Query().Get(k)
		}
		if !strings.EqualFold(fields["sign"], domain.EasyPayMD5(fields, "qa-easy-key")) || fields["pid"] != "qa-pid" {
			http.Error(w, "bad easypay signature", 401)
			return
		}
		p.creates[fields["out_trade_no"]]++
		_, _ = w.Write([]byte(`{"checkout":"ready"}`))
	default:
		http.NotFound(w, r)
	}
}

func (p *paymentPeer) values(provider string) map[string]string {
	private := string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(p.merchant)}))
	der, _ := x509.MarshalPKIXPublicKey(&p.platform.PublicKey)
	public := string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	switch provider {
	case "alipay":
		return map[string]string{"appId": "qa-app", "privateKey": private, "alipayPublicKey": public, "notifyUrl": p.server.URL + "/api/billing/callback", "gateway": p.server.URL + "/gateway.do"}
	case "wechat":
		return map[string]string{"appId": "qa-app", "mchId": "qa-merchant", "privateKey": private, "apiV3Key": "01234567890123456789012345678901", "certSerial": "QA_MERCHANT_KEY", "publicKey": public, "publicKeyId": "QA_PUBLIC_KEY", "notifyUrl": p.server.URL + "/notify"}
	case "stripe":
		return map[string]string{"secretKey": "sk_test_qa_local", "publishableKey": "pk_test_qa_local", "webhookSecret": "whsec_qa_runtime", "currency": "cny", "returnUrl": p.server.URL + "/return"}
	case "airwallex":
		return map[string]string{"clientId": "qa-air-client", "apiKey": "qa-air-api-key", "webhookSecret": "qa-air-webhook", "apiBase": "https://api.sandbox.airwallex.com/api/v1", "currency": "CNY", "countryCode": "CN"}
	default:
		return map[string]string{"pid": "qa-pid", "pkey": "qa-easy-key", "apiBase": p.server.URL, "notifyUrl": p.server.URL + "/notify", "returnUrl": p.server.URL + "/return"}
	}
}

func TestPaymentRuntimeProductionRole(t *testing.T) {
	t.Setenv("CLOUD_INTEGRATION_CONFIG_KEY", paymentRuntimeTestKey)
	f := newAdminContentFixture(t)
	seedMatchingLease(t, f.ctx, f.fixture, "billing", "payment runtime")
	peer := newPaymentPeer(t)
	target, _ := url.Parse(peer.server.URL)
	client := &http.Client{Timeout: time.Second, Transport: paymentHTTPTransport{target, http.DefaultTransport}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	runtime := app.NewPaymentRuntime(f.runtime, config.Config{IntegrationConfigKey: paymentRuntimeTestKey}, client)
	auth := identity.New(f.runtime)
	router := chi.NewRouter()
	router.Use(auth.Middleware)
	billinghttp.Register(router, billinghttp.Deps{Billing: billingHTTPPort(), Pool: f.runtime, Access: auth, Runtime: runtime})
	live := f
	live.server = httptest.NewServer(router)
	t.Cleanup(live.server.Close)
	spec, err := testkit.LoadOpenAPI()
	if err != nil {
		t.Fatal(err)
	}
	call := func(t *testing.T, method, path, body, token string, want int) []byte {
		t.Helper()
		status, raw := live.call(t, method, path, body, token)
		if status != want {
			t.Fatalf("%s %s got=%d want=%d body=%s", method, path, status, want, raw)
		}
		pattern := strings.Split(path, "?")[0]
		if strings.HasPrefix(path, "/api/billing/orders/") {
			pattern = "/api/billing/orders/{public_id}"
		}
		if strings.HasPrefix(path, "/api/ai/recharge/orders/") {
			pattern = "/api/ai/recharge/orders/{public_id}/recover"
		} else if strings.HasPrefix(path, "/api/orders/") {
			pattern = "/api/orders/{public_id}"
			if strings.HasSuffix(path, "/recover") {
				pattern += "/recover"
			}
			if strings.HasSuffix(path, "/cancel") {
				pattern += "/cancel"
			}
		}
		if err := spec.CheckResponse(method, pattern, status, http.Header{"Content-Type": {"application/json"}}, raw); err != nil {
			t.Fatalf("%s contract: %v body=%s", path, err, raw)
		}
		return raw
	}
	var org int64
	var workspace string
	if err := f.fixture.QueryRow(f.ctx, `SELECT id,uuid::text FROM organizations WHERE owner_user_id=96312`).Scan(&org, &workspace); err != nil {
		t.Fatal(err)
	}
	revision := 0
	save := func(t *testing.T, provider string, enabled bool, values map[string]string) {
		t.Helper()
		body, _ := json.Marshal(map[string]any{"expectedRevision": revision, "providers": []map[string]any{{"provider": provider, "enabled": enabled, "values": values}}})
		f.want(t, "PUT", "/api/admin/payment/config", string(body), f.admin, 200)
		revision++
	}
	call(t, "GET", "/api/payment-methods", "", f.user, 200)
	call(t, "GET", "/api/payment-methods", "", "", 401)
	for _, method := range []string{"alipay", "wechat", "stripe", "airwallex", "easypay_alipay", "easypay_wechat"} {
		t.Run(method, func(t *testing.T) {
			provider := method
			if strings.HasPrefix(method, "easypay_") {
				provider = "easypay"
			}
			save(t, provider, true, peer.values(provider))
			if raw := f.want(t, "GET", "/api/payment-methods", "", f.user, 200); !bytes.Contains(raw, []byte(method)) {
				t.Fatal("app default payment runtime not wired")
			}
			raw := call(t, "GET", "/api/payment-methods", "", f.user, 200)
			if !strings.Contains(string(raw), `"`+method+`"`) {
				t.Fatal("saved enabled provider not live")
			}
			body, _ := json.Marshal(map[string]any{"operation_id": "qa-20261027-" + method, "amount_cents": 123, "provider": method, "expected_workspace_uuid": workspace})
			raw = call(t, "POST", "/api/ai/recharge/orders", string(body), f.user, 200)
			var response struct {
				Order struct {
					ID    string `json:"public_id"`
					Entry string `json:"entry_state"`
					URL   string `json:"pay_url"`
					QR    string `json:"qr_code"`
				}
			}
			if json.Unmarshal(raw, &response) != nil || response.Order.ID == "" || response.Order.Entry != "ready" {
				t.Fatalf("entry not ready: %s", raw)
			}
			id := response.Order.ID
			if strings.HasPrefix(method, "easypay_") {
				req, _ := http.NewRequest("GET", response.Order.URL, nil)
				resp, err := peer.server.Client().Do(req)
				if err != nil || resp.StatusCode != 200 {
					t.Fatal("signed submit link refused")
				}
				_ = resp.Body.Close()
			}
			replay := call(t, "POST", "/api/ai/recharge/orders", string(body), f.user, 200)
			if !bytes.Contains(replay, []byte(id)) {
				t.Fatal("operation id created second order")
			}
			call(t, "POST", "/api/ai/recharge/orders", strings.Replace(string(body), `123`, `124`, 1), f.user, 409)
			call(t, "GET", "/api/orders/"+id, "", f.admin, 404)
			call(t, "POST", "/api/ai/recharge/orders/"+id+"/recover", "", f.user, 200)
			if provider == "airwallex" || provider == "easypay" {
				call(t, "POST", "/api/orders/"+id+"/cancel", "", f.user, 409)
			}
			payload, headers := peer.notice(provider, id, 123)
			send := func(b []byte, h http.Header) int {
				req, _ := http.NewRequest("POST", f.server.URL+"/api/billing/webhooks/"+provider, bytes.NewReader(b))
				req.Header = h
				resp, err := live.server.Client().Do(req)
				if err != nil {
					t.Fatal(err)
				}
				defer resp.Body.Close()
				return resp.StatusCode
			}
			if got := send(append(append([]byte{}, payload...), byte('x')), headers.Clone()); got != 400 {
				t.Fatalf("tampered status=%d", got)
			}
			for range 2 {
				if got := send(payload, headers.Clone()); got != 200 {
					t.Fatalf("signed callback status=%d", got)
				}
			}
			var paid string
			var rows, amount int64
			if err := f.fixture.QueryRow(f.ctx, `SELECT p.status,(SELECT count(*) FROM wallet_ledger l WHERE l.payment_order_id=p.id),COALESCE((SELECT sum(amount_microfen) FROM wallet_ledger l WHERE l.payment_order_id=p.id),0) FROM payment_orders p WHERE public_id=$1`, id).Scan(&paid, &rows, &amount); err != nil {
				t.Fatal(err)
			}
			if paid != "paid" || rows != 1 || amount != 123000000 {
				t.Fatalf("not exactly once paid=%s rows=%d amount=%d", paid, rows, amount)
			}
			peer.mu.Lock()
			n := peer.creates[id]
			peer.mu.Unlock()
			if n != 1 {
				t.Fatalf("provider creates=%d want1", n)
			}
			save(t, provider, false, peer.values(provider))
			raw = call(t, "GET", "/api/payment-methods", "", f.user, 200)
			if strings.Contains(string(raw), `"`+method+`"`) {
				t.Fatal("disabled provider remained live")
			}
			if got := send(payload, headers.Clone()); got != 503 {
				t.Fatalf("disabled callback status=%d", got)
			}
			f.assertClean(t)
		})
	}
	t.Run("unknown create is never repeated", func(t *testing.T) {
		save(t, "alipay", true, peer.values("alipay"))
		peer.mu.Lock()
		peer.uncertain = true
		peer.mu.Unlock()
		body, _ := json.Marshal(map[string]any{"operation_id": "qa-20261027-uncertain", "amount_cents": 123, "provider": "alipay", "expected_workspace_uuid": workspace})
		call(t, "POST", "/api/ai/recharge/orders", string(body), f.user, 200)
		var id string
		if err := f.fixture.QueryRow(f.ctx, `SELECT public_id FROM payment_orders WHERE org_id=$1 AND operation_id='qa-20261027-uncertain'`, org).Scan(&id); err != nil {
			t.Fatal(err)
		}
		for range 2 {
			raw := call(t, "POST", "/api/ai/recharge/orders", string(body), f.user, 200)
			if !bytes.Contains(raw, []byte(`"entry_state":"entry_confirming"`)) {
				t.Fatal("uncertainty lost")
			}
		}
		call(t, "POST", "/api/ai/recharge/orders/"+id+"/recover", "", f.user, 200)
		peer.mu.Lock()
		n := peer.creates[id]
		peer.mu.Unlock()
		if n != 1 {
			t.Fatalf("unknown create retried %d times", n)
		}
		payload, headers := peer.notice("alipay", id, 123)
		if got := paymentNotify(t, f.server, "alipay", payload, headers); got != 200 {
			t.Fatalf("uncertain accepted order callback=%d", got)
		}
		peer.mu.Lock()
		peer.uncertain = false
		peer.mu.Unlock()
	})
	t.Run("pending secret rotation is immediately effective", func(t *testing.T) {
		values := peer.values("easypay")
		save(t, "easypay", true, values)
		body, _ := json.Marshal(map[string]any{"operation_id": "qa-20261027-key-rotation", "amount_cents": 123, "provider": "easypay_alipay", "expected_workspace_uuid": workspace})
		raw := call(t, "POST", "/api/ai/recharge/orders", string(body), f.user, 200)
		var result struct {
			Order struct {
				ID string `json:"public_id"`
			}
		}
		if json.Unmarshal(raw, &result) != nil || result.Order.ID == "" {
			t.Fatal("missing rotation order")
		}
		id := result.Order.ID
		payload, headers := peer.notice("easypay", id, 123)
		values["pkey"] = "qa-rotated-easy-key"
		save(t, "easypay", true, values)
		if got := paymentNotify(t, f.server, "easypay", payload, headers.Clone()); got != 400 {
			t.Fatalf("old key accepted after save: %d", got)
		}
		v, _ := url.ParseQuery(string(payload))
		fields := map[string]string{}
		for k := range v {
			fields[k] = v.Get(k)
		}
		v.Set("sign", domain.EasyPayMD5(fields, values["pkey"]))
		if got := paymentNotify(t, f.server, "easypay", []byte(v.Encode()), headers.Clone()); got != 200 {
			t.Fatalf("rotated key not live: %d", got)
		}
		f.assertClean(t)
	})
	t.Run("subscription uses selected channel and fulfills once", func(t *testing.T) {
		save(t, "alipay", true, peer.values("alipay"))
		seedMatchingLease(t, f.ctx, f.fixture, "entitlement", "payment runtime subscription")
		if _, err := f.fixture.Exec(f.ctx, `INSERT INTO subscriptions(org_id,status,plan_key,updated_at) VALUES($1,'free','free',clock_timestamp())`, org); err != nil {
			t.Fatal(err)
		}
		raw := call(t, "POST", "/api/billing/quotes", fmt.Sprintf(`{"expected_workspace_uuid":%q,"action":"subscribe","target":{"plan_key":"lite","stores":5}}`, workspace), f.user, 200)
		var quote struct {
			ID     string `json:"quote_id"`
			Amount int64  `json:"amount_cents"`
		}
		if json.Unmarshal(raw, &quote) != nil || quote.ID == "" || quote.Amount <= 0 {
			t.Fatal("missing subscription quote")
		}
		raw = call(t, "POST", "/api/billing/orders", fmt.Sprintf(`{"quote_id":%q,"accepted_version":"subscription-2026-10-31","provider":"alipay"}`, quote.ID), f.user, 201)
		var created struct {
			ID       string `json:"public_id"`
			Provider string `json:"provider"`
			Entry    string `json:"entry_state"`
			QR       string `json:"qr_code"`
		}
		if json.Unmarshal(raw, &created) != nil || created.ID == "" || created.Provider != "alipay" || created.Entry != "ready" || created.QR == "" {
			t.Fatalf("subscription entry=%s", raw)
		}
		call(t, "GET", "/api/billing/orders/"+created.ID, "", f.user, 200)
		call(t, "GET", "/api/orders/"+created.ID, "", f.user, 200)
		call(t, "POST", "/api/orders/"+created.ID+"/recover", "", f.user, 200)
		payload, headers := peer.notice("alipay", created.ID, quote.Amount)
		for range 2 {
			if got := paymentNotify(t, f.server, "alipay", payload, headers.Clone()); got != 200 {
				t.Fatalf("subscription callback status=%d", got)
			}
		}
		var periods int
		if err := f.fixture.QueryRow(f.ctx, `SELECT count(*) FROM subscription_periods WHERE order_id=(SELECT id FROM payment_orders WHERE public_id=$1)`, created.ID).Scan(&periods); err != nil || periods != 1 {
			t.Fatalf("periods=%d err=%v", periods, err)
		}
		raw = call(t, "GET", "/api/billing/orders/"+created.ID, "", f.user, 200)
		if !bytes.Contains(raw, []byte(`"status":"paid"`)) || bytes.Contains(raw, []byte(`"qr_code"`)) {
			t.Fatal("paid subscription retains entry")
		}
		f.assertClean(t)
	})
	t.Run("cancel and expiry remove entries without credit", func(t *testing.T) {
		save(t, "stripe", true, peer.values("stripe"))
		for _, action := range []string{"cancel", "expiry"} {
			body, _ := json.Marshal(map[string]any{"operation_id": "qa-20261027-" + action, "amount_cents": 123, "provider": "stripe", "expected_workspace_uuid": workspace})
			raw := call(t, "POST", "/api/ai/recharge/orders", string(body), f.user, 200)
			var result struct {
				Order struct {
					ID string `json:"public_id"`
				}
			}
			if json.Unmarshal(raw, &result) != nil || result.Order.ID == "" {
				t.Fatal("missing cancellation order")
			}
			id := result.Order.ID
			if action == "cancel" {
				call(t, "POST", "/api/orders/"+id+"/cancel", "", f.user, 200)
				call(t, "POST", "/api/orders/"+id+"/cancel", "", f.user, 409)
			} else {
				payload, _ := peer.notice("stripe", id, 123)
				payload = bytes.ReplaceAll(payload, []byte("checkout.session.completed"), []byte("checkout.session.expired"))
				payload = bytes.ReplaceAll(payload, []byte(`"payment_status":"paid"`), []byte(`"payment_status":"unpaid"`))
				ts := strconv.FormatInt(time.Now().Unix(), 10)
				mac := hmac.New(sha256.New, []byte("whsec_qa_runtime"))
				_, _ = mac.Write(append([]byte(ts+"."), payload...))
				headers := http.Header{"Stripe-Signature": {"t=" + ts + ",v1=" + hex.EncodeToString(mac.Sum(nil))}}
				for range 2 {
					if got := paymentNotify(t, f.server, "stripe", payload, headers.Clone()); got != 200 {
						t.Fatalf("expired callback status=%d", got)
					}
				}
			}
			var state string
			var entries, ledger int
			if err := f.fixture.QueryRow(f.ctx, `SELECT status,(CASE WHEN qr_code IS NULL AND pay_url IS NULL AND launch_state IS NULL THEN 0 ELSE 1 END),(SELECT count(*) FROM wallet_ledger l WHERE l.payment_order_id=p.id) FROM payment_orders p WHERE public_id=$1`, id).Scan(&state, &entries, &ledger); err != nil || state != "canceled" || entries != 0 || ledger != 0 {
				t.Fatalf("cancel state=%s entries=%d ledger=%d err=%v", state, entries, ledger, err)
			}
			// Signed paid facts can arrive after cancellation; they still credit once.
			payload, headers := peer.notice("stripe", id, 123)
			for range 2 {
				if got := paymentNotify(t, f.server, "stripe", payload, headers.Clone()); got != 200 {
					t.Fatalf("late payment callback status=%d", got)
				}
			}
			var reason string
			if err := f.fixture.QueryRow(f.ctx, `SELECT status,COALESCE(reconciliation_reason,''),(SELECT count(*) FROM wallet_ledger l WHERE l.payment_order_id=p.id) FROM payment_orders p WHERE public_id=$1`, id).Scan(&state, &reason, &ledger); err != nil || state != "paid" || reason != "fulfilled_after_cancel" || ledger != 1 {
				t.Fatalf("late payment state=%s reason=%s ledger=%d err=%v", state, reason, ledger, err)
			}
		}
		f.assertClean(t)
	})
	t.Run("order list pagination is scoped", func(t *testing.T) {
		raw := call(t, "GET", "/api/orders?limit=2", "", f.user, 200)
		var page struct {
			Orders []json.RawMessage `json:"orders"`
			Cursor string            `json:"next_cursor"`
		}
		if json.Unmarshal(raw, &page) != nil || len(page.Orders) != 2 || page.Cursor == "" {
			t.Fatal("missing order pagination")
		}
		call(t, "GET", "/api/orders?limit=2&cursor="+url.QueryEscape(page.Cursor), "", f.user, 200)
		call(t, "GET", "/api/orders?limit=0", "", f.user, 400)
		call(t, "GET", "/api/orders?cursor=invalid", "", f.user, 400)
		f.assertClean(t)
	})
}

func paymentNotify(t *testing.T, server *httptest.Server, provider string, body []byte, headers http.Header) int {
	t.Helper()
	req, err := http.NewRequest("POST", server.URL+"/api/billing/webhooks/"+provider, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header = headers
	response, err := server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	return response.StatusCode
}

func (p *paymentPeer) notice(provider, id string, amount int64) ([]byte, http.Header) {
	h := http.Header{}
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	money := fmt.Sprintf("%d.%02d", amount/100, amount%100)
	switch provider {
	case "alipay":
		v := url.Values{"app_id": {"qa-app"}, "out_trade_no": {id}, "trade_no": {"ali-" + id}, "trade_status": {"TRADE_SUCCESS"}, "total_amount": {money}, "sign_type": {"RSA2"}}
		fields := map[string]string{}
		for k := range v {
			fields[k] = v.Get(k)
		}
		v.Set("sign", peerRSA(p.platform, []byte(domain.CanonicalAlipay(fields))))
		h.Set("Content-Type", "application/x-www-form-urlencoded")
		return []byte(v.Encode()), h
	case "easypay":
		v := url.Values{"pid": {"qa-pid"}, "out_trade_no": {id}, "trade_no": {"easy-" + id}, "trade_status": {"TRADE_SUCCESS"}, "money": {money}}
		fields := map[string]string{}
		for k := range v {
			fields[k] = v.Get(k)
		}
		v.Set("sign", domain.EasyPayMD5(fields, "qa-easy-key"))
		h.Set("Content-Type", "application/x-www-form-urlencoded")
		return []byte(v.Encode()), h
	case "stripe":
		body, _ := json.Marshal(map[string]any{"type": "checkout.session.completed", "data": map[string]any{"object": map[string]any{"id": "cs_" + id, "amount_total": amount, "currency": "cny", "payment_status": "paid", "metadata": map[string]string{"order_id": id}}}})
		mac := hmac.New(sha256.New, []byte("whsec_qa_runtime"))
		_, _ = mac.Write(append([]byte(ts+"."), body...))
		h.Set("Stripe-Signature", "t="+ts+",v1="+hex.EncodeToString(mac.Sum(nil)))
		return body, h
	case "airwallex":
		body, _ := json.Marshal(map[string]any{"name": "payment_link.paid", "data": map[string]any{"object": map[string]any{"id": "link_" + id, "reference": id, "amount": json.Number(money), "currency": "CNY", "status": "PAID"}}})
		stamp := strconv.FormatInt(time.Now().UnixMilli(), 10)
		mac := hmac.New(sha256.New, []byte("qa-air-webhook"))
		_, _ = mac.Write(append([]byte(stamp), body...))
		h.Set("x-timestamp", stamp)
		h.Set("x-signature", hex.EncodeToString(mac.Sum(nil)))
		return body, h
	case "wechat":
		plain, _ := json.Marshal(map[string]any{"appid": "qa-app", "mchid": "qa-merchant", "out_trade_no": id, "transaction_id": "wx-" + id, "trade_state": "SUCCESS", "amount": map[string]any{"total": amount, "currency": "CNY"}})
		block, _ := aes.NewCipher([]byte("01234567890123456789012345678901"))
		gcm, _ := cipher.NewGCM(block)
		nonce := "qa-local-012"
		sealed := gcm.Seal(nil, []byte(nonce), plain, []byte("transaction"))
		body, _ := json.Marshal(map[string]any{"resource": map[string]string{"nonce": nonce, "associated_data": "transaction", "ciphertext": base64.StdEncoding.EncodeToString(sealed)}})
		h.Set("Wechatpay-Timestamp", ts)
		h.Set("Wechatpay-Nonce", "qa-notify")
		h.Set("Wechatpay-Serial", "QA_PUBLIC_KEY")
		h.Set("Wechatpay-Signature", peerRSA(p.platform, []byte(ts+"\nqa-notify\n"+string(body)+"\n")))
		return body, h
	}
	panic("unknown fixture provider")
}
