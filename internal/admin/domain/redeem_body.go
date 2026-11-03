package domain

import (
	"bytes"
	"encoding/json"
	"time"
)

// ParseRedeemBody is the admin create-redeem JSON check plus ValidateRedeemCreate.
// MCP generation uses this function so the quantity, amount, and expiry
// rules stay on the one path the admin HTTP handler already calls.
func ParseRedeemBody(body []byte, now time.Time) (RedeemSpec, *Fault) {
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	var raw struct {
		WalletCents *int64  `json:"wallet_cents"`
		PlanKey     *string `json:"plan_key"`
		PlanStores  *int32  `json:"plan_stores"`
		PlanMonths  *int32  `json:"plan_months"`
		Quantity    *int32  `json:"quantity"`
		ExpiresAt   *string `json:"expires_at"`
		Note        *string `json:"note"`
	}
	if err := dec.Decode(&raw); err != nil {
		return RedeemSpec{}, Validation("VALIDATION", "请求格式无效")
	}
	if raw.Quantity == nil || (raw.WalletCents == nil) == (raw.PlanKey == nil) {
		return RedeemSpec{}, Validation("VALIDATION", "请求格式无效")
	}
	draft := RedeemDraft{
		Quantity:  *raw.Quantity,
		ExpiresAt: raw.ExpiresAt, Note: raw.Note,
	}
	if raw.WalletCents != nil {
		if raw.PlanStores != nil || raw.PlanMonths != nil {
			return RedeemSpec{}, Validation("VALIDATION", "请求格式无效")
		}
		draft.WalletCents = *raw.WalletCents
	} else {
		if raw.PlanStores == nil || raw.PlanMonths == nil {
			return RedeemSpec{}, Validation("VALIDATION", "请求格式无效")
		}
		draft.PlanKey, draft.PlanStores, draft.PlanMonths = *raw.PlanKey, *raw.PlanStores, *raw.PlanMonths
	}
	return ValidateRedeemCreate(draft, now)
}
