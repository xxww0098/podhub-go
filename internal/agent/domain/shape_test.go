package domain

import (
	"errors"
	"testing"

	"github.com/xxww0098/podhub-go/internal/agent/contract"
)

func TestCommissionShapes(t *testing.T) {
	key := "ledger-1"
	empty := ""
	cases := []struct {
		name   string
		status string
		amount int64
		key    *string
		ok     bool
	}{
		{"credited", CommissionCredited, 1, &key, true},
		{"credited empty key is not nil", CommissionCredited, 1, &empty, true},
		{"credited zero", CommissionCredited, 0, &key, false},
		{"credited nil key", CommissionCredited, 1, nil, false},
		{"skipped", CommissionSkipped, 0, nil, true},
		{"skipped with key", CommissionSkipped, 0, &empty, false},
		{"skipped with amount", CommissionSkipped, 1, nil, false},
		{"unknown", "pending", 0, nil, false},
	}
	for _, tc := range cases {
		err := CommissionShape(tc.status, tc.amount, tc.key)
		if tc.ok && err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		if !tc.ok && !errors.Is(err, contract.ErrInvalidShape) {
			t.Fatalf("%s: %v", tc.name, err)
		}
	}
}

func TestRebateBps(t *testing.T) {
	for _, bps := range []int{0, 1000, 10000} {
		if err := RebateBps(bps); err != nil {
			t.Fatal(bps)
		}
	}
	for _, bps := range []int{-1, 10001} {
		if !errors.Is(RebateBps(bps), contract.ErrInvalidShape) {
			t.Fatal(bps)
		}
	}
}

func TestPayoutComplete(t *testing.T) {
	if err := ValidatePayout(Payout{}); err != nil {
		t.Fatal(err)
	}
	ok := Payout{Channel: "alipay", Account: "a@b.c", RealName: "张三"}
	if err := ValidatePayout(ok); err != nil {
		t.Fatal(err)
	}
	ok.Channel = "wechat"
	if err := ValidatePayout(ok); err != nil {
		t.Fatal(err)
	}
	bad := []Payout{
		{Channel: "alipay"},
		{Account: "a"},
		{Channel: "bank", Account: "a", RealName: "b"},
		{Channel: "alipay", Account: "  ", RealName: "b"},
		{Channel: "alipay", Account: "a", RealName: " "},
	}
	for _, p := range bad {
		if !errors.Is(ValidatePayout(p), contract.ErrInvalidShape) {
			t.Fatalf("%+v", p)
		}
	}
}

func TestInviteCodeAndStatus(t *testing.T) {
	for _, code := range []string{"AB12", "AGENT01", "A2345678901234567890123456789012"} {
		if err := ValidateInviteCode(code); err != nil {
			t.Fatal(code)
		}
	}
	for _, code := range []string{"", "abc", "AB", "ab12", "ABC-1", "has space"} {
		if !errors.Is(ValidateInviteCode(code), contract.ErrInvalidShape) {
			t.Fatal(code)
		}
	}
	if err := ParseAgentStatus("active"); err != nil {
		t.Fatal(err)
	}
	if err := ParseAgentStatus("disabled"); err != nil {
		t.Fatal(err)
	}
	if !errors.Is(ParseAgentStatus("pending"), contract.ErrInvalidShape) {
		t.Fatal("unknown status")
	}
}

func TestAttribution(t *testing.T) {
	agent := int64(7)
	bps := 1000
	if err := Attribute(3, nil, agent, "claim", &bps); err != nil {
		t.Fatal(err)
	}
	if err := Attribute(3, &agent, agent, "register", nil); err != nil {
		t.Fatal(err)
	}
	if !errors.Is(Attribute(3, nil, 3, "claim", nil), contract.ErrSelfInvite) {
		t.Fatal("self")
	}
	other := int64(8)
	if !errors.Is(Attribute(3, &agent, other, "claim", nil), contract.ErrWriteOnce) {
		t.Fatal("rewrite")
	}
	if !errors.Is(Attribute(3, nil, agent, "admin", nil), contract.ErrInvalidShape) {
		t.Fatal("source")
	}
	bad := 10001
	if !errors.Is(Attribute(3, nil, agent, "claim", &bad), contract.ErrInvalidShape) {
		t.Fatal("bps")
	}
	if err := Attribute(3, nil, agent, "", nil); err != nil {
		t.Fatal("null source is allowed by the check")
	}
}
