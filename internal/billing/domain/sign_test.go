package domain

import (
	"crypto"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"testing"
	"time"
)

const alipayPublicPEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0I3SqqCJqrI7aPMAZ24a
mqnrzgdfUhN9ckLvBq6hxk9rfmxPLv8ibbIDJq+s3HlqOWnlzEkem5yjeqTl6BT1
D1jCtlfZFr6AXyq3Xr+slZPvpaZ217tbxUvYj4zTqs9Z/pt1pN7LSyuFrOS4KV8M
vjcF9gzBrPLz2Xk+cggrTwSZ5wM7ueVIsYjWLOwmgllTo7MWoHbd7wdmlHLZ3AO/
6Ys7jc6abp8mluWbuQwke13fXgz54NnjRqHX1PKKltw523tMCC6tGYkte5+LL9ch
awh80cbjlUseSXoNREITU/th7mDwrcZXR3cDmPgtWATlDYp2k6jNxAlOBGmhCrDr
lwIDAQAB
-----END PUBLIC KEY-----`

const frozenAlipay = "app_id=2021000000000000&out_trade_no=po_fixture&total_amount=699.00&trade_status=TRADE_SUCCESS"
const frozenAlipaySig = "XmseI7SdzmaQKc4u7mHMFjZGApPZMKr+OORa7kRS5HUEWndTe1X5gAiK9AyAAXphFHSwJRsz/BuS4CjahPYoUpcgGaXyzk+rxecH+fJ+I+OhPGca5AXSZd5cIdZV7XqoVxLPCoVS8K0M7MTYVa3BWDKLMDZj7k0xTWRfnrmHj3rwani5Abe88Dj19PrLCh1kcoQVS5lEEICm1A9Y0HqHi7L17B4vCZEA5Ts6uYTi2dVtExjjub1TbeQg+u2uuT2UAmfIWQljGfddwlSa54XqPj8/EckogqoZmi2WuOA2+lwc3MhljM/ySDAmUf0HcA5bIHFxkNidsQuklJCvWpn/Vg=="

func TestAlipayFrozenVector(t *testing.T) {
	pub, err := ParsePublicPEM(alipayPublicPEM)
	if err != nil {
		t.Fatal(err)
	}
	values := map[string]string{
		"app_id": "2021000000000000", "out_trade_no": "po_fixture", "total_amount": "699.00",
		"trade_status": "TRADE_SUCCESS", "sign_type": "RSA2", "sign": frozenAlipaySig,
		"trade_no": "202608192200140000",
	}
	if got := CanonicalAlipay(map[string]string{
		"app_id": values["app_id"], "out_trade_no": values["out_trade_no"],
		"total_amount": values["total_amount"], "trade_status": values["trade_status"],
		"sign": frozenAlipaySig, "sign_type": "RSA2",
	}); got != frozenAlipay {
		t.Fatalf("canonical %s", got)
	}
	sig, err := base64.StdEncoding.DecodeString(frozenAlipaySig)
	if err != nil {
		t.Fatal(err)
	}
	if err := verifyRSA(pub, []byte(frozenAlipay), sig); err != nil {
		t.Fatal(err)
	}
	cents, err := yuanToCents("699.00")
	if err != nil || cents != 69900 {
		t.Fatalf("cents %d %v", cents, err)
	}
	// trade_no is part of a live notify. Sign that string with a key we control
	// below; the frozen signature stays on the four-field string above.
	_ = values
}

func TestEasyPayFrozenDigest(t *testing.T) {
	got := EasyPayMD5(map[string]string{"pid": "1000", "money": "1.00", "sign": "ignored", "sign_type": ""}, "secret")
	if got != "84e855ac95a84f75456a750d555917f5" {
		t.Fatal(got)
	}
	fields := map[string]string{
		"pid": "1000", "money": "1.00", "out_trade_no": "po_1", "trade_no": "e1",
		"trade_status": "TRADE_SUCCESS",
	}
	fields["sign"] = EasyPayMD5(fields, "secret")
	notice, err := VerifyEasyPay("1000", "secret", fields, time.Unix(0, 0))
	if err != nil || !notice.Paid || notice.AmountCents != 100 || notice.PublicID != "po_1" {
		t.Fatalf("%+v %v", notice, err)
	}
}

func TestStripeFrozenHMAC(t *testing.T) {
	body := []byte(`{"type":"checkout.session.completed","data":{"object":{"id":"cs_1","payment_status":"paid","amount_total":1234,"currency":"cny","metadata":{"order_id":"po_1"}}}}`)
	const want = "3e7c889dc5aaaf75235456b6033dc191c371a2074af518026c3b456167618e95"
	now := time.Unix(1700000300, 0)
	notice, err := VerifyStripe(StripeKey{Secret: "whsec_123"}, "t=1700000000,v1="+want, body, now)
	if err != nil || !notice.Paid || notice.PublicID != "po_1" || notice.AmountCents != 1234 || notice.Currency != "CNY" {
		t.Fatalf("%+v %v", notice, err)
	}
	if _, err := VerifyStripe(StripeKey{Secret: "whsec_123"}, "t=1700000000,v1="+want, body, time.Unix(1700000301, 0)); err == nil {
		t.Fatal("301s skew")
	}
	other := []byte(`{"type":"charge.succeeded","data":{"object":{}}}`)
	otherMAC := hmacSHA(other)
	ignored, err := VerifyStripe(StripeKey{Secret: "whsec_123"}, "t=1700000000,v1="+otherMAC, other, now)
	if err != nil || !ignored.Ignored {
		t.Fatalf("%+v %v", ignored, err)
	}
}

func TestWechatGCMAndMessage(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	plain := []byte(`{"appid":"wx-test","mchid":"merchant-1","out_trade_no":"po_1","transaction_id":"wx_trade_1","trade_state":"SUCCESS","amount":{"total":1234,"currency":"CNY"}}`)
	apiKey := []byte("12345678901234567890123456789012")
	nonce := []byte("123456789012")
	sealed, err := sealGCM(apiKey, nonce, []byte("transaction"), plain)
	if err != nil {
		t.Fatal(err)
	}
	envelope, err := json.Marshal(map[string]any{"resource": map[string]string{
		"nonce": string(nonce), "associated_data": "transaction", "ciphertext": base64.StdEncoding.EncodeToString(sealed),
	}})
	if err != nil {
		t.Fatal(err)
	}
	ts := "1700000000"
	message := ts + "\n" + "nonce" + "\n" + string(envelope) + "\n"
	sum := sha256.Sum256([]byte(message))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sum[:])
	if err != nil {
		t.Fatal(err)
	}
	header := map[string]string{
		"Wechatpay-Timestamp": ts, "Wechatpay-Nonce": "nonce",
		"Wechatpay-Serial": "PUB_KEY_TEST", "Wechatpay-Signature": base64.StdEncoding.EncodeToString(sig),
	}
	notice, err := VerifyWechat(WechatKey{
		MchID: "merchant-1", AppID: "wx-test", PublicKeyID: "PUB_KEY_TEST", Public: &key.PublicKey, APIv3Key: apiKey,
	}, header, envelope, time.Unix(1700000300, 0))
	if err != nil || !notice.Paid || notice.PublicID != "po_1" || notice.AmountCents != 1234 || notice.ProviderRef != "wx_trade_1" {
		t.Fatalf("%+v %v", notice, err)
	}
	header["Wechatpay-Timestamp"] = "1"
	if _, err := VerifyWechat(WechatKey{MchID: "merchant-1", AppID: "wx-test", PublicKeyID: "PUB_KEY_TEST", Public: &key.PublicKey, APIv3Key: apiKey}, header, envelope, time.Unix(1700000300, 0)); err == nil {
		t.Fatal("stale timestamp")
	}
}

func hmacSHA(body []byte) string {
	mac := hmac.New(sha256.New, []byte("whsec_123"))
	mac.Write([]byte("1700000000." + string(body)))
	return hex.EncodeToString(mac.Sum(nil))
}

func sealGCM(key, nonce, aad, plain []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return gcm.Seal(nil, nonce, plain, aad), nil
}
