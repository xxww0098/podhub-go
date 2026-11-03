package domain

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
	"time"
)

type AirwallexKey struct{ Secret, AccountID string }

// VerifyAirwallex authenticates the raw timestamp+body before parsing.
// https://www.airwallex.com/docs/developer-tools/webhooks/listen-for-webhook-events
func VerifyAirwallex(key AirwallexKey, timestamp, signature string, body []byte, now time.Time) (Notice, error) {
	bad := errors.New("invalid notification")
	ms, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil || key.Secret == "" || ms <= 0 || now.Sub(time.UnixMilli(ms)) > 5*time.Minute || time.UnixMilli(ms).Sub(now) > 5*time.Minute {
		return Notice{}, bad
	}
	got, err := hex.DecodeString(signature)
	if err != nil {
		return Notice{}, bad
	}
	mac := hmac.New(sha256.New, []byte(key.Secret))
	_, _ = mac.Write([]byte(timestamp))
	_, _ = mac.Write(body)
	if !hmac.Equal(got, mac.Sum(nil)) {
		return Notice{}, bad
	}
	var event struct {
		Name      string `json:"name"`
		AccountID string `json:"account_id"`
		Data      struct {
			Object json.RawMessage `json:"object"`
		} `json:"data"`
	}
	if json.Unmarshal(body, &event) != nil || (key.AccountID != "" && event.AccountID != key.AccountID) {
		return Notice{}, bad
	}
	switch event.Name {
	case "payment_intent.succeeded", "payment_intent.cancelled", "payment_link.paid":
		return ParseAirwallexObject(event.Data.Object, event.Name)
	default:
		return Notice{Provider: "airwallex", Ignored: true}, nil
	}
}

// ParseAirwallexObject also handles authenticated API query responses.
func ParseAirwallexObject(body []byte, event string) (Notice, error) {
	var obj struct {
		ID              string            `json:"id"`
		MerchantOrderID string            `json:"merchant_order_id"`
		Reference       string            `json:"reference"`
		Status          string            `json:"status"`
		Currency        string            `json:"currency"`
		Amount          json.Number       `json:"amount"`
		Metadata        map[string]string `json:"metadata"`
	}
	if err := json.Unmarshal(body, &obj); err != nil {
		return Notice{}, err
	}
	id := obj.MerchantOrderID
	if id == "" {
		id = obj.Reference
	}
	if id == "" {
		id = obj.Metadata["order_id"]
	}
	amount, err := PaymentCents(string(obj.Amount))
	if err != nil || amount <= 0 || id == "" || obj.ID == "" || obj.Currency == "" {
		return Notice{}, errors.New("invalid notification")
	}
	n := Notice{Provider: "airwallex", PublicID: id, ProviderRef: obj.ID, AmountCents: amount, Currency: obj.Currency}
	n.Paid = (obj.Status == "SUCCEEDED" && event != "payment_intent.cancelled") || (obj.Status == "PAID" && event != "payment_intent.cancelled")
	n.Canceled = obj.Status == "CANCELLED"
	return n, nil
}
