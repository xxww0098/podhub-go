package domain

import (
	"strings"
	"time"
	"unicode/utf8"
)

// RedeemDraft is a create request after JSON decode. Zero values are the serde defaults.
type RedeemDraft struct {
	Product      string
	MemberSeats  int64
	Tier         string
	OcrCredits   int64
	WalletCents  int64
	Quantity     int32
	DurationDays int32
	ExpiresAt    *string
	Note         *string
}

// ValidateRedeemCreate checks the body before the writer gate.
// A nil fault with NeedsPlan means the caller must load plans.key = PlanKey.
func ValidateRedeemCreate(in RedeemDraft, now time.Time) (RedeemSpec, *Fault) {
	product := strings.TrimSpace(in.Product)
	if product != "member_seats" && product != "wallet_credits" {
		return RedeemSpec{}, Validation("VALIDATION", "兑换码产品类型无效")
	}
	if in.OcrCredits != 0 {
		return RedeemSpec{}, Validation("VALIDATION", "识别额度兑换码已停止发放")
	}
	spec := RedeemSpec{Product: product, OcrCredits: 0}
	if product == "member_seats" {
		if in.MemberSeats < 1 || in.MemberSeats > 20 {
			return RedeemSpec{}, Validation("VALIDATION", "成员名额需在 1-20 之间")
		}
		tier := tierKey(in.Tier)
		if tier != "pro" && tier != "max" && tier != "ultra" {
			return RedeemSpec{}, Validation("VALIDATION", "成员名额档位无效")
		}
		spec.MemberSeats = in.MemberSeats
		spec.Tier = tier
		spec.PlanKey = tier
		spec.NeedsPlan = true
		spec.DurationDays = in.DurationDays
	} else {
		if in.WalletCents < 100 || in.WalletCents > 1_000_000 {
			return RedeemSpec{}, Validation("VALIDATION", "钱包额度需在 ¥1-¥10000 之间")
		}
		spec.PlanKey = "wallet"
		spec.PlanName = "钱包额度"
		spec.WalletCents = in.WalletCents
		spec.DurationDays = 1
	}
	if in.Quantity < 1 || in.Quantity > 500 {
		return RedeemSpec{}, Validation("VALIDATION", "兑换码数量需在 1-500 之间")
	}
	spec.Quantity = in.Quantity
	if product == "member_seats" && (in.DurationDays < 1 || in.DurationDays > 3650) {
		return RedeemSpec{}, Validation("VALIDATION", "有效期需在 1-3650 天之间")
	}
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

func tierKey(raw string) string {
	switch strings.TrimSpace(raw) {
	case "pro", "max", "ultra":
		return strings.TrimSpace(raw)
	default:
		return "lite"
	}
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
