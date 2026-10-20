package domain

import (
	"crypto/x509"
	"encoding/pem"
	"strings"
)

const integrationPlaceholder = "set-a-random-32-plus-character-server-secret"

// ProviderOrder is the response order. Missing slots are filled disabled.
var ProviderOrder = []string{"easypay", "alipay", "wechat", "stripe", "airwallex"}

var secretFields = map[string][]string{
	"easypay":   {"pkey"},
	"alipay":    {"privateKey", "alipayPublicKey"},
	"wechat":    {"privateKey", "apiV3Key", "publicKey"},
	"stripe":    {"secretKey", "webhookSecret"},
	"airwallex": {"apiKey", "webhookSecret"},
}

var allowedFields = map[string][]string{
	"easypay":   {"pid", "pkey", "apiBase", "notifyUrl", "returnUrl", "cidAlipay", "cidWxpay"},
	"alipay":    {"appId", "privateKey", "alipayPublicKey", "notifyUrl", "gateway"},
	"wechat":    {"appId", "mchId", "privateKey", "apiV3Key", "certSerial", "publicKey", "publicKeyId", "notifyUrl"},
	"stripe":    {"secretKey", "publishableKey", "webhookSecret", "currency", "returnUrl"},
	"airwallex": {"clientId", "apiKey", "webhookSecret", "apiBase", "currency", "countryCode", "accountId"},
}

var requiredFields = map[string][]string{
	"easypay":   {"pid", "pkey", "apiBase", "notifyUrl", "returnUrl"},
	"alipay":    {"appId", "privateKey", "alipayPublicKey", "notifyUrl", "gateway"},
	"wechat":    {"appId", "mchId", "privateKey", "apiV3Key", "certSerial", "publicKey", "publicKeyId", "notifyUrl"},
	"stripe":    {"secretKey", "publishableKey", "webhookSecret", "currency", "returnUrl"},
	"airwallex": {"clientId", "apiKey", "webhookSecret", "apiBase", "currency", "countryCode"},
}

var mutableWhenPending = map[string][]string{
	"alipay":  {"privateKey", "alipayPublicKey", "notifyUrl"},
	"wechat":  {"privateKey", "apiV3Key", "certSerial", "publicKey", "publicKeyId", "notifyUrl"},
	"easypay": {"pkey", "notifyUrl", "returnUrl"},
}

// PaymentSlot is one provider row, secrets included.
type PaymentSlot struct {
	Provider string
	Enabled  bool
	Values   map[string]string
}

// IntegrationKey accepts a trimmed server secret of at least 32 bytes.
func IntegrationKey(raw string) *Fault {
	raw = strings.TrimSpace(raw)
	if len(raw) < 32 {
		return Unavailable("UNAVAILABLE", "平台连接配置密钥未设置")
	}
	if raw == integrationPlaceholder {
		return Unavailable("UNAVAILABLE", "平台连接配置密钥不能使用 .env.example 中的占位值")
	}
	return nil
}

// DefaultPublicValues are the keys shown when nothing is stored.
func DefaultPublicValues(provider string) map[string]string {
	switch provider {
	case "alipay":
		return map[string]string{"gateway": "https://openapi.alipay.com/gateway.do"}
	case "stripe":
		return map[string]string{"currency": "cny"}
	case "airwallex":
		return map[string]string{
			"apiBase":     "https://api.airwallex.com/api/v1",
			"currency":    "CNY",
			"countryCode": "CN",
		}
	default:
		return map[string]string{}
	}
}

func isSecret(provider, key string) bool {
	for _, secret := range secretFields[provider] {
		if secret == key {
			return true
		}
	}
	return false
}

func allowed(provider, key string) bool {
	for _, name := range allowedFields[provider] {
		if name == key {
			return true
		}
	}
	return false
}

// PublicView drops secret values and lists configured secret names.
func PublicView(slot PaymentSlot) (map[string]string, []string) {
	values := map[string]string{}
	var secrets []string
	for _, key := range allowedFields[slot.Provider] {
		if isSecret(slot.Provider, key) {
			if strings.TrimSpace(slot.Values[key]) != "" {
				secrets = append(secrets, key)
			}
			continue
		}
		if value, ok := slot.Values[key]; ok {
			values[key] = value
		}
	}
	if len(values) == 0 {
		values = DefaultPublicValues(slot.Provider)
	}
	if secrets == nil {
		secrets = []string{}
	}
	return values, secrets
}

// EmptyPayment is the five disabled slots.
func EmptyPayment() []PaymentSlot {
	out := make([]PaymentSlot, 0, len(ProviderOrder))
	for _, provider := range ProviderOrder {
		out = append(out, PaymentSlot{Provider: provider, Values: DefaultPublicValues(provider)})
	}
	return out
}

