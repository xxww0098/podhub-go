package domain

import (
	"crypto"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/md5"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math/big"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

const webhookTolerance = 300

// Notice is a verified payment notification. AmountCents is fen.
type Notice struct {
	Provider    string
	PublicID    string
	ProviderRef string
	AmountCents int64
	Currency    string
	Paid        bool
	Canceled    bool
	Ignored     bool
}

// AlipayKey verifies RSA2 notify signatures.
type AlipayKey struct {
	AppID  string
	Public *rsa.PublicKey
}

// WechatKey verifies APIv3 notify signatures and decrypts the resource.
type WechatKey struct {
	MchID       string
	AppID       string
	PublicKeyID string
	Public      *rsa.PublicKey
	APIv3Key    []byte
}

// StripeKey verifies webhook signatures. The HMAC key is the raw whsec_
// string, including the prefix. It is not Base64-decoded.
type StripeKey struct {
	Secret string
}

// ParsePublicPEM accepts PKIX or PKCS#1 public keys.
func ParsePublicPEM(raw string) (*rsa.PublicKey, error) {
	raw = strings.ReplaceAll(raw, `\n`, "\n")
	block, _ := pem.Decode([]byte(raw))
	if block == nil {
		der, err := base64.StdEncoding.DecodeString(strings.TrimSpace(raw))
		if err != nil {
			return nil, fmt.Errorf("public key pem")
		}
		return parsePublicDER(der)
	}
	return parsePublicDER(block.Bytes)
}

func parsePublicDER(der []byte) (*rsa.PublicKey, error) {
	if key, err := x509.ParsePKIXPublicKey(der); err == nil {
		pub, ok := key.(*rsa.PublicKey)
		if !ok {
			return nil, fmt.Errorf("public key type")
		}
		return pub, nil
	}
	return x509.ParsePKCS1PublicKey(der)
}

// CanonicalAlipay is the RSA2 string. sign, sign_type, and empty values are
// omitted. Values are not percent-encoded. Keys are UTF-8 lexicographic.
func CanonicalAlipay(values map[string]string) string {
	keys := make([]string, 0, len(values))
	for key, value := range values {
		if key == "sign" || key == "sign_type" || value == "" {
			continue
		}
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, key+"="+values[key])
	}
	return strings.Join(parts, "&")
}

// VerifyAlipay checks an RSA2 form notification.
func VerifyAlipay(key AlipayKey, values map[string]string, now time.Time) (Notice, error) {
	_ = now
	signB64 := values["sign"]
	if signB64 == "" {
		return Notice{}, fmt.Errorf("invalid notification")
	}
	signType := values["sign_type"]
	if signType == "" {
		signType = "RSA2"
	}
	if signType != "RSA2" {
		return Notice{}, fmt.Errorf("invalid notification")
	}
	sig, err := base64.StdEncoding.DecodeString(signB64)
	if err != nil {
		return Notice{}, fmt.Errorf("invalid notification")
	}
	if err := verifyRSA(key.Public, []byte(CanonicalAlipay(values)), sig); err != nil {
		return Notice{}, fmt.Errorf("invalid notification")
	}
	if values["app_id"] != key.AppID || values["out_trade_no"] == "" {
		return Notice{}, fmt.Errorf("invalid notification")
	}
	cents, err := yuanToCents(values["total_amount"])
	if err != nil || cents <= 0 || values["trade_no"] == "" {
		return Notice{}, fmt.Errorf("invalid notification")
	}
	notice := Notice{
		Provider: "alipay", PublicID: values["out_trade_no"], ProviderRef: values["trade_no"],
		AmountCents: cents, Currency: "CNY",
	}
	switch values["trade_status"] {
	case "TRADE_SUCCESS", "TRADE_FINISHED":
		notice.Paid = true
	case "TRADE_CLOSED":
		notice.Canceled = true
	}
	return notice, nil
}

func yuanToCents(raw string) (int64, error) {
	raw = strings.TrimSpace(raw)
	rat, ok := new(big.Rat).SetString(raw)
	if !ok || rat.Sign() < 0 {
		return 0, fmt.Errorf("amount")
	}
	cents := new(big.Rat).Mul(rat, big.NewRat(100, 1))
	if !cents.IsInt() {
		return 0, fmt.Errorf("amount")
	}
	return cents.Num().Int64(), nil
}

