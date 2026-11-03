package domain

import (
	"errors"
	"testing"
	"time"
)

func freeSnapshot() Snapshot { return Snapshot{Status: StatusFree} }

func activeSnapshot(plan string, stores int, end time.Time) Snapshot {
	return Snapshot{Status: StatusActive, PlanKey: plan, Stores: stores, TermEnd: end}
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

func TestDocExamples(t *testing.T) {
	oct := sh(2026, 10, 15, 0, 0, 0)
	nov := sh(2026, 11, 1, 0, 0, 0)
	cases := []struct {
		name string
		in   QuoteInput
		want int64
	}{
		{
			"subscribe lite 5 stores, 1 month",
			QuoteInput{Now: oct, Snapshot: freeSnapshot(), Action: ActionSubscribe,
				Target: Target{PlanKey: PlanLite, Stores: 5}, Months: 1},
			10000,
		},
		{
			"subscribe lite 5 stores, 3 months, no discount",
			QuoteInput{Now: oct, Snapshot: freeSnapshot(), Action: ActionSubscribe,
				Target: Target{PlanKey: PlanLite, Stores: 5}, Months: 3},
			30000,
		},
		{
			"store price rises with the plan",
			QuoteInput{Now: oct, Snapshot: freeSnapshot(), Action: ActionSubscribe,
				Target: Target{PlanKey: PlanMax, Stores: 10}, Months: 1},
			10 * 3000,
		},
		{
			"10-15 one more store",
			QuoteInput{Now: oct, Snapshot: activeSnapshot(PlanLite, 5, nov), Action: ActionChange,
				Target: Target{PlanKey: PlanLite, Stores: 6}, Months: 1},
			1097,
		},
		{
			"10-31 25 more stores",
			QuoteInput{Now: sh(2026, 10, 31, 0, 0, 0), Snapshot: activeSnapshot(PlanLite, 5, nov), Action: ActionChange,
				Target: Target{PlanKey: PlanLite, Stores: 30}, Months: 1},
			1613,
		},
		{
			"lite to pro charges only the unit price difference",
			QuoteInput{Now: oct, Snapshot: activeSnapshot(PlanLite, 7, nov), Action: ActionChange,
				Target: Target{PlanKey: PlanPro, Stores: 7}, Months: 1},
			Prorate(7*(2500-2000), oct, nov),
		},
		{
			"lite renewed 3 months at 7 stores",
			QuoteInput{Now: oct, Snapshot: activeSnapshot(PlanLite, 7, nov), Action: ActionRenew,
				Target: Target{PlanKey: PlanLite, Stores: 7}, Months: 3},
			3 * 7 * 2000,
		},
	}
	for _, c := range cases {
		if got := quote(t, c.in).AmountCents; got != c.want {
			t.Fatalf("%s: %d, want %d", c.name, got, c.want)
		}
	}
}

func TestSubscribeTerms(t *testing.T) {
	target := Target{PlanKey: PlanLite, Stores: 5}
	// Every purchase starts now and buys whole anniversary months.
	q := quote(t, QuoteInput{Now: sh(2026, 10, 15, 0, 0, 0), Snapshot: freeSnapshot(),
		Action: ActionSubscribe, Target: target, Months: 3})
	if !q.TermStart.Equal(sh(2026, 10, 15, 0, 0, 0)) {
		t.Fatalf("term start %s", q.TermStart)
	}
	if !q.TermEnd.Equal(sh(2027, 1, 15, 0, 0, 0)) {
		t.Fatalf("term end %s", q.TermEnd)
	}
	// A purchase at month end starts immediately and retains its clock time.
	q = quote(t, QuoteInput{Now: sh(2026, 10, 31, 23, 59, 50), Snapshot: freeSnapshot(),
		Action: ActionSubscribe, Target: target, Months: 3})
	if !q.TermStart.Equal(sh(2026, 10, 31, 23, 59, 50)) || !q.TermEnd.Equal(sh(2027, 1, 31, 23, 59, 50)) {
		t.Fatalf("stub-free term %s..%s", q.TermStart, q.TermEnd)
	}
	// Every quoted term_end is anchored to the purchase date.
	for _, now := range []time.Time{
		sh(2026, 1, 1, 0, 0, 0), sh(2026, 2, 28, 23, 0, 0), sh(2026, 12, 31, 23, 0, 0),
		sh(2028, 2, 29, 10, 0, 0),
	} {
		q := quote(t, QuoteInput{Now: now, Snapshot: freeSnapshot(),
			Action: ActionSubscribe, Target: Target{PlanKey: PlanPro, Stores: 5}, Months: 6})
		if !q.TermEnd.Equal(TermEnd(now, 6)) {
			t.Fatalf("%s: term end %s is not a month start", now, q.TermEnd)
		}
	}
}

// A second free workspace is impossible; a free target is refused outright.
func TestSubscribeTargetRefusals(t *testing.T) {
	for name, target := range map[string]Target{
		"free plan":     {PlanKey: PlanFree, Stores: 1},
		"unknown plan":  {PlanKey: "ultra", Stores: 1},
		"zero stores":   {PlanKey: PlanLite, Stores: 0},
		"negative size": {PlanKey: PlanLite, Stores: -1},
	} {
		if code := quoteErrCode(t, QuoteInput{Now: time.Now(), Snapshot: freeSnapshot(),
			Action: ActionSubscribe, Target: target, Months: 1}); code != CodeValidation {
			t.Fatalf("%s: %s", name, code)
		}
	}
}

func TestMonthsWhitelist(t *testing.T) {
	for _, months := range []int{0, 2, 4, 5, 7, 11, 13, 24} {
		if code := quoteErrCode(t, QuoteInput{Now: time.Now(), Snapshot: freeSnapshot(),
			Action: ActionSubscribe, Target: Target{PlanKey: PlanLite, Stores: 5}, Months: months}); code != CodeValidation {
			t.Fatalf("%d months accepted", months)
		}
	}
}

// A renewal is sold at the capacity the client names, so lowering plan or
// stores is just renewing smaller; the term still starts at term_end.
func TestRenewalSellsTheNamedCapacity(t *testing.T) {
	end := sh(2026, 11, 1, 0, 0, 0)
	s := activeSnapshot(PlanPro, 3, end)
	now := sh(2026, 10, 15, 0, 0, 0)
	same := quote(t, QuoteInput{Now: now, Snapshot: s, Action: ActionRenew, Target: Target{PlanKey: PlanPro, Stores: 3}, Months: 1})
	if same.AmountCents != 3*2500 {
		t.Fatalf("renew as is: %d", same.AmountCents)
	}
	q := quote(t, QuoteInput{Now: now, Snapshot: s, Action: ActionRenew, Target: Target{PlanKey: PlanLite, Stores: 1}, Months: 1})
	if q.AmountCents != 2000 || q.PlanKey != PlanLite || q.Stores != 1 {
		t.Fatalf("renew smaller: %+v", q)
	}
	if !q.TermStart.Equal(end) || !q.TermEnd.Equal(sh(2026, 12, 1, 0, 0, 0)) {
		t.Fatalf("renewal term %s..%s", q.TermStart, q.TermEnd)
	}
	if code := quoteErrCode(t, QuoteInput{Now: now, Snapshot: s, Action: ActionRenew, Target: Target{PlanKey: PlanLite, Stores: 3}, Months: 1, KeepStores: 4}); code != CodeCapacityBelowUsage {
		t.Fatalf("renew below keep list: %s", code)
	}
	if code := quoteErrCode(t, QuoteInput{Now: now, Snapshot: s, Action: ActionRenew, Target: Target{PlanKey: PlanFree, Stores: 1}, Months: 1}); code != CodeValidation {
		t.Fatalf("renew to free: %s", code)
	}
}

func TestChangeRefusals(t *testing.T) {
	now := sh(2026, 10, 15, 0, 0, 0)
	// Expired: renew first.
	if code := quoteErrCode(t, QuoteInput{Now: now, Snapshot: Snapshot{Status: StatusExpired,
		PlanKey: PlanLite, TermEnd: sh(2026, 10, 1, 0, 0, 0)}, Action: ActionChange,
		Target: Target{PlanKey: PlanLite, Stores: 6}, Months: 1}); code != CodeRenewRequired {
		t.Fatalf("expired change: %s", code)
	}
	// Target below the keep list.
	if code := quoteErrCode(t, QuoteInput{Now: now,
		Snapshot: activeSnapshot(PlanPro, 30, sh(2026, 11, 1, 0, 0, 0)), Action: ActionChange,
		Target: Target{PlanKey: PlanLite, Stores: 5}, Months: 1, KeepStores: 6}); code != CodeCapacityBelowUsage {
		t.Fatalf("below usage: %s", code)
	}
	// Already active: subscribe is stale, not a second sale.
	if code := quoteErrCode(t, QuoteInput{Now: now,
		Snapshot: activeSnapshot(PlanLite, 5, sh(2026, 11, 1, 0, 0, 0)), Action: ActionSubscribe,
		Target: Target{PlanKey: PlanPro, Stores: 5}, Months: 1}); code != CodeQuoteStale {
		t.Fatalf("active subscribe: %s", code)
	}
}

// A change only raises capacity. A target that raises nothing is refused, so
// a reduction can only happen by renewing smaller.
func TestChangeThatRaisesNothingIsRefused(t *testing.T) {
	now := sh(2026, 10, 15, 0, 0, 0)
	end := sh(2026, 11, 1, 0, 0, 0)
	for name, target := range map[string]Target{
		"lower plan":   {PlanKey: PlanPro, Stores: 10},
		"fewer stores": {PlanKey: PlanMax, Stores: 5},
		"same":         {PlanKey: PlanMax, Stores: 10},
	} {
		if code := quoteErrCode(t, QuoteInput{Now: now,
			Snapshot: activeSnapshot(PlanMax, 10, end), Action: ActionChange,
			Target: target, Months: 1, KeepStores: 1}); code != CodeNothingToChange {
			t.Fatalf("%s: %s", name, code)
		}
	}
}

// The same capacity costs the same whichever way it was reached, so an upgrade
// never charges for capacity already paid.
func TestChangeNeverChargesPaidCapacityTwice(t *testing.T) {
	now := sh(2026, 10, 15, 0, 0, 0)
	end := sh(2026, 11, 1, 0, 0, 0)
	// lite with 25 stores to pro with 25 stores: only the unit difference.
	q := quote(t, QuoteInput{Now: now, Snapshot: activeSnapshot(PlanLite, 25, end), Action: ActionChange,
		Target: Target{PlanKey: PlanPro, Stores: 25}, Months: 1})
	if want := Prorate(25*500, now, end); q.AmountCents != want {
		t.Fatalf("upgrade with the same stores: %d, want %d", q.AmountCents, want)
	}
	// Upgrade and growth together: one rounding over the sum of both.
	q = quote(t, QuoteInput{Now: now, Snapshot: activeSnapshot(PlanLite, 5, end), Action: ActionChange,
		Target: Target{PlanKey: PlanPro, Stores: 6}, Months: 1})
	if want := Prorate(6*2500-5*2000, now, end); q.AmountCents != want {
		t.Fatalf("combined change: %d, want %d", q.AmountCents, want)
	}
}

// A lower-ranked target never shrinks or reprices a running period: extra
// stores are charged at the unit price the period already pays.
func TestLowerPlanTargetKeepsPeriodPlan(t *testing.T) {
	now := sh(2026, 10, 15, 0, 0, 0)
	end := sh(2026, 11, 1, 0, 0, 0)
	q := quote(t, QuoteInput{Now: now, Snapshot: activeSnapshot(PlanPro, 10, end), Action: ActionChange,
		Target: Target{PlanKey: PlanLite, Stores: 12}, Months: 1})
	if want := Prorate(2*2500, now, end); q.AmountCents != want {
		t.Fatalf("growth on a higher plan: %d, want %d", q.AmountCents, want)
	}
}

// Each paid period is priced against what it was bought at, so a period
// bought at a higher capacity only pays for the growth it lacks.
func TestChangePricesEachPeriodSeparately(t *testing.T) {
	now := sh(2026, 10, 15, 0, 0, 0)
	mid := sh(2026, 11, 1, 0, 0, 0)
	end := sh(2026, 12, 1, 0, 0, 0)
	period := func(id int64, from, to time.Time, stores int) Period {
		return Period{ID: id, Start: from, End: to,
			Target:            Target{PlanKey: PlanLite, Stores: stores},
			StoreMonthlyCents: 2000}
	}
	snap := activeSnapshot(PlanLite, 5, end)
	snap.Periods = []Period{period(1, sh(2026, 10, 1, 0, 0, 0), mid, 5), period(2, mid, end, 8)}
	q := quote(t, QuoteInput{Now: now, Snapshot: snap, Action: ActionChange,
		Target: Target{PlanKey: PlanLite, Stores: 8}, Months: 1})
	// Only the running period lacks stores; the future one already has 8.
	if want := Prorate(3*2000, now, mid); q.AmountCents != want {
		t.Fatalf("per-period change: %d, want %d", q.AmountCents, want)
	}
}

func TestChangeKeepsTerm(t *testing.T) {
	end := sh(2026, 11, 1, 0, 0, 0)
	q := quote(t, QuoteInput{Now: sh(2026, 10, 15, 0, 0, 0),
		Snapshot: activeSnapshot(PlanLite, 5, end), Action: ActionChange,
		Target: Target{PlanKey: PlanPro, Stores: 5}, Months: 1})
	if !q.TermStart.Equal(sh(2026, 10, 15, 0, 0, 0)) || !q.TermEnd.Equal(end) {
		t.Fatalf("change moved the term: %s..%s", q.TermStart, q.TermEnd)
	}
}

func TestMonthly(t *testing.T) {
	lite := DefaultCatalog().Plans[PlanLite]
	for _, c := range []struct {
		stores int
		want   int64
	}{
		{1, 2000},
		{7, 14000},
		{10, 20000},
	} {
		got, err := lite.Monthly(c.stores)
		if err != nil || got != c.want {
			t.Fatalf("%d stores: %d %v, want %d", c.stores, got, err, c.want)
		}
	}
	for _, stores := range []int{0, -1} {
		if _, err := lite.Monthly(stores); err == nil {
			t.Fatalf("%d stores accepted", stores)
		}
	}
}