// NormalizePayment merges a replace body onto the stored slots.
func NormalizePayment(expected int64, incoming []PaymentSlot, previous []PaymentSlot) ([]PaymentSlot, *Fault) {
	if expected < 0 {
		return nil, Validation("VALIDATION", "配置 revision 无效")
	}
	if len(incoming) > 5 {
		return nil, Validation("VALIDATION", "支付服务商数量无效")
	}
	merged := map[string]PaymentSlot{}
	for _, slot := range incoming {
		values := map[string]string{}
		for key, value := range slot.Values {
			if !allowed(slot.Provider, key) {
				return nil, Validation("VALIDATION", slot.Provider+" 包含未知配置字段")
			}
			if len(strings.TrimSpace(value)) > 16384 {
				return nil, Validation("VALIDATION", "支付配置字段过长")
			}
			values[key] = value
		}
		slot.Values = values
		merged[slot.Provider] = slot
	}
	for provider := range merged {
		if !knownProvider(provider) {
			return nil, Validation("VALIDATION", "支付服务商类型无效")
		}
	}
	prev := map[string]PaymentSlot{}
	for _, slot := range previous {
		prev[slot.Provider] = slot
	}
	out := make([]PaymentSlot, 0, len(ProviderOrder))
	for _, provider := range ProviderOrder {
		slot, ok := merged[provider]
		if !ok {
			out = append(out, PaymentSlot{Provider: provider, Enabled: false, Values: DefaultPublicValues(provider)})
			continue
		}
		values := map[string]string{}
		for key, value := range DefaultPublicValues(provider) {
			values[key] = value
		}
		old := prev[provider].Values
		for _, key := range allowedFields[provider] {
			raw, present := slot.Values[key]
			trimmed := strings.TrimSpace(raw)
			if isSecret(provider, key) && (!present || trimmed == "") {
				if old[key] != "" {
					values[key] = old[key]
				}
				continue
			}
			if present && trimmed != "" {
				values[key] = trimmed
				continue
			}
			if !isSecret(provider, key) {
				if old[key] != "" && !present {
					values[key] = old[key]
				}
			}
		}
		next := PaymentSlot{Provider: provider, Enabled: slot.Enabled, Values: values}
		if next.Enabled {
			if err := ValidateStored(next); err != nil {
				return nil, err
			}
		}
		out = append(out, next)
	}
	return out, nil
}

func knownProvider(provider string) bool {
	for _, name := range ProviderOrder {
		if name == provider {
			return true
		}
	}
	return false
}

// ValidateStored is validate_config. Enabled slots go through each channel's
// try_new / from_parts. Confirm does not call this.
func ValidateStored(slot PaymentSlot) *Fault {
	if msg := ProviderFromConfig(slot.Provider, slot.Values); msg != "" {
		return Validation("VALIDATION", msg)
	}
	return nil
}

func rsaPrivate(raw string) bool {
	block, _ := pem.Decode([]byte(raw))
	if block == nil {
		return false
	}
	if _, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return true
	}
	if _, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		return true
	}
	return false
}

func rsaPublic(raw string) bool {
	block, _ := pem.Decode([]byte(raw))
	if block == nil {
		return false
	}
	if _, err := x509.ParsePKIXPublicKey(block.Bytes); err == nil {
		return true
	}
	if _, err := x509.ParsePKCS1PublicKey(block.Bytes); err == nil {
		return true
	}
	return false
}

// SlotsEqual reports a byte-level value match used for merchantChanged.
func SlotsEqual(a, b []PaymentSlot) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].Provider != b[i].Provider || a[i].Enabled != b[i].Enabled {
			return false
		}
		if len(a[i].Values) != len(b[i].Values) {
			return false
		}
		for key, value := range a[i].Values {
			if b[i].Values[key] != value {
				return false
			}
		}
	}
	return true
}

// PendingProvider is the slot name: easypay_alipay → easypay.
func PendingProvider(provider string) string {
	if strings.HasPrefix(provider, "easypay_") {
		return "easypay"
	}
	return provider
}

// PendingChangeAllowed is validate_pending_payment_change for one provider.
func PendingChangeAllowed(provider string, before, after PaymentSlot) bool {
	name := PendingProvider(provider)
	if after.Provider != name || !after.Enabled {
		return false
	}
	if name == "stripe" || name == "airwallex" {
		return before.Enabled == after.Enabled && mapsEqual(before.Values, after.Values)
	}
	allowedChange := map[string]bool{}
	for _, key := range mutableWhenPending[name] {
		allowedChange[key] = true
	}
	keys := map[string]struct{}{}
	for key := range before.Values {
		keys[key] = struct{}{}
	}
	for key := range after.Values {
		keys[key] = struct{}{}
	}
	for key := range keys {
		if before.Values[key] == after.Values[key] {
			continue
		}
		if !allowedChange[key] {
			return false
		}
	}
	return true
}

func mapsEqual(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	for key, value := range a {
		if b[key] != value {
			return false
		}
	}
	return true
}

// Configured is validate_config on the stored row, including secrets.
func Configured(slot PaymentSlot) bool {
	return ValidateStored(slot) == nil
}
