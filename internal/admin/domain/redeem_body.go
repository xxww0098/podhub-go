package domain

import (
	"bytes"
	"encoding/json"
	"time"
)

// ParseRedeemBody is the admin create-redeem JSON check plus ValidateRedeemCreate.
// MCP generation uses this function so the quantity, tier, amount, and expiry
// rules stay on the one path the admin HTTP handler already calls.
func ParseRedeemBody(body []byte, now time.Time) (RedeemSpec, *Fault) {
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	var raw struct {
		Product      string  `json:"product"`
		MemberSeats  *int64  `json:"member_seats"`
		Tier         string  `json:"tier"`
		OcrCredits   int64   `json:"ocr_credits"`
		WalletCents  int64   `json:"wallet_cents"`
		Quantity     *int32  `json:"quantity"`
		DurationDays *int32  `json:"duration_days"`
		ExpiresAt    *string `json:"expires_at"`
		Note         *string `json:"note"`
	}
	if err := dec.Decode(&raw); err != nil {
		return RedeemSpec{}, Validation("VALIDATION", "请求格式无效")
	}
	if raw.MemberSeats == nil || raw.Quantity == nil || raw.DurationDays == nil {
		return RedeemSpec{}, Validation("VALIDATION", "请求格式无效")
	}
	return ValidateRedeemCreate(RedeemDraft{
		Product: raw.Product, MemberSeats: *raw.MemberSeats, Tier: raw.Tier, OcrCredits: raw.OcrCredits,
		WalletCents: raw.WalletCents, Quantity: *raw.Quantity, DurationDays: *raw.DurationDays,
		ExpiresAt: raw.ExpiresAt, Note: raw.Note,
	}, now)
}
