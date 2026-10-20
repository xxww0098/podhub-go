package domain

import (
	"strings"
	"testing"
	"time"
)

func TestValidateRedeemCreate(t *testing.T) {
	now := time.Date(2026, 10, 17, 1, 2, 3, 0, time.UTC)
	ok, err := ValidateRedeemCreate(RedeemDraft{Product: "member_seats", MemberSeats: 2, Tier: "pro", Quantity: 1, DurationDays: 30}, now)
	if err != nil || ok.PlanKey != "pro" || !ok.NeedsPlan || ok.DurationDays != 30 {
		t.Fatalf("%+v %v", ok, err)
	}
	if !ok.ExpiresAt.Equal(now.Add(30 * 24 * time.Hour)) {
		t.Fatal(ok.ExpiresAt)
	}
	wallet, err := ValidateRedeemCreate(RedeemDraft{Product: " wallet_credits ", WalletCents: 100, Quantity: 2, DurationDays: 99}, now)
	if err != nil || wallet.DurationDays != 1 || wallet.PlanKey != "wallet" || wallet.PlanName != "钱包额度" {
		t.Fatalf("%+v %v", wallet, err)
	}
	bad := []RedeemDraft{
		{Product: "ocr_credits", OcrCredits: 1, Quantity: 1, DurationDays: 1},
		{Product: "member_seats", OcrCredits: 1, MemberSeats: 1, Tier: "pro", Quantity: 1, DurationDays: 1},
		{Product: "member_seats", MemberSeats: 21, Tier: "pro", Quantity: 1, DurationDays: 1},
		{Product: "member_seats", MemberSeats: 1, Tier: "", Quantity: 1, DurationDays: 1},
		{Product: "wallet_credits", WalletCents: 99, Quantity: 1},
		{Product: "wallet_credits", WalletCents: 100, Quantity: 501},
		{Product: "member_seats", MemberSeats: 1, Tier: "max", Quantity: 1, DurationDays: 3651},
	}
	for i, draft := range bad {
		if _, err := ValidateRedeemCreate(draft, now); err == nil {
			t.Fatalf("case %d", i)
		}
	}
	long := strings.Repeat("注", 201)
	if _, err := ValidateRedeemCreate(RedeemDraft{Product: "wallet_credits", WalletCents: 100, Quantity: 1, Note: &long}, now); err == nil || err.Message != "备注不能超过 200 个字符" {
		t.Fatal(err)
	}
}

func TestParseRedeemBodyMatchesValidate(t *testing.T) {
	now := time.Date(2026, 10, 17, 1, 2, 3, 0, time.UTC)
	body := []byte(`{"product":"member_seats","member_seats":2,"tier":"max","quantity":2,"duration_days":45,"expires_at":"2030-06-01T00:00:00Z","note":"批次"}`)
	spec, fault := ParseRedeemBody(body, now)
	if fault != nil {
		t.Fatal(fault)
	}
	note := "批次"
	want, err := ValidateRedeemCreate(RedeemDraft{
		Product: "member_seats", MemberSeats: 2, Tier: "max", Quantity: 2, DurationDays: 45,
		ExpiresAt: strPtr("2030-06-01T00:00:00Z"), Note: &note,
	}, now)
	if err != nil || spec.PlanKey != want.PlanKey || spec.Quantity != want.Quantity || spec.DurationDays != want.DurationDays || !spec.ExpiresAt.Equal(want.ExpiresAt) || spec.Tier != want.Tier || spec.MemberSeats != want.MemberSeats {
		t.Fatalf("spec %+v want %+v err %v", spec, want, err)
	}
	wallet := []byte(`{"product":"wallet_credits","member_seats":0,"quantity":1,"duration_days":30,"wallet_cents":2500}`)
	got, fault := ParseRedeemBody(wallet, now)
	if fault != nil || got.Product != "wallet_credits" || got.DurationDays != 1 || got.WalletCents != 2500 || got.PlanName != "钱包额度" {
		t.Fatalf("%+v %v", got, fault)
	}
	for _, bad := range [][]byte{
		[]byte(`{}`),
		[]byte(`{"extra":1}`),
		[]byte(`{"product":"member_seats","member_seats":1,"tier":"pro","quantity":501,"duration_days":1}`),
		[]byte(`{"product":"member_seats","member_seats":1,"tier":"nope","quantity":1,"duration_days":1}`),
	} {
		if _, fault := ParseRedeemBody(bad, now); fault == nil {
			t.Fatalf("accepted %s", bad)
		}
	}
}

func TestOperationID(t *testing.T) {
	if !OperationID("grant-1") || !OperationID("A_b") {
		t.Fatal("accept")
	}
	for _, bad := range []string{"", "a:b", "has space", strings.Repeat("a", 65), "中"} {
		if OperationID(bad) {
			t.Fatal(bad)
		}
	}
	note := NoteClip("  " + strings.Repeat("字", 201))
	if len([]rune(note)) != 200 {
		t.Fatal(len([]rune(note)))
	}
}
