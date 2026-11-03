package billingrepo

import (
	"bytes"
	"context"
	"crypto"
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
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/xxww0098/podhub-go/internal/billing/contract"
	"github.com/xxww0098/podhub-go/internal/billing/domain"
)

type PaymentGateway struct{ Client *http.Client }

func paymentFailure() error {
	return &domain.QuoteError{Status: 503, Code: "PAYMENT_NOT_AVAILABLE", Message: "支付渠道暂不可用；订单已保留，请查询支付结果后重试"}
}

func privateKey(raw string) (*rsa.PrivateKey, error) {
	raw = strings.ReplaceAll(raw, `\n`, "\n")
	block, _ := pem.Decode([]byte(raw))
	var der []byte
	if block != nil {
		der = block.Bytes
	} else {
		var err error
		der, err = base64.StdEncoding.DecodeString(strings.TrimSpace(raw))
		if err != nil {
			return nil, err
		}
	}
	if key, err := x509.ParsePKCS1PrivateKey(der); err == nil {
		return key, nil
	}
	key, err := x509.ParsePKCS8PrivateKey(der)
	if err != nil {
		return nil, err
	}
	out, ok := key.(*rsa.PrivateKey)
	if !ok {
		return nil, contract.ErrPaymentClosed
	}
	return out, nil
}

func (s PaymentGateway) Validate(c contract.PaymentConfiguration) error {
	var fields []string
	switch c.Provider {
	case "easypay":
		fields = []string{"pid", "pkey", "apiBase", "notifyUrl", "returnUrl"}
	case "alipay":
		fields = []string{"appId", "privateKey", "alipayPublicKey", "notifyUrl", "gateway"}
	case "wechat":
		fields = []string{"appId", "mchId", "privateKey", "apiV3Key", "certSerial", "publicKey", "publicKeyId", "notifyUrl"}
	case "stripe":
		fields = []string{"secretKey", "publishableKey", "webhookSecret", "currency", "returnUrl"}
	case "airwallex":
		fields = []string{"clientId", "apiKey", "webhookSecret", "apiBase", "currency", "countryCode"}
	default:
		return contract.ErrPaymentClosed
	}
	for _, name := range fields {
		if strings.TrimSpace(c.Values[name]) == "" {
			return contract.ErrPaymentClosed
		}
	}
	if c.Provider == "alipay" || c.Provider == "wechat" {
		if _, err := privateKey(c.Values["privateKey"]); err != nil {
			return contract.ErrPaymentClosed
		}
		name := "publicKey"
		if c.Provider == "alipay" {
			name = "alipayPublicKey"
		}
		if _, err := domain.ParsePublicPEM(c.Values[name]); err != nil {
			return contract.ErrPaymentClosed
		}
	}
	if c.Provider == "wechat" && len(c.Values["apiV3Key"]) != 32 {
		return contract.ErrPaymentClosed
	}
	// Prices and wallet credit are denominated in CNY; no implicit FX conversion.
	if (c.Provider == "stripe" || c.Provider == "airwallex") && !strings.EqualFold(c.Values["currency"], "CNY") {
		return contract.ErrPaymentClosed
	}
	for _, field := range []string{"apiBase", "notifyUrl", "returnUrl", "gateway"} {
		if raw := c.Values[field]; raw != "" && !paymentURL(raw) {
			return contract.ErrPaymentClosed
		}
	}
	return nil
}

func paymentURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Hostname() != "" && u.User == nil && u.Fragment == "" && (u.Scheme == "https" || (u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost" || u.Hostname() == "::1")))
}

func centsText(n int64) string { return fmt.Sprintf("%d.%02d", n/100, n%100) }
func signRSA(key *rsa.PrivateKey, message string) (string, error) {
	sum := sha256.Sum256([]byte(message))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sum[:])
	return base64.StdEncoding.EncodeToString(sig), err
}
func canonicalRequest(v url.Values) string {
	keys := []string{}
	for k := range v {
		if k != "sign" && v.Get(k) != "" {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	parts := []string{}
	for _, k := range keys {
		parts = append(parts, k+"="+v.Get(k))
	}
	return strings.Join(parts, "&")
}
func nonce() string { var b [16]byte; _, _ = rand.Read(b[:]); return hex.EncodeToString(b[:]) }

func (s PaymentGateway) request(ctx context.Context, method, endpoint, contentType string, body []byte, headers http.Header) ([]byte, http.Header, error) {
	if !paymentURL(endpoint) {
		return nil, nil, paymentFailure()
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, nil, paymentFailure()
	}
	req.Header = headers.Clone()
	if req.Header == nil {
		req.Header = http.Header{}
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	client := s.Client
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	response, err := client.Do(req)
	if err != nil {
		return nil, nil, paymentFailure()
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	if err != nil || len(raw) > 1<<20 || response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, nil, paymentFailure()
	}
	return raw, response.Header, nil
}

func (s PaymentGateway) alipay(ctx context.Context, c contract.PaymentConfiguration, method string, biz any) (json.RawMessage, error) {
	b, err := json.Marshal(biz)
	if err != nil {
		return nil, paymentFailure()
	}
	v := url.Values{"app_id": {c.Values["appId"]}, "method": {method}, "format": {"JSON"}, "charset": {"utf-8"}, "sign_type": {"RSA2"}, "timestamp": {time.Now().In(time.FixedZone("CST", 8*3600)).Format("2006-01-02 15:04:05")}, "version": {"1.0"}, "notify_url": {c.Values["notifyUrl"]}, "biz_content": {string(b)}}
	key, err := privateKey(c.Values["privateKey"])
	if err != nil {
		return nil, paymentFailure()
	}
	sig, err := signRSA(key, canonicalRequest(v))
	if err != nil {
		return nil, paymentFailure()
	}
	v.Set("sign", sig)
	raw, _, err := s.request(ctx, "POST", c.Values["gateway"], "application/x-www-form-urlencoded", []byte(v.Encode()), nil)
	if err != nil {
		return nil, err
	}
	var envelope map[string]json.RawMessage
	if json.Unmarshal(raw, &envelope) != nil {
		return nil, paymentFailure()
	}
	response := envelope[strings.ReplaceAll(method, ".", "_")+"_response"]
	var encoded string
	if json.Unmarshal(envelope["sign"], &encoded) != nil {
		return nil, paymentFailure()
	}
	signature, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, paymentFailure()
	}
	pub, err := domain.ParsePublicPEM(c.Values["alipayPublicKey"])
	if err != nil {
		return nil, paymentFailure()
	}
	sum := sha256.Sum256(response)
	if rsa.VerifyPKCS1v15(pub, crypto.SHA256, sum[:], signature) != nil {
		return nil, paymentFailure()
	}
	var status struct {
		Code string `json:"code"`
	}
	if json.Unmarshal(response, &status) != nil || status.Code != "10000" {
		return nil, paymentFailure()
	}
	return response, nil
}

func (s PaymentGateway) wechat(ctx context.Context, c contract.PaymentConfiguration, method, path string, body []byte) ([]byte, error) {
	key, err := privateKey(c.Values["privateKey"])
	if err != nil {
		return nil, paymentFailure()
	}
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	n := nonce()
	sig, err := signRSA(key, method+"\n"+path+"\n"+ts+"\n"+n+"\n"+string(body)+"\n")
	if err != nil {
		return nil, paymentFailure()
	}
	h := http.Header{"Authorization": {fmt.Sprintf(`WECHATPAY2-SHA256-RSA2048 mchid="%s",nonce_str="%s",signature="%s",timestamp="%s",serial_no="%s"`, c.Values["mchId"], n, sig, ts, c.Values["certSerial"])}, "Wechatpay-Serial": {c.Values["publicKeyId"]}, "Accept": {"application/json"}}
	raw, headers, err := s.request(ctx, method, "https://api.mch.weixin.qq.com"+path, "application/json", body, h)
	if err != nil {
		return nil, err
	}
	pub, err := domain.ParsePublicPEM(c.Values["publicKey"])
	if err != nil {
		return nil, paymentFailure()
	}
	if headers.Get("Wechatpay-Serial") != c.Values["publicKeyId"] {
		return nil, paymentFailure()
	}
	timestamp, err := strconv.ParseInt(headers.Get("Wechatpay-Timestamp"), 10, 64)
	if err != nil || time.Since(time.Unix(timestamp, 0)) > 5*time.Minute || time.Until(time.Unix(timestamp, 0)) > 5*time.Minute {
		return nil, paymentFailure()
	}
	signature, err := base64.StdEncoding.DecodeString(headers.Get("Wechatpay-Signature"))
	if err != nil {
		return nil, paymentFailure()
	}
	sum := sha256.Sum256([]byte(headers.Get("Wechatpay-Timestamp") + "\n" + headers.Get("Wechatpay-Nonce") + "\n" + string(raw) + "\n"))
	if rsa.VerifyPKCS1v15(pub, crypto.SHA256, sum[:], signature) != nil {
		return nil, paymentFailure()
	}
	return raw, nil
}

func (s PaymentGateway) airwallex(ctx context.Context, c contract.PaymentConfiguration, method, path string, body []byte) ([]byte, error) {
	base := strings.TrimRight(c.Values["apiBase"], "/")
	header := http.Header{"x-client-id": {c.Values["clientId"]}, "x-api-key": {c.Values["apiKey"]}}
	if c.Values["accountId"] != "" {
		header.Set("x-on-behalf-of", c.Values["accountId"])
	}
	raw, _, err := s.request(ctx, "POST", base+"/authentication/login", "application/json", []byte(`{}`), header)
	if err != nil {
		return nil, err
	}
	var token struct {
		Token string `json:"token"`
	}
	if json.Unmarshal(raw, &token) != nil || token.Token == "" {
		return nil, paymentFailure()
	}
	header = http.Header{"Authorization": {"Bearer " + token.Token}}
	if c.Values["accountId"] != "" {
		header.Set("x-on-behalf-of", c.Values["accountId"])
	}
	raw, _, err = s.request(ctx, method, base+path, "application/json", body, header)
	return raw, err
}

func (s PaymentGateway) Create(ctx context.Context, c contract.PaymentConfiguration, o contract.CheckoutOrder) (contract.PaymentEntry, error) {
	e := contract.PaymentEntry{}
	switch c.Provider {
	case "easypay":
		kind := "alipay"
		cid := c.Values["cidAlipay"]
		if o.Provider == "easypay_wechat" {
			kind = "wxpay"
			cid = c.Values["cidWxpay"]
		}
		v := url.Values{"pid": {c.Values["pid"]}, "type": {kind}, "out_trade_no": {o.PublicID}, "notify_url": {c.Values["notifyUrl"]}, "return_url": {c.Values["returnUrl"]}, "name": {"Podhub " + o.PublicID}, "money": {centsText(o.AmountCents)}}
		if cid != "" {
			v.Set("cid", cid)
		}
		fields := map[string]string{}
		for k := range v {
			fields[k] = v.Get(k)
		}
		v.Set("sign", domain.EasyPayMD5(fields, c.Values["pkey"]))
		v.Set("sign_type", "MD5")
		e.PayURL = strings.TrimRight(c.Values["apiBase"], "/") + "/submit.php?" + v.Encode()
	case "alipay":
		raw, err := s.alipay(ctx, c, "alipay.trade.precreate", map[string]any{"out_trade_no": o.PublicID, "total_amount": centsText(o.AmountCents), "subject": "Podhub " + o.PublicID, "timeout_express": "15m"})
		if err != nil {
			return e, err
		}
		var response struct {
			QR  string `json:"qr_code"`
			Out string `json:"out_trade_no"`
		}
		if json.Unmarshal(raw, &response) != nil || response.Out != o.PublicID || response.QR == "" {
			return e, paymentFailure()
		}
		e.QRCode = response.QR
	case "wechat":
		payload := map[string]any{"appid": c.Values["appId"], "mchid": c.Values["mchId"], "description": "Podhub " + o.PublicID, "out_trade_no": o.PublicID, "notify_url": c.Values["notifyUrl"], "amount": map[string]any{"total": o.AmountCents, "currency": o.Currency}}
		if o.Deadline != nil {
			payload["time_expire"] = o.Deadline.Format(time.RFC3339)
		}
		body, _ := json.Marshal(payload)
		raw, err := s.wechat(ctx, c, "POST", "/v3/pay/transactions/native", body)
		if err != nil {
			return e, err
		}
		var response struct {
			Code string `json:"code_url"`
		}
		if json.Unmarshal(raw, &response) != nil || response.Code == "" {
			return e, paymentFailure()
		}
		e.QRCode = response.Code
	case "stripe":
		v := url.Values{"mode": {"payment"}, "client_reference_id": {o.PublicID}, "metadata[order_id]": {o.PublicID}, "line_items[0][price_data][currency]": {"cny"}, "line_items[0][price_data][unit_amount]": {strconv.FormatInt(o.AmountCents, 10)}, "line_items[0][price_data][product_data][name]": {"Podhub " + o.PublicID}, "line_items[0][quantity]": {"1"}, "success_url": {c.Values["returnUrl"]}, "cancel_url": {c.Values["returnUrl"]}}
		h := http.Header{"Authorization": {"Bearer " + c.Values["secretKey"]}, "Idempotency-Key": {o.PublicID}}
		raw, _, err := s.request(ctx, "POST", "https://api.stripe.com/v1/checkout/sessions", "application/x-www-form-urlencoded", []byte(v.Encode()), h)
		if err != nil {
			return e, err
		}
		var response struct {
			ID  string `json:"id"`
			URL string `json:"url"`
		}
		if json.Unmarshal(raw, &response) != nil || response.ID == "" || !paymentURL(response.URL) {
			return e, paymentFailure()
		}
		e.PayURL = response.URL
		e.Reference = response.ID
	case "airwallex":
		payload := map[string]any{"reusable": false, "title": "Podhub " + o.PublicID, "amount": json.Number(centsText(o.AmountCents)), "currency": o.Currency, "reference": o.PublicID, "metadata": map[string]string{"order_id": o.PublicID}}
		if o.Deadline != nil {
			payload["expires_at"] = o.Deadline.Format(time.RFC3339)
		}
		body, _ := json.Marshal(payload)
		raw, err := s.airwallex(ctx, c, "POST", "/pa/payment_links/create", body)
		if err != nil {
			return e, err
		}
		var response struct {
			ID        string `json:"id"`
			URL       string `json:"url"`
			Reference string `json:"reference"`
		}
		if json.Unmarshal(raw, &response) != nil || response.ID == "" || response.Reference != o.PublicID || !paymentURL(response.URL) {
			return e, paymentFailure()
		}
		e.PayURL = response.URL
		e.Reference = response.ID
	default:
		return e, contract.ErrPaymentClosed
	}
	if len(e.PayURL) > 4096 || len(e.QRCode) > 16384 {
		return contract.PaymentEntry{}, paymentFailure()
	}
	return e, nil
}

func (s PaymentGateway) Query(ctx context.Context, c contract.PaymentConfiguration, o contract.CheckoutOrder) (*domain.Notice, error) {
	var n domain.Notice
	switch c.Provider {
	case "alipay":
		raw, err := s.alipay(ctx, c, "alipay.trade.query", map[string]string{"out_trade_no": o.PublicID})
		if err != nil {
			return nil, err
		}
		var v struct {
			Out    string `json:"out_trade_no"`
			Trade  string `json:"trade_no"`
			Status string `json:"trade_status"`
			Amount string `json:"total_amount"`
		}
		if json.Unmarshal(raw, &v) != nil || v.Out != o.PublicID {
			return nil, paymentFailure()
		}
		amount, err := domain.PaymentCents(v.Amount)
		if err != nil || amount <= 0 {
			return nil, paymentFailure()
		}
		n = domain.Notice{Provider: "alipay", PublicID: v.Out, ProviderRef: v.Trade, AmountCents: amount, Currency: "CNY", Paid: v.Status == "TRADE_SUCCESS" || v.Status == "TRADE_FINISHED", Canceled: v.Status == "TRADE_CLOSED"}
	case "wechat":
		raw, err := s.wechat(ctx, c, "GET", "/v3/pay/transactions/out-trade-no/"+url.PathEscape(o.PublicID)+"?mchid="+url.QueryEscape(c.Values["mchId"]), nil)
		if err != nil {
			return nil, err
		}
		n, err = domain.ParseWechatTransaction(domain.WechatKey{AppID: c.Values["appId"], MchID: c.Values["mchId"]}, raw)
		if err != nil {
			return nil, paymentFailure()
		}
	case "stripe":
		if o.ProviderRef == nil {
			return nil, nil
		}
		raw, _, err := s.request(ctx, "GET", "https://api.stripe.com/v1/checkout/sessions/"+url.PathEscape(*o.ProviderRef), "", nil, http.Header{"Authorization": {"Bearer " + c.Values["secretKey"]}})
		if err != nil {
			return nil, err
		}
		var state struct {
			Status string `json:"status"`
		}
		if json.Unmarshal(raw, &state) != nil {
			return nil, paymentFailure()
		}
		event := "checkout.session.completed"
		if state.Status == "expired" {
			event = "checkout.session.expired"
		}
		body, _ := json.Marshal(map[string]any{"type": event, "data": map[string]any{"object": json.RawMessage(raw)}})
		n, err = domain.ParseStripeEvent(body)
		if err != nil {
			return nil, paymentFailure()
		}
	case "airwallex":
		if o.ProviderRef == nil {
			return nil, nil
		}
		raw, err := s.airwallex(ctx, c, "GET", "/pa/payment_links/"+url.PathEscape(*o.ProviderRef), nil)
		if err != nil {
			return nil, err
		}
		n, err = domain.ParseAirwallexObject(raw, "")
		if err != nil {
			return nil, paymentFailure()
		}
	case "easypay":
		// A signed submit URL is the reusable entry; only a signed callback
		// settles it. Recovery never invents a second upstream trade.
		return nil, nil
	default:
		return nil, contract.ErrPaymentClosed
	}
	if n.PublicID != o.PublicID {
		return nil, paymentFailure()
	}
	return &n, nil
}

func (s PaymentGateway) Close(ctx context.Context, c contract.PaymentConfiguration, o contract.CheckoutOrder) error {
	var err error
	switch c.Provider {
	case "alipay":
		_, err = s.alipay(ctx, c, "alipay.trade.close", map[string]string{"out_trade_no": o.PublicID})
	case "wechat":
		body, _ := json.Marshal(map[string]string{"mchid": c.Values["mchId"]})
		_, err = s.wechat(ctx, c, "POST", "/v3/pay/transactions/out-trade-no/"+url.PathEscape(o.PublicID)+"/close", body)
	case "stripe":
		if o.ProviderRef == nil {
			return paymentFailure()
		}
		_, _, err = s.request(ctx, "POST", "https://api.stripe.com/v1/checkout/sessions/"+url.PathEscape(*o.ProviderRef)+"/expire", "application/x-www-form-urlencoded", nil, http.Header{"Authorization": {"Bearer " + c.Values["secretKey"]}})
	case "airwallex":
		// Deactivating a link does not prove its in-flight payment intent closed.
		return &domain.QuoteError{Status: 409, Code: "CONFLICT", Message: "支付链接仍需渠道确认，不能自动取消"}
	case "easypay":
		return &domain.QuoteError{Status: 409, Code: "CONFLICT", Message: "该渠道需等待支付结果确认后处理订单"}
	default:
		return contract.ErrPaymentClosed
	}
	return err
}
