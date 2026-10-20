package domain

import (
	"errors"
	"testing"
	"time"
)

func freeSnapshot() Snapshot { return Snapshot{Status: StatusFree} }

func activeSnapshot(plan string, stores, members int, end time.Time) Snapshot {
	return Snapshot{
		Status: StatusActive, PlanKey: plan,
		ExtraStores: stores, ExtraMembers: members, TermEnd: end,
	}
}

func quote(t *testing.T, in QuoteInput) Quotation {
	t.Helper()
	q, err := Quote(DefaultCatalog(), in)
	if err != nil {
		t.Fatalf("Quote: %v", err)
	}
	return q
}

func quoteErrCode(t *testing.T, in QuoteInput) string {
	t.Helper()
	_, err := Quote(DefaultCatalog(), in)
	var qe *QuoteError
	if !errors.As(err, &qe) {
		t.Fatalf("want QuoteError, got %v", err)
	}
	return qe.Code
}

// Every row of docs/architecture/subscription-billing.md §示例.
func TestDocExamples(t *testing.T) {
	oct := sh(2026, 10, 15, 0, 0, 0)
	nov := sh(2026, 11, 1, 0, 0, 0)
	cases := []struct {
		name string
		in   QuoteInput
		want int64
	}{
		{
			"10-15 subscribe lite 1 month",
			QuoteInput{Now: oct, Snapshot: freeSnapshot(), Action: ActionSubscribe,
				Target: Target{PlanKey: PlanLite}, Months: 1},
			5484,
		},
		{
			"10-15 subscribe lite 3 months",
			QuoteInput{Now: oct, Snapshot: freeSnapshot(), Action: ActionSubscribe,
				Target: Target{PlanKey: PlanLite}, Months: 3},
			5484 + 10000*2,
		},
		{
			"10-15 one extra store",
			QuoteInput{Now: oct, Snapshot: activeSnapshot(PlanLite, 0, 0, nov), Action: ActionChange,
				Target: Target{PlanKey: PlanLite, ExtraStores: 1}, Months: 1},
			1097,
		},
		{
			"10-31 25 extra stores",
			QuoteInput{Now: sh(2026, 10, 31, 0, 0, 0), Snapshot: activeSnapshot(PlanLite, 0, 0, nov), Action: ActionChange,
				Target: Target{PlanKey: PlanLite, ExtraStores: 25}, Months: 1},
			1613,
		},
		{
			"10-15 lite to pro keeps add-ons",
			QuoteInput{Now: oct, Snapshot: activeSnapshot(PlanLite, 2, 0, nov), Action: ActionChange,
				Target: Target{PlanKey: PlanPro, ExtraStores: 2}, Months: 1},
			27419,
		},
		{
			"lite plus 2 stores renewed 3 months",
			QuoteInput{Now: oct, Snapshot: activeSnapshot(PlanLite, 2, 0, nov), Action: ActionRenew, Months: 3},
			42000,
		},
		{
			"10-31 23:59 subscribe 1 month",
			QuoteInput{Now: sh(2026, 10, 31, 23, 59, 50), Snapshot: freeSnapshot(), Action: ActionSubscribe,
				Target: Target{PlanKey: PlanLite}, Months: 1},
			10000,
		},
		{
			"10-31 12:00 subscribe 1 month",
			QuoteInput{Now: sh(2026, 10, 31, 12, 0, 0), Snapshot: freeSnapshot(), Action: ActionSubscribe,
				Target: Target{PlanKey: PlanLite}, Months: 1},
			10000,
		},
		{
			"10-30 12:00 subscribe 1 month",
			QuoteInput{Now: sh(2026, 10, 30, 12, 0, 0), Snapshot: freeSnapshot(), Action: ActionSubscribe,
				Target: Target{PlanKey: PlanLite}, Months: 1},
			645,
		},
	}
	for _, c := range cases {
		if got := quote(t, c.in).AmountCents; got != c.want {
			t.Fatalf("%s: %d, want %d", c.name, got, c.want)
		}
	}
}

