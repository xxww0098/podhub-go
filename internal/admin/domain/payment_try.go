package domain

import (
	"net/url"
	"strings"
)

const defaultAlipayGateway = "https://openapi.alipay.com/gateway.do"

// ProviderFromConfig is validate_config. A whitespace-only required value
// fails here as a missing field because the Rust check is trim().is_empty().
// Direct try_new still accepts a non-empty untrimmed value.
func ProviderFromConfig(provider string, values map[string]string) string {
	required, known := requiredFields[provider]
	if !known {
		return "支付服务商类型无效"
	}
	for _, key := range required {
		value, ok := values[key]
		if !ok || strings.TrimSpace(value) == "" {
			return provider + " 缺少配置字段 " + key
		}
	}
	switch provider {
	case "easypay":
		return TryEasyPay(values)
	case "alipay":
		appID, err := configValue(values, "appId")
		if err != "" {
			return err
		}
		privateKey, err := configValue(values, "privateKey")
		if err != "" {
			return err
		}
		publicKey, err := configValue(values, "alipayPublicKey")
		if err != "" {
			return err
		}
		notifyURL, err := configValue(values, "notifyUrl")
		if err != "" {
			return err
		}
		gateway, err := configValue(values, "gateway")
		if err != "" {
			return err
		}
		return AlipayFromParts(appID, privateKey, publicKey, notifyURL, gateway)
	case "wechat":
		return TryWechat(values)
	case "stripe":
		return TryStripe(values)
	case "airwallex":
		return TryAirwallex(values)
	default:
		return "支付服务商类型无效"
	}
}

func configValue(values map[string]string, key string) (string, string) {
	value, ok := values[key]
	if !ok || value == "" {
		return "", "缺少配置字段 " + key
	}
	return value, ""
}

// httpsURL is providers.rs https_url. Parse failure is `{label}地址无效`.
// http is allowed only for host 127.0.0.1 or localhost. Username, password,
// or a fragment is `{label}必须是 HTTPS 地址`.
func httpsURL(raw, label string) string {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme == "" || parsed.Hostname() == "" {
		return label + "地址无效"
	}
	host := parsed.Hostname()
	local := host == "127.0.0.1" || host == "localhost"
	user := ""
	hasPassword := false
	if parsed.User != nil {
		user = parsed.User.Username()
		_, hasPassword = parsed.User.Password()
	}
	if (parsed.Scheme != "https" && !(local && parsed.Scheme == "http")) || user != "" || hasPassword || parsed.Fragment != "" {
		return label + "必须是 HTTPS 地址"
	}
	return ""
}

// TryEasyPay checks the three EasyPay URLs. It does not read pid or pkey
// and it does not build an HTTP client.
func TryEasyPay(values map[string]string) string {
	apiBase, err := configValue(values, "apiBase")
	if err != "" {
		return err
	}
	if msg := httpsURL(apiBase, "EasyPay API"); msg != "" {
		return msg
	}
	notifyURL, err := configValue(values, "notifyUrl")
	if err != "" {
		return err
	}
	if msg := httpsURL(notifyURL, "EasyPay 回调"); msg != "" {
		return msg
	}
	returnURL, err := configValue(values, "returnUrl")
	if err != "" {
		return err
	}
	return httpsURL(returnURL, "EasyPay 返回")
}

// AlipayFromParts is AlipayClient::from_parts without constructing an HTTP client.
// An empty gateway becomes the official default. validate_config rejects that
// empty string before this function runs.
func AlipayFromParts(appID, privateKey, publicKey, notifyURL, gateway string) string {
	_ = appID
	if msg := alipayNotify(notifyURL); msg != "" {
		return msg
	}
	if gateway == "" {
		gateway = defaultAlipayGateway
	}
	if msg := alipayGateway(gateway); msg != "" {
		return msg
	}
	if !rsaPrivate(privateKey) {
		return "无法解析 ALIPAY_PRIVATE_KEY"
	}
	if !rsaPublic(publicKey) {
		return "无法解析 ALIPAY_PUBLIC_KEY"
	}
	return ""
}

func alipayNotify(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme == "" || parsed.Hostname() == "" {
		return "支付宝回调地址无效"
	}
	local := parsed.Hostname() == "127.0.0.1"
	user := ""
	hasPassword := false
	if parsed.User != nil {
		user = parsed.User.Username()
		_, hasPassword = parsed.User.Password()
	}
	if (parsed.Scheme != "https" && !(local && parsed.Scheme == "http")) ||
		parsed.Path != "/api/billing/callback" ||
		parsed.RawQuery != "" || parsed.Fragment != "" || user != "" || hasPassword {
		return "支付宝回调地址必须是 HTTPS 且以 /api/billing/callback 结尾"
	}
	return ""
}

