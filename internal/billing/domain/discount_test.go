package domain

import (
	"math"
	"testing"
)

func TestSubscriptionDiscounts(t *testing.T) {
	now := sh(2026, 10, 31, 10, 0, 0)
	for _, action := range []string{ActionSubscribe, ActionRenew} {
		for _, tc := range []struct {
			months, percent int
			want            int64
		}{
			{1, 0, 30000}, {3, 0, 90000}, {6, 0, 180000}, {12, 0, 288000},
			{1, 10, 27000}, {12, 10, 259200}, {12, 99, 2880},
		} {
			in := QuoteInput{Now: now, Action: action, Months: tc.months, Target: Target{PlanKey: PlanMax, Stores: 10}, CouponPercent: tc.percent}
			if action == ActionRenew {
				in.Snapshot = activeSnapshot(PlanLite, 10, TermEnd(now, 1))
			}
			if tc.percent > 0 {
				in.CouponCode = "TEAM10"
			}
			q := quote(t, in)
			if q.AmountCents != tc.want {
				t.Fatalf("%s %d months %d%%: got %d, want %d", action, tc.months, tc.percent, q.AmountCents, tc.want)
			}
			var sum int64
			for _, line := range q.Breakdown {
				sum += line.Cents
			}
			if sum != q.AmountCents {
				t.Fatalf("breakdown %d != payable %d", sum, q.AmountCents)
			}
		}
	}
}

func TestDiscountRoundingAndOverflow(t *testing.T) {
	if got := percentOff(101, 50); got != 51 {
		t.Fatalf("half fen must round up: %d", got)
	}
	if got := percentOff(math.MaxInt64, 20); got != 7378697629483820646 {
		t.Fatalf("large discount overflow: %d", got)
	}
	now := sh(2026, 10, 31, 10, 0, 0)
	in := QuoteInput{Now: now, Action: ActionChange, Months: 12, Snapshot: activeSnapshot(PlanLite, 1, TermEnd(now, 1)), Target: Target{PlanKey: PlanPro, Stores: 1}}
	q := quote(t, in)
	for _, line := range q.Breakdown {
		if line.Label == "年付 8 折" {
			t.Fatal("a change cannot claim an annual discount")
		}
	}
	in.CouponCode, in.CouponPercent = "TEAM10", 10
	if got := quoteErrCode(t, in); got != CodeValidation {
		t.Fatal(got)
	}
}
