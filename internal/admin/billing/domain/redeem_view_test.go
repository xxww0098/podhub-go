package domain

import (
	"testing"
	"time"
)

func TestRedeemStatusPriority(t *testing.T) {
	past := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
	future := time.Date(2099, 1, 1, 0, 0, 0, 0, time.UTC)
	now := time.Date(2026, 10, 17, 0, 0, 0, 0, time.UTC)
	cases := []struct {
		name    string
		revoked bool
		used    bool
		expires *time.Time
		want    string
	}{
		{"revoked wins over used", true, true, &past, "revoked"},
		{"used", false, true, &past, "redeemed"},
		{"expired", false, false, &past, "expired"},
		{"exact now is expired", false, false, &now, "expired"},
		{"future", false, false, &future, "unused"},
		{"unparsed deadline", false, false, nil, "unused"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := RedeemStatus(tc.revoked, tc.used, tc.expires, now); got != tc.want {
				t.Fatalf("got %s", got)
			}
		})
	}
}

func TestCodePreview(t *testing.T) {
	if CodePreview("POD-PLAN-ABCD") != "••••-ABCD" {
		t.Fatal(CodePreview("POD-PLAN-ABCD"))
	}
	if CodeTail("POD-PLAN-ABCD") != "ABCD" {
		t.Fatal(CodeTail("POD-PLAN-ABCD"))
	}
	if CodePreview("花") != "••••-花" {
		t.Fatal(CodePreview("花"))
	}
}