// VerifyWechat checks the Wechatpay-* headers, then decrypts resource.
func VerifyWechat(key WechatKey, header map[string]string, body []byte, now time.Time) (Notice, error) {
	ts := headerValue(header, "Wechatpay-Timestamp")
	nonce := headerValue(header, "Wechatpay-Nonce")
	sigB64 := headerValue(header, "Wechatpay-Signature")
	serial := headerValue(header, "Wechatpay-Serial")
	if serial != key.PublicKeyID || ts == "" || nonce == "" || sigB64 == "" {
		return Notice{}, fmt.Errorf("invalid notification")
	}
	unix, err := strconv.ParseInt(ts, 10, 64)
	if err != nil || skew(now, unix) {
		return Notice{}, fmt.Errorf("invalid notification")
	}
	sig, err := base64.StdEncoding.DecodeString(sigB64)
	if err != nil {
		return Notice{}, fmt.Errorf("invalid notification")
	}
	message := ts + "\n" + nonce + "\n" + string(body) + "\n"
	if err := verifyRSA(key.Public, []byte(message), sig); err != nil {
		return Notice{}, fmt.Errorf("invalid notification")
	}
	plain, err := decryptWechatResource(key.APIv3Key, body)
	if err != nil {
		return Notice{}, fmt.Errorf("invalid notification")
	}
	return parseWechatPlain(key, plain)
}

func decryptWechatResource(apiKey, body []byte) ([]byte, error) {
	if len(apiKey) != 32 {
		return nil, fmt.Errorf("key")
	}
	var envelope struct {
		Resource struct {
			Nonce      string `json:"nonce"`
			Ciphertext string `json:"ciphertext"`
			Associated string `json:"associated_data"`
		} `json:"resource"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return nil, err
	}
	if len(envelope.Resource.Nonce) != 12 {
		return nil, fmt.Errorf("nonce")
	}
	raw, err := base64.StdEncoding.DecodeString(envelope.Resource.Ciphertext)
	if err != nil {
		return nil, err
	}
	return openGCM(apiKey, []byte(envelope.Resource.Nonce), []byte(envelope.Resource.Associated), raw)
}

func parseWechatPlain(key WechatKey, plain []byte) (Notice, error) {
	var tx struct {
		AppID   string `json:"appid"`
		MchID   string `json:"mchid"`
		OutNo   string `json:"out_trade_no"`
		TradeID string `json:"transaction_id"`
		State   string `json:"trade_state"`
		Amount  struct {
			Total    *int64 `json:"total"`
			Currency string `json:"currency"`
		} `json:"amount"`
	}
	if err := json.Unmarshal(plain, &tx); err != nil {
		return Notice{}, err
	}
	if tx.AppID != key.AppID || tx.MchID != key.MchID || tx.OutNo == "" || tx.TradeID == "" || tx.Amount.Total == nil || *tx.Amount.Total <= 0 || tx.Amount.Currency == "" {
		return Notice{}, fmt.Errorf("invalid notification")
	}
	notice := Notice{
		Provider: "wechat", PublicID: tx.OutNo, ProviderRef: tx.TradeID,
		AmountCents: *tx.Amount.Total, Currency: tx.Amount.Currency,
	}
	switch tx.State {
	case "SUCCESS":
		notice.Paid = true
	case "CLOSED", "REVOKED", "PAYERROR":
		notice.Canceled = true
	}
	return notice, nil
}

// VerifyStripe checks Stripe-Signature. v1 is lowercase hex of HMAC-SHA256
// over "{timestamp}.{body}". The key bytes are the secret string itself.
func VerifyStripe(key StripeKey, header string, body []byte, now time.Time) (Notice, error) {
	if !strings.HasPrefix(key.Secret, "whsec_") {
		return Notice{}, fmt.Errorf("invalid notification")
	}
	var ts string
	var sigs []string
	for _, part := range strings.Split(header, ",") {
		k, v, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			continue
		}
		switch k {
		case "t":
			ts = v
		case "v1":
			sigs = append(sigs, v)
		}
	}
	unix, err := strconv.ParseInt(ts, 10, 64)
	if err != nil || ts == "" || skew(now, unix) || len(sigs) == 0 {
		return Notice{}, fmt.Errorf("invalid notification")
	}
	mac := hmac.New(sha256.New, []byte(key.Secret))
	// The signed body has invalid UTF-8 replaced by U+FFFD.
	mac.Write([]byte(ts + "." + strings.ToValidUTF8(string(body), "\uFFFD")))
	want := hex.EncodeToString(mac.Sum(nil))
	matched := false
	for _, sig := range sigs {
		if hmac.Equal([]byte(want), []byte(sig)) && len(want) == len(sig) {
			matched = true
		}
	}
	if !matched {
		return Notice{}, fmt.Errorf("invalid notification")
	}
	return parseStripe(body)
}

func parseStripe(body []byte) (Notice, error) {
	var event struct {
		Type string `json:"type"`
		Data struct {
			Object struct {
				ID            string `json:"id"`
				PaymentStatus string `json:"payment_status"`
				AmountTotal   *int64 `json:"amount_total"`
				Currency      string `json:"currency"`
				ClientRef     string `json:"client_reference_id"`
				Metadata      struct {
					OrderID string `json:"order_id"`
				} `json:"metadata"`
			} `json:"object"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &event); err != nil {
		return Notice{}, fmt.Errorf("invalid notification")
	}
	switch event.Type {
	case "checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.expired":
	default:
		return Notice{Provider: "stripe", Ignored: true}, nil
	}
	obj := event.Data.Object
	publicID := obj.Metadata.OrderID
	if publicID == "" {
		publicID = obj.ClientRef
	}
	if event.Type == "checkout.session.expired" {
		if publicID == "" {
			return Notice{}, fmt.Errorf("invalid notification")
		}
		return Notice{Provider: "stripe", PublicID: publicID, ProviderRef: obj.ID, Canceled: true, Currency: strings.ToUpper(obj.Currency)}, nil
	}
	if publicID == "" || obj.ID == "" || obj.AmountTotal == nil || *obj.AmountTotal <= 0 || obj.Currency == "" {
		return Notice{}, fmt.Errorf("invalid notification")
	}
	notice := Notice{
		Provider: "stripe", PublicID: publicID, ProviderRef: obj.ID,
		AmountCents: *obj.AmountTotal, Currency: strings.ToUpper(obj.Currency),
		Paid: obj.PaymentStatus == "paid",
	}
	return notice, nil
}