func TestSubscribeTerms(t *testing.T) {
	// Mid-month: term starts now, ends at the boundary plus the whole months
	// after the stub.
	q := quote(t, QuoteInput{Now: sh(2026, 10, 15, 0, 0, 0), Snapshot: freeSnapshot(),
		Action: ActionSubscribe, Target: Target{PlanKey: PlanLite}, Months: 3})
	if !q.TermStart.Equal(sh(2026, 10, 15, 0, 0, 0)) {
		t.Fatalf("term start %s", q.TermStart)
	}
	if !q.TermEnd.Equal(sh(2027, 1, 1, 0, 0, 0)) {
		t.Fatalf("term end %s", q.TermEnd)
	}
	// Under a day left: the term starts on the 1st and buys whole months, so
	// nobody pays for ten seconds.
	q = quote(t, QuoteInput{Now: sh(2026, 10, 31, 23, 59, 50), Snapshot: freeSnapshot(),
		Action: ActionSubscribe, Target: Target{PlanKey: PlanLite}, Months: 3})
	if !q.TermStart.Equal(sh(2026, 11, 1, 0, 0, 0)) || !q.TermEnd.Equal(sh(2027, 2, 1, 0, 0, 0)) {
		t.Fatalf("stub-free term %s..%s", q.TermStart, q.TermEnd)
	}
	// Every quoted term_end is a Shanghai month boundary.
	for _, now := range []time.Time{
		sh(2026, 1, 1, 0, 0, 0), sh(2026, 2, 28, 23, 0, 0), sh(2026, 12, 31, 23, 0, 0),
		sh(2028, 2, 29, 10, 0, 0),
	} {
		q := quote(t, QuoteInput{Now: now, Snapshot: freeSnapshot(),
			Action: ActionSubscribe, Target: Target{PlanKey: PlanPro}, Months: 6})
		if !OnMonthStart(q.TermEnd) {
			t.Fatalf("%s: term end %s is not a month start", now, q.TermEnd)
		}
	}
}

// A second free workspace is impossible; a free target is refused outright.
func TestFreeTargetRefused(t *testing.T) {
	if code := quoteErrCode(t, QuoteInput{Now: time.Now(), Snapshot: freeSnapshot(),
		Action: ActionSubscribe, Target: Target{PlanKey: PlanFree}, Months: 1}); code != CodeValidation {
		t.Fatalf("free target: %s", code)
	}
	if code := quoteErrCode(t, QuoteInput{Now: time.Now(), Snapshot: freeSnapshot(),
		Action: ActionSubscribe, Target: Target{PlanKey: "ultra"}, Months: 1}); code != CodeValidation {
		t.Fatalf("unknown plan: %s", code)
	}
}

func TestMonthsWhitelist(t *testing.T) {
	for _, months := range []int{0, 2, 4, 5, 7, 11, 13, 24} {
		if code := quoteErrCode(t, QuoteInput{Now: time.Now(), Snapshot: freeSnapshot(),
			Action: ActionSubscribe, Target: Target{PlanKey: PlanLite}, Months: months}); code != CodeValidation {
			t.Fatalf("%d months accepted", months)
		}
	}
}

func TestRenewalUsesSchedule(t *testing.T) {
	end := sh(2026, 11, 1, 0, 0, 0)
	// No schedule: current capacity.
	s := activeSnapshot(PlanPro, 3, 2, end)
	if got := quote(t, QuoteInput{Now: sh(2026, 10, 15, 0, 0, 0), Snapshot: s, Action: ActionRenew, Months: 1}).AmountCents; got != 60000+3*2000+2*3000 {
		t.Fatalf("renewal without schedule: %d", got)
	}
	// Scheduled downgrade: next_* wins, and the term still starts at term_end.
	s.NextPlanKey, s.NextExtraStores, s.NextExtraMembers = PlanLite, 0, 0
	q := quote(t, QuoteInput{Now: sh(2026, 10, 15, 0, 0, 0), Snapshot: s, Action: ActionRenew, Months: 1})
	if q.AmountCents != 10000 {
		t.Fatalf("scheduled renewal: %d", q.AmountCents)
	}
	if !q.TermStart.Equal(end) || !q.TermEnd.Equal(sh(2026, 12, 1, 0, 0, 0)) {
		t.Fatalf("scheduled term %s..%s", q.TermStart, q.TermEnd)
	}
	if q.PlanKey != PlanLite {
		t.Fatalf("scheduled plan %s", q.PlanKey)
	}
}

