package domain

import (
	"strings"
	"testing"
	"time"
)

func TestValidateRedeemCreate(t *testing.T) {
	now := time.Date(2026, 10, 17, 1, 2, 3, 0, time.UTC)
	wallet, err := ValidateRedeemCreate(RedeemDraft{WalletCents: 100, Quantity: 2}, now)
	if err != nil || wallet.WalletCents != 100 || wallet.Quantity != 2 || !wallet.ExpiresAt.Equal(now.Add(30*24*time.Hour)) {
		t.Fatalf("%+v %v", wallet, err)
	}
	bad := []RedeemDraft{
		{WalletCents: 99, Quantity: 1},
		{WalletCents: 1_000_001, Quantity: 1},
		{WalletCents: 100, Quantity: 0},
		{WalletCents: 100, Quantity: 501},
	}
	for i, draft := range bad {
		if _, err := ValidateRedeemCreate(draft, now); err == nil {
			t.Fatalf("case %d", i)
		}
	}
	long := strings.Repeat("注", 201)
	if _, err := ValidateRedeemCreate(RedeemDraft{WalletCents: 100, Quantity: 1, Note: &long}, now); err == nil || err.Message != "备注不能超过 200 个字符" {
		t.Fatal(err)
	}
}

func TestParseRedeemBodyMatchesValidate(t *testing.T) {
	now := time.Date(2026, 10, 17, 1, 2, 3, 0, time.UTC)
	body := []byte(`{"wallet_cents":2500,"quantity":2,"expires_at":"2030-06-01T00:00:00Z","note":"批次"}`)
	got, fault := ParseRedeemBody(body, now)
	if fault != nil || got.WalletCents != 2500 || got.Quantity != 2 || got.Note == nil || *got.Note != "批次" ||
		!got.ExpiresAt.Equal(time.Date(2030, 6, 1, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("%+v %v", got, fault)
	}
	for _, bad := range [][]byte{
		[]byte(`{}`),
		[]byte(`{"extra":1}`),
		[]byte(`{"wallet_cents":2500}`),
		[]byte(`{"quantity":1}`),
		[]byte(`{"wallet_cents":2500,"quantity":501}`),
		[]byte(`{"product":"wallet_credits","wallet_cents":2500,"quantity":1}`),
		[]byte(`{"member_seats":1,"wallet_cents":2500,"quantity":1}`),
	} {
		if _, fault := ParseRedeemBody(bad, now); fault == nil {
			t.Fatalf("accepted %s", bad)
		}
	}
}

func TestParsePlanRedeemBody(t *testing.T) {
	now := time.Now()
	got, fault := ParseRedeemBody([]byte(`{"plan_key":"pro","plan_stores":3,"plan_months":6,"quantity":2}`), now)
	if fault != nil || got.PlanKey != "pro" || got.PlanStores != 3 || got.PlanMonths != 6 || got.WalletCents != 0 {
		t.Fatalf("plan: %+v %v", got, fault)
	}
	for _, body := range []string{
		`{"plan_key":"free","plan_stores":1,"plan_months":1,"quantity":1}`,
		`{"plan_key":"pro","plan_stores":0,"plan_months":1,"quantity":1}`,
		`{"plan_key":"pro","plan_stores":101,"plan_months":1,"quantity":1}`,
		`{"plan_key":"pro","plan_stores":1,"plan_months":2,"quantity":1}`,
		`{"plan_key":"pro","plan_stores":1,"quantity":1}`,
		`{"plan_key":"pro","plan_stores":1,"plan_months":1,"wallet_cents":100,"quantity":1}`,
		`{"wallet_cents":100,"plan_stores":1,"quantity":1}`,
	} {
		if _, fault := ParseRedeemBody([]byte(body), now); fault == nil {
			t.Fatalf("accepted %s", body)
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
