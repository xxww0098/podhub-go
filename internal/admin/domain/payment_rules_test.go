package domain

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"strings"
	"testing"
)

func TestIntegrationKey(t *testing.T) {
	if IntegrationKey("short") == nil || IntegrationKey("  short  ") == nil {
		t.Fatal("short")
	}
	if err := IntegrationKey(integrationPlaceholder); err == nil || !strings.Contains(err.Message, "占位值") {
		t.Fatal(err)
	}
	if IntegrationKey(strings.Repeat("k", 32)) != nil {
		t.Fatal("long")
	}
}

func TestPaymentNormalizeAndPending(t *testing.T) {
	empty := EmptyPayment()
	if len(empty) != 5 || empty[0].Provider != "easypay" || empty[1].Values["gateway"] == "" {
		t.Fatalf("%+v", empty)
	}
	priv, pub := pemPair(t)
	incoming := []PaymentSlot{{
		Provider: "alipay",
		Enabled:  true,
		Values: map[string]string{
			"appId": "app", "privateKey": priv, "alipayPublicKey": pub,
			"notifyUrl": "https://pay.example/api/billing/callback", "gateway": "https://openapi.alipay.com/gateway.do",
		},
	}}
	next, err := NormalizePayment(0, incoming, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !next[1].Enabled || next[1].Values["privateKey"] == "" {
		t.Fatalf("%+v", next[1])
	}
	view, secrets := PublicView(next[1])
	if _, ok := view["privateKey"]; ok || len(secrets) != 2 {
		t.Fatalf("view %#v secrets %#v", view, secrets)
	}
	if _, err := NormalizePayment(0, []PaymentSlot{{Provider: "alipay", Values: map[string]string{"nope": "1"}}}, nil); err == nil || !strings.Contains(err.Message, "未知配置字段") {
		t.Fatal(err)
	}
	if _, err := NormalizePayment(-1, nil, nil); err == nil {
		t.Fatal("revision")
	}
	rotated := cloneSlots(next)
	rotated[1].Values["privateKey"] = priv
	if !PendingChangeAllowed("alipay", next[1], rotated[1]) {
		t.Fatal("rotate key")
	}
	identity := cloneSlots(next)
	identity[1].Values["appId"] = "other"
	if PendingChangeAllowed("alipay", next[1], identity[1]) {
		t.Fatal("appId frozen")
	}
	if PendingChangeAllowed("easypay_alipay", next[0], next[0]) {
		t.Fatal("disabled easypay slot")
	}
}

func pemPair(t *testing.T) (string, string) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	priv := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	pubBytes, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	pub := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: pubBytes})
	return string(priv), string(pub)
}

func cloneSlots(in []PaymentSlot) []PaymentSlot {
	out := make([]PaymentSlot, len(in))
	for i, slot := range in {
		out[i] = slot
		out[i].Values = map[string]string{}
		for k, v := range slot.Values {
			out[i].Values[k] = v
		}
	}
	return out
}