// EasyPayMD5 is the frozen MD5 of the canonical form plus the merchant key
// with no separator. Comparison is ASCII case-insensitive.
func EasyPayMD5(values map[string]string, merchantKey string) string {
	keys := make([]string, 0, len(values))
	for key, value := range values {
		if key == "sign" || key == "sign_type" || value == "" {
			continue
		}
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var b strings.Builder
	for i, key := range keys {
		if i > 0 {
			b.WriteByte('&')
		}
		b.WriteString(key)
		b.WriteByte('=')
		b.WriteString(values[key])
	}
	b.WriteString(merchantKey)
	sum := md5.Sum([]byte(b.String()))
	return hex.EncodeToString(sum[:])
}

// VerifyEasyPay checks an MD5 form notification. pid must match.
func VerifyEasyPay(pid, merchantKey string, values map[string]string, now time.Time) (Notice, error) {
	_ = now
	sign := values["sign"]
	if sign == "" || !strings.EqualFold(sign, EasyPayMD5(values, merchantKey)) || values["pid"] != pid {
		return Notice{}, fmt.Errorf("invalid notification")
	}
	cents, err := yuanToCents(values["money"])
	if err != nil || cents <= 0 || values["out_trade_no"] == "" || values["trade_no"] == "" {
		return Notice{}, fmt.Errorf("invalid notification")
	}
	notice := Notice{
		Provider: "easypay", PublicID: values["out_trade_no"], ProviderRef: values["trade_no"],
		AmountCents: cents, Currency: "CNY",
	}
	switch values["trade_status"] {
	case "TRADE_SUCCESS", "TRADE_FINISHED":
		notice.Paid = true
	case "TRADE_CLOSED":
		notice.Canceled = true
	}
	return notice, nil
}

func openGCM(key, nonce, aad, ciphertext []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(nonce) != gcm.NonceSize() {
		return nil, fmt.Errorf("nonce")
	}
	return gcm.Open(nil, nonce, ciphertext, aad)
}

func verifyRSA(pub *rsa.PublicKey, message, sig []byte) error {
	if pub == nil || pub.N.BitLen() < 2048 || pub.N.BitLen() > 8192 {
		return fmt.Errorf("key")
	}
	sum := sha256.Sum256(message)
	return rsa.VerifyPKCS1v15(pub, crypto.SHA256, sum[:], sig)
}

func skew(now time.Time, unix int64) bool {
	delta := now.Unix() - unix
	if delta < 0 {
		delta = -delta
	}
	return delta > webhookTolerance
}

func headerValue(header map[string]string, name string) string {
	for key, value := range header {
		if strings.EqualFold(key, name) {
			return value
		}
	}
	return ""
}

// FormValues parses an application/x-www-form-urlencoded body.
func FormValues(body []byte) map[string]string {
	parsed, _ := url.ParseQuery(string(body))
	out := make(map[string]string, len(parsed))
	for key, values := range parsed {
		if len(values) > 0 {
			out[key] = values[0]
		}
	}
	return out
}
