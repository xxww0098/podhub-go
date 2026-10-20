package domain

import (
	"strings"
	"testing"
)

func TestProviderFromConfigChannels(t *testing.T) {
	priv, pub := pemPair(t)
	if msg := ProviderFromConfig("nope", nil); msg != "支付服务商类型无效" {
		t.Fatal(msg)
	}
	easy := map[string]string{
		"pid": "1", "pkey": "k",
		"apiBase": "https://pay.example.invalid/", "notifyUrl": "https://cloud.example.invalid/cb",
		"returnUrl": "https://cloud.example.invalid/return",
	}
	if msg := TryEasyPay(easy); msg != "" {
		t.Fatal(msg)
	}
	if msg := ProviderFromConfig("easypay", map[string]string{
		"pid": "1", "pkey": "k", "apiBase": " ", "notifyUrl": "https://a.example", "returnUrl": "https://b.example",
	}); msg != "easypay 缺少配置字段 apiBase" {
		t.Fatal(msg)
	}
	spaced := map[string]string{"apiBase": " ", "notifyUrl": "https://a.example", "returnUrl": "https://b.example"}
	if msg := TryEasyPay(spaced); msg != "EasyPay API地址无效" {
		t.Fatal(msg)
	}
	if msg := httpsURL("http://example.com/x", "EasyPay API"); msg != "EasyPay API必须是 HTTPS 地址" {
		t.Fatal(msg)
	}
	if msg := httpsURL("https://user:pass@example.com/x", "EasyPay API"); msg != "EasyPay API必须是 HTTPS 地址" {
		t.Fatal(msg)
	}
	if msg := httpsURL("https://example.com/x#f", "EasyPay 返回"); msg != "EasyPay 返回必须是 HTTPS 地址" {
		t.Fatal(msg)
	}
	if msg := httpsURL("http://127.0.0.1/x", "EasyPay API"); msg != "" {
		t.Fatal(msg)
	}
	if msg := httpsURL("http://localhost/x", "EasyPay 回调"); msg != "" {
		t.Fatal(msg)
	}
	if msg := httpsURL("http://127.0.0.1.evil/x", "EasyPay API"); msg != "EasyPay API必须是 HTTPS 地址" {
		t.Fatal(msg)
	}

	notify := "https://cloud.example.invalid/api/billing/callback"
	gateway := "https://openapi.alipay.com/gateway.do"
	if msg := AlipayFromParts("app", priv, pub, notify, gateway); msg != "" {
		t.Fatal(msg)
	}
	if msg := AlipayFromParts("app", priv, pub, notify, ""); msg != "" {
		t.Fatal("empty gateway", msg)
	}
	if msg := AlipayFromParts("app", priv, pub, "http://localhost/api/billing/callback", gateway); msg != "支付宝回调地址必须是 HTTPS 且以 /api/billing/callback 结尾" {
		t.Fatal(msg)
	}
	if msg := AlipayFromParts("app", priv, pub, "http://127.0.0.1/api/billing/callback", gateway); msg != "" {
		t.Fatal(msg)
	}
	if msg := AlipayFromParts("app", priv, pub, "not a url", gateway); msg != "支付宝回调地址无效" {
		t.Fatal(msg)
	}
	if msg := AlipayFromParts("app", priv, pub, "https://cloud.example.invalid/api/billing/callback?x=1", gateway); msg != "支付宝回调地址必须是 HTTPS 且以 /api/billing/callback 结尾" {
		t.Fatal(msg)
	}
	if msg := AlipayFromParts("app", priv, pub, notify, "https://evil.example/gateway.do"); msg != "只允许支付宝官方网关地址" {
		t.Fatal(msg)
	}
	if msg := AlipayFromParts("app", priv, pub, notify, "http://127.0.0.1/gateway.do"); msg != "" {
		t.Fatal(msg)
	}
	if msg := AlipayFromParts("app", "nope", pub, notify, gateway); msg != "无法解析 ALIPAY_PRIVATE_KEY" {
		t.Fatal(msg)
	}
	if msg := AlipayFromParts("app", priv, "nope", notify, gateway); msg != "无法解析 ALIPAY_PUBLIC_KEY" {
		t.Fatal(msg)
	}
	if msg := AlipayFromParts("app", priv, pub, notify, "://"); msg != "支付宝网关地址无效" && msg != "只允许支付宝官方网关地址" {
		t.Fatal(msg)
	}

	wechat := map[string]string{
		"appId": "wx", "mchId": "1", "privateKey": priv, "apiV3Key": strings.Repeat("a", 32),
		"certSerial": "S", "publicKey": pub, "publicKeyId": "P",
		"notifyUrl": "https://cloud.example.invalid/cb",
	}
	if msg := TryWechat(wechat); msg != "" {
		t.Fatal(msg)
	}
	short := cloneMap(wechat)
	short["apiV3Key"] = strings.Repeat("a", 31)
	if msg := TryWechat(short); msg != "微信支付 APIv3 Key 必须正好 32 字节" {
		t.Fatal(msg)
	}
	wide := cloneMap(wechat)
	wide["apiV3Key"] = strings.Repeat("啊", 11)
	if msg := TryWechat(wide); msg != "微信支付 APIv3 Key 必须正好 32 字节" {
		t.Fatal(msg)
	}
	badNotify := cloneMap(wechat)
	badNotify["notifyUrl"] = " "
	if msg := TryWechat(badNotify); msg != "微信支付回调地址无效" {
		t.Fatal(msg)
	}
	missing := cloneMap(wechat)
	delete(missing, "appId")
	if msg := TryWechat(missing); msg != "缺少配置字段 appId" {
		t.Fatal(msg)
	}
	badKey := cloneMap(wechat)
	badKey["privateKey"] = "nope"
	if msg := TryWechat(badKey); msg != "RSA 私钥无效" {
		t.Fatal(msg)
	}
	badPub := cloneMap(wechat)
	badPub["publicKey"] = "nope"
	if msg := TryWechat(badPub); msg != "RSA 公钥无效" {
		t.Fatal(msg)
	}

	stripe := map[string]string{
		"secretKey": "sk_test", "publishableKey": "pk_test", "webhookSecret": "whsec_x",
		"currency": "USD", "returnUrl": "https://cloud.example.invalid/return",
	}
	if msg := TryStripe(stripe); msg != "" || stripe["currency"] != "USD" {
		t.Fatal(msg, stripe["currency"])
	}
	badSK := cloneMap(stripe)
	badSK["secretKey"] = "pk_test"
	if msg := TryStripe(badSK); msg != "Stripe Secret Key 格式无效" {
		t.Fatal(msg)
	}
	badWH := cloneMap(stripe)
	badWH["webhookSecret"] = "sk_test"
	if msg := TryStripe(badWH); msg != "Stripe Webhook Secret 格式无效" {
		t.Fatal(msg)
	}
	badCur := cloneMap(stripe)
	badCur["currency"] = "us"
	if msg := TryStripe(badCur); msg != "Stripe currency 必须是三位字母" {
		t.Fatal(msg)
	}
	if msg := httpsURL("http://example.com", "Stripe 返回"); msg != "Stripe 返回必须是 HTTPS 地址" {
		t.Fatal(msg)
	}

	air := map[string]string{
		"clientId": "c", "apiKey": "k", "webhookSecret": "w",
		"apiBase": "https://api-demo.airwallex.com/api/v1", "currency": "usd", "countryCode": "hk",
	}
	if msg := TryAirwallex(air); msg != "" || air["currency"] != "usd" {
		t.Fatal(msg)
	}
	slash := cloneMap(air)
	slash["apiBase"] = "https://api.airwallex.com/api/v1/"
	if msg := TryAirwallex(slash); msg != "" {
		t.Fatal(msg)
	}
	if msg := httpsURL(" ", "Airwallex API"); msg != "Airwallex API地址无效" {
		t.Fatal(msg)
	}
	if msg := httpsURL("http://api.airwallex.com/api/v1", "Airwallex API"); msg != "Airwallex API必须是 HTTPS 地址" {
		t.Fatal(msg)
	}
	badHost := cloneMap(air)
	badHost["apiBase"] = "https://evil.example/api/v1"
	if msg := TryAirwallex(badHost); msg != "Airwallex API 必须是官方 /api/v1 地址" {
		t.Fatal(msg)
	}
	badCountry := cloneMap(air)
	badCountry["countryCode"] = "H"
	if msg := TryAirwallex(badCountry); msg != "Airwallex countryCode 必须是两位字母" {
		t.Fatal(msg)
	}
	noAccount := cloneMap(air)
	noAccount["accountId"] = ""
	if msg := TryAirwallex(noAccount); msg != "" {
		t.Fatal(msg)
	}
}

func cloneMap(in map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range in {
		out[k] = v
	}
	return out
}
