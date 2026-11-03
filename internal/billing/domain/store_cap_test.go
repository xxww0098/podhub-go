package domain

import (
	"errors"
	"testing"
	"time"
)

func TestStoreCapAppliesToEveryPaidAction(t *testing.T) {
	cat := DefaultCatalog()
	now := time.Date(2026, 10, 21, 10, 0, 0, 0, Shanghai)
	active := Snapshot{Status: StatusActive, PlanKey: PlanLite, Stores: 5, TermEnd: now.AddDate(0, 0, 10), Anchor: now.AddDate(0, 0, -20)}
	cases := []struct {
		name   string
		action string
		snap   Snapshot
		stores int
		refuse bool
	}{
		{"subscribe at cap", ActionSubscribe, Snapshot{Status: StatusFree, PlanKey: PlanFree}, StoreCap, false},
		{"subscribe over cap", ActionSubscribe, Snapshot{Status: StatusFree, PlanKey: PlanFree}, StoreCap + 1, true},
		{"renew at cap", ActionRenew, active, StoreCap, false},
		{"renew over cap", ActionRenew, active, StoreCap + 1, true},
		{"change at cap", ActionChange, active, StoreCap, false},
		{"change over cap", ActionChange, active, StoreCap + 1, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := Quote(cat, QuoteInput{Now: now, Snapshot: c.snap, Action: c.action,
				Target: Target{PlanKey: PlanLite, Stores: c.stores}, Months: 1})
			var q *QuoteError
			switch {
			case c.refuse && (!errors.As(err, &q) || q.Code != CodeStoreCapExceeded || q.Status != 400):
				t.Fatalf("want %s, got %v", CodeStoreCapExceeded, err)
			case !c.refuse && err != nil:
				t.Fatalf("at the cap must be accepted: %v", err)
			}
		})
	}
}

func TestStoreCapFullPriceAtLimit(t *testing.T) {
	now := time.Date(2026, 10, 1, 9, 30, 0, 0, Shanghai)
	q, err := Quote(DefaultCatalog(), QuoteInput{Now: now, Snapshot: Snapshot{Status: StatusFree, PlanKey: PlanFree},
		Action: ActionSubscribe, Target: Target{PlanKey: PlanMax, Stores: StoreCap}, Months: 1})
	if err != nil {
		t.Fatal(err)
	}
	if q.AmountCents != 100*3000 {
		t.Fatalf("100 max stores for one month = %d, want 300000", q.AmountCents)
	}
	if want := time.Date(2026, 11, 1, 9, 30, 0, 0, Shanghai); !q.TermEnd.Equal(want) {
		t.Fatalf("bought 10-01, renews %v, want %v", q.TermEnd, want)
	}
}