func TestChangeRefusals(t *testing.T) {
	now := sh(2026, 10, 15, 0, 0, 0)
	// Expired: renew first.
	if code := quoteErrCode(t, QuoteInput{Now: now, Snapshot: Snapshot{Status: StatusExpired,
		PlanKey: PlanLite, TermEnd: sh(2026, 10, 1, 0, 0, 0)}, Action: ActionChange,
		Target: Target{PlanKey: PlanLite, ExtraStores: 1}, Months: 1}); code != CodeRenewRequired {
		t.Fatalf("expired change: %s", code)
	}
	// Target below the keep list.
	if code := quoteErrCode(t, QuoteInput{Now: now,
		Snapshot: activeSnapshot(PlanPro, 0, 0, sh(2026, 11, 1, 0, 0, 0)), Action: ActionChange,
		Target: Target{PlanKey: PlanLite}, Months: 1, KeepStores: 6}); code != CodeCapacityBelowUsage {
		t.Fatalf("below usage: %s", code)
	}
	// Already active: subscribe is stale, not a second sale.
	if code := quoteErrCode(t, QuoteInput{Now: now,
		Snapshot: activeSnapshot(PlanLite, 0, 0, sh(2026, 11, 1, 0, 0, 0)), Action: ActionSubscribe,
		Target: Target{PlanKey: PlanPro}, Months: 1}); code != CodeQuoteStale {
		t.Fatalf("active subscribe: %s", code)
	}
	// Pro without add-ons to max without add-ons is an upgrade, not a zero
	// change; max to pro with an equal extra store count is a reduction and
	// must not create an order.
	q := quote(t, QuoteInput{Now: now,
		Snapshot: activeSnapshot(PlanMax, 0, 0, sh(2026, 11, 1, 0, 0, 0)), Action: ActionChange,
		Target: Target{PlanKey: PlanPro}, Months: 1, KeepStores: 1})
	if q.AmountCents != 0 || !q.ScheduleOnly {
		t.Fatalf("downgrade: %+v", q)
	}
}

func TestChangeKeepsAddonsAndChargesOnlyIncreases(t *testing.T) {
	now := sh(2026, 10, 15, 0, 0, 0)
	end := sh(2026, 11, 1, 0, 0, 0)
	// lite + 25 stores to pro + 25 stores: only the plan delta is charged.
	q := quote(t, QuoteInput{Now: now, Snapshot: activeSnapshot(PlanLite, 25, 0, end), Action: ActionChange,
		Target: Target{PlanKey: PlanPro, ExtraStores: 25}, Months: 1})
	if q.AmountCents != 27419 {
		t.Fatalf("upgrade with add-ons: %d", q.AmountCents)
	}
	// Reducing stores while upgrading is free; the increase side is the plan.
	q = quote(t, QuoteInput{Now: now, Snapshot: activeSnapshot(PlanLite, 5, 0, end), Action: ActionChange,
		Target: Target{PlanKey: PlanPro, ExtraStores: 2}, Months: 1})
	if q.AmountCents != 27419 {
		t.Fatalf("upgrade with reduction: %d", q.AmountCents)
	}
	// Both an upgrade and an add-on: one rounding over the sum.
	q = quote(t, QuoteInput{Now: now, Snapshot: activeSnapshot(PlanLite, 0, 0, end), Action: ActionChange,
		Target: Target{PlanKey: PlanPro, ExtraStores: 1}, Months: 1})
	want := Prorate(50000+2000, now, end)
	if q.AmountCents != want {
		t.Fatalf("combined change: %d, want %d", q.AmountCents, want)
	}
}

func TestChangeKeepsTerm(t *testing.T) {
	end := sh(2026, 11, 1, 0, 0, 0)
	q := quote(t, QuoteInput{Now: sh(2026, 10, 15, 0, 0, 0),
		Snapshot: activeSnapshot(PlanLite, 0, 0, end), Action: ActionChange,
		Target: Target{PlanKey: PlanPro}, Months: 1})
	if !q.TermStart.Equal(end) || !q.TermEnd.Equal(end) {
		t.Fatalf("change moved the term: %s..%s", q.TermStart, q.TermEnd)
	}
}

func TestBaseAlwaysIncludesAddons(t *testing.T) {
	// The v1 sample charged 100 × 3 for a lite workspace with two extra
	// stores. base() must include them.
	cat := DefaultCatalog()
	base, err := cat.Base(PlanLite, 2, 0)
	if err != nil || base != 14000 {
		t.Fatalf("base %d %v", base, err)
	}
	if _, err := cat.Base(PlanFree, 1, 0); err == nil {
		t.Fatal("free add-on accepted")
	}
}