func alipayGateway(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme == "" || parsed.Hostname() == "" {
		return "支付宝网关地址无效"
	}
	host := parsed.Hostname()
	official := host == "openapi.alipay.com" || host == "openapi-sandbox.dl.alipaydev.com"
	local := host == "127.0.0.1"
	user := ""
	hasPassword := false
	if parsed.User != nil {
		user = parsed.User.Username()
		_, hasPassword = parsed.User.Password()
	}
	if (!official && !local) ||
		(official && parsed.Scheme != "https") ||
		(local && parsed.Scheme != "http" && parsed.Scheme != "https") ||
		!strings.HasSuffix(parsed.Path, "/gateway.do") ||
		parsed.RawQuery != "" || parsed.Fragment != "" || user != "" || hasPassword {
		return "只允许支付宝官方网关地址"
	}
	return ""
}

// TryWechat checks the APIv3 key length, the notify URL, then the remaining
// values and the two PEM keys. It does not build an HTTP client.
func TryWechat(values map[string]string) string {
	apiKey, err := configValue(values, "apiV3Key")
	if err != "" {
		return err
	}
	if len([]byte(apiKey)) != 32 {
		return "微信支付 APIv3 Key 必须正好 32 字节"
	}
	notifyURL, err := configValue(values, "notifyUrl")
	if err != "" {
		return err
	}
	if msg := httpsURL(notifyURL, "微信支付回调"); msg != "" {
		return msg
	}
	for _, key := range []string{"appId", "mchId", "privateKey", "certSerial", "publicKey", "publicKeyId"} {
		if _, err = configValue(values, key); err != "" {
			return err
		}
	}
	if !rsaPrivate(values["privateKey"]) {
		return "RSA 私钥无效"
	}
	if !rsaPublic(values["publicKey"]) {
		return "RSA 公钥无效"
	}
	return ""
}

// TryStripe checks key prefixes and a three-letter currency. The stored
// currency is not rewritten; only the check uses the ASCII lowercase copy.
func TryStripe(values map[string]string) string {
	secret, err := configValue(values, "secretKey")
	if err != "" {
		return err
	}
	if !strings.HasPrefix(secret, "sk_") {
		return "Stripe Secret Key 格式无效"
	}
	webhook, err := configValue(values, "webhookSecret")
	if err != "" {
		return err
	}
	if !strings.HasPrefix(webhook, "whsec_") {
		return "Stripe Webhook Secret 格式无效"
	}
	currency, err := configValue(values, "currency")
	if err != "" {
		return err
	}
	lower := asciiLower(currency)
	if len(lower) != 3 || !asciiLetters(lower) {
		return "Stripe currency 必须是三位字母"
	}
	returnURL, err := configValue(values, "returnUrl")
	if err != "" {
		return err
	}
	return httpsURL(returnURL, "Stripe 返回")
}

// TryAirwallex checks the official API host and path, then currency and country.
// A missing or empty accountId is not an error.
func TryAirwallex(values map[string]string) string {
	apiBase, err := configValue(values, "apiBase")
	if err != "" {
		return err
	}
	if msg := httpsURL(apiBase, "Airwallex API"); msg != "" {
		return msg
	}
	parsed, parseErr := url.Parse(apiBase)
	if parseErr != nil {
		return "Airwallex API地址无效"
	}
	host := parsed.Hostname()
	official := host == "api.airwallex.com" || host == "api-demo.airwallex.com" || host == "api.sandbox.airwallex.com"
	if !official || strings.TrimRight(parsed.Path, "/") != "/api/v1" {
		return "Airwallex API 必须是官方 /api/v1 地址"
	}
	currency, err := configValue(values, "currency")
	if err != "" {
		return err
	}
	upper := asciiUpper(currency)
	if len(upper) != 3 || !asciiLetters(upper) {
		return "Airwallex currency 必须是三位字母"
	}
	country, err := configValue(values, "countryCode")
	if err != "" {
		return err
	}
	country = asciiUpper(country)
	if len(country) != 2 || !asciiLetters(country) {
		return "Airwallex countryCode 必须是两位字母"
	}
	for _, key := range []string{"clientId", "apiKey", "webhookSecret"} {
		if _, err = configValue(values, key); err != "" {
			return err
		}
	}
	return ""
}

func asciiLower(value string) string {
	b := []byte(value)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + ('a' - 'A')
		}
	}
	return string(b)
}

func asciiUpper(value string) string {
	b := []byte(value)
	for i, c := range b {
		if c >= 'a' && c <= 'z' {
			b[i] = c - ('a' - 'A')
		}
	}
	return string(b)
}

func asciiLetters(value string) bool {
	if value == "" {
		return false
	}
	for i := 0; i < len(value); i++ {
		c := value[i]
		if c < 'a' || c > 'z' {
			if c < 'A' || c > 'Z' {
				return false
			}
		}
	}
	return true
}
