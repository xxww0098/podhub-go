package domain

import (
	"strings"
	"time"
	"unicode/utf8"
)

// RedeemDraft is a create request after JSON decode.
type RedeemDraft struct {
	WalletCents int64
	PlanKey     string
	PlanStores  int32
	PlanMonths  int32
	Quantity    int32
	ExpiresAt   *string
	Note        *string
}

// ValidateRedeemCreate checks the body before the writer gate.
func ValidateRedeemCreate(in RedeemDraft, now time.Time) (RedeemSpec, *Fault) {
	if in.PlanKey == "" {
		if in.WalletCents < 100 || in.WalletCents > 1_000_000 {
			return RedeemSpec{}, Validation("VALIDATION", "钱包额度需在 ¥1-¥10000 之间")
		}
	} else if in.WalletCents != 0 || (in.PlanKey != "lite" && in.PlanKey != "pro" && in.PlanKey != "max") ||
		in.PlanStores < 1 || in.PlanStores > 100 ||
		(in.PlanMonths != 1 && in.PlanMonths != 3 && in.PlanMonths != 6 && in.PlanMonths != 12) {
		return RedeemSpec{}, Validation("VALIDATION", "套餐、店铺数量或有效月数无效")
	}
	spec := RedeemSpec{WalletCents: in.WalletCents, PlanKey: in.PlanKey, PlanStores: in.PlanStores, PlanMonths: in.PlanMonths}
	if in.Quantity < 1 || in.Quantity > 500 {
		return RedeemSpec{}, Validation("VALIDATION", "兑换码数量需在 1-500 之间")
	}
	spec.Quantity = in.Quantity
	if in.Note != nil {
		note := strings.TrimSpace(*in.Note)
		if utf8.RuneCountInString(note) > 200 {
			return RedeemSpec{}, Validation("VALIDATION", "备注不能超过 200 个字符")
		}
		if note != "" {
			spec.Note = &note
		}
	}
	if in.ExpiresAt != nil && strings.TrimSpace(*in.ExpiresAt) != "" {
		deadline, err := time.Parse(time.RFC3339, strings.TrimSpace(*in.ExpiresAt))
		if err != nil {
			return RedeemSpec{}, Validation("VALIDATION", "兑换截止时间格式无效")
		}
		if !deadline.After(now) {
			return RedeemSpec{}, Validation("VALIDATION", "兑换截止时间必须晚于当前时间")
		}
		spec.ExpiresAt = deadline
	} else {
		spec.ExpiresAt = now.Add(30 * 24 * time.Hour)
	}
	return spec, nil
}

// OperationID is the wallet top-up key alphabet.
func OperationID(raw string) bool {
	if raw == "" || len(raw) > 64 {
		return false
	}
	for _, r := range raw {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
		default:
			return false
		}
	}
	return true
}

// NoteClip keeps the first 200 Unicode scalars after trim.
func NoteClip(raw string) string {
	raw = strings.TrimSpace(raw)
	runes := []rune(raw)
	if len(runes) > 200 {
		runes = runes[:200]
	}
	return string(runes)
}
