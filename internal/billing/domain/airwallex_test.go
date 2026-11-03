package domain

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"testing"
	"time"
)

func TestAirwallexSignatures(t *testing.T) {
	now := time.Unix(1800000000, 0)
	ts := strconv.FormatInt(now.UnixMilli(), 10)
	key := AirwallexKey{Secret: "local-webhook-secret", AccountID: "local-account"}
	body := []byte(`{"name":"payment_link.paid","account_id":"local-account","data":{"object":{"id":"link-1","reference":"order-1","status":"PAID","amount":1.23,"currency":"CNY"}}}`)
	sign := func(b []byte, timestamp string) string {
		mac := hmac.New(sha256.New, []byte(key.Secret))
		_, _ = mac.Write([]byte(timestamp))
		_, _ = mac.Write(b)
		return hex.EncodeToString(mac.Sum(nil))
	}
	n, err := VerifyAirwallex(key, ts, sign(body, ts), body, now)
	if err != nil || !n.Paid || n.AmountCents != 123 || n.PublicID != "order-1" {
		t.Fatalf("notice=%+v err=%v", n, err)
	}
	for _, tc := range []struct {
		name                 string
		key                  AirwallexKey
		timestamp, signature string
		body                 []byte
	}{
		{"tampered", key, ts, sign(body, ts), append(append([]byte{}, body...), byte(' '))},
		{"stale", key, strconv.FormatInt(now.Add(-301*time.Second).UnixMilli(), 10), sign(body, strconv.FormatInt(now.Add(-301*time.Second).UnixMilli(), 10)), body},
		{"wrong account", AirwallexKey{Secret: key.Secret, AccountID: "other-account"}, ts, sign(body, ts), body},
		{"wrong secret", AirwallexKey{Secret: "rotated", AccountID: key.AccountID}, ts, sign(body, ts), body},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := VerifyAirwallex(tc.key, tc.timestamp, tc.signature, tc.body, now); err == nil {
				t.Fatal("invalid notification accepted")
			}
		})
	}
	ignored := []byte(`{"name":"payment_link.created","account_id":"local-account","data":{"object":{}}}`)
	n, err = VerifyAirwallex(key, ts, sign(ignored, ts), ignored, now)
	if err != nil || !n.Ignored {
		t.Fatal("non-payment event not ignored")
	}
}

func TestPaymentCentsDoesNotOverflow(t *testing.T) {
	for _, raw := range []string{"9223372036854775808", "92233720368547758.08", "1.001", "-1"} {
		if _, err := PaymentCents(raw); err == nil {
			t.Fatalf("unsafe money accepted: %s", raw)
		}
	}
}
