package domain

import (
	"testing"
	"time"
)

// sh builds an instant from a Shanghai wall clock.
func sh(y int, m time.Month, d, hh, mm, ss int) time.Time {
	return time.Date(y, m, d, hh, mm, ss, 0, Shanghai)
}

func TestMonthBoundaries(t *testing.T) {
	cases := []struct {
		name string
		in   time.Time
		want time.Time
	}{
		{"mid month", sh(2026, 10, 15, 14, 30, 0), sh(2026, 10, 1, 0, 0, 0)},
		{"first instant", sh(2026, 10, 1, 0, 0, 0), sh(2026, 10, 1, 0, 0, 0)},
		{"last second", sh(2026, 10, 31, 23, 59, 59), sh(2026, 10, 1, 0, 0, 0)},
		// 2027-01-31T17:00Z is 2027-02-01 01:00 Shanghai. The UTC date and the
		// Shanghai date disagree; the Shanghai one must win.
		{"utc crosses the month in Shanghai", time.Date(2027, 1, 31, 17, 0, 0, 0, time.UTC), sh(2027, 2, 1, 0, 0, 0)},
	}
	for _, c := range cases {
		if got := MonthStart(c.in); !got.Equal(c.want) {
			t.Fatalf("%s: MonthStart(%s) = %s, want %s", c.name, c.in, got, c.want)
		}
	}
	if got := NextMonthStart(sh(2026, 12, 31, 23, 59, 59)); !got.Equal(sh(2027, 1, 1, 0, 0, 0)) {
		t.Fatalf("year rollover: %s", got)
	}
	if got := TermEnd(sh(2027, 1, 1, 0, 0, 0), 1); !got.Equal(sh(2027, 2, 1, 0, 0, 0)) {
		t.Fatalf("january term: %s", got)
	}
	if got := TermEnd(sh(2028, 1, 1, 0, 0, 0), 12); !got.Equal(sh(2029, 1, 1, 0, 0, 0)) {
		t.Fatalf("leap year twelve months: %s", got)
	}
}

func TestOnMonthStart(t *testing.T) {
	if !OnMonthStart(sh(2026, 11, 1, 0, 0, 0)) {
		t.Fatal("month start rejected")
	}
	for _, bad := range []time.Time{
		sh(2026, 11, 1, 0, 0, 1),
		sh(2026, 11, 2, 0, 0, 0),
		sh(2026, 11, 1, 8, 0, 0),
	} {
		if OnMonthStart(bad) {
			t.Fatalf("%s accepted", bad)
		}
	}
}

func TestProrate(t *testing.T) {
	cases := []struct {
		name string
		unit int64
		from time.Time
		to   time.Time
		want int64
	}{
		// docs §示例: 10-15 lite 1 month = 100 × 17/31 = 54.838… → 5484
		{"mid october", 10000, sh(2026, 10, 15, 0, 0, 0), sh(2026, 11, 1, 0, 0, 0), 5484},
		// A time of day must not change the day count: 10-15 14:30 still
		// covers 17 Shanghai dates.
		{"mid day ignored", 10000, sh(2026, 10, 15, 14, 30, 0), sh(2026, 11, 1, 0, 0, 0), 5484},
		// 10-31 add 25 stores: 500 × 1/31 = 16.129… → 1613. Rounding each
		// store first would give 1625.
		{"single day of a 31 day month", 50000, sh(2026, 10, 31, 9, 0, 0), sh(2026, 11, 1, 0, 0, 0), 1613},
		{"one store one day", 2000, sh(2026, 10, 31, 9, 0, 0), sh(2026, 11, 1, 0, 0, 0), 65},
		// 30-day month: 20 × 6/30 = 4.00 exactly.
		{"short month", 2000, sh(2026, 11, 25, 0, 0, 0), sh(2026, 12, 1, 0, 0, 0), 400},
		// February in a leap year: 200 × 29/29 = 200.
		{"leap february whole", 20000, sh(2028, 2, 1, 0, 0, 0), sh(2028, 3, 1, 0, 0, 0), 20000},
		// 200 × 15/29 = 103.448… → 10345 after half-up.
		{"leap february part", 20000, sh(2028, 2, 15, 0, 0, 0), sh(2028, 3, 1, 0, 0, 0), 10345},
		// Across a year boundary: 31 days of December then 4 of January.
		{"crosses new year", 31000, sh(2026, 12, 1, 0, 0, 0), sh(2027, 1, 5, 0, 0, 0), 31000 + 31000*4/31},
		{"zero length", 10000, sh(2026, 10, 15, 0, 0, 0), sh(2026, 10, 15, 0, 0, 0), 0},
		{"negative unit", -1, sh(2026, 10, 15, 0, 0, 0), sh(2026, 11, 1, 0, 0, 0), 0},
	}
	for _, c := range cases {
		if got := Prorate(c.unit, c.from, c.to); got != c.want {
			t.Fatalf("%s: Prorate = %d, want %d", c.name, got, c.want)
		}
	}
}

func TestProrateRoundsHalfUp(t *testing.T) {
	// 1 fen over 2 days of a 30-day month is 2/30 = 0.066… → 0.
	// 15/30 of 1 fen is exactly 0.5 → 1.
	if got := Prorate(1, sh(2026, 11, 29, 0, 0, 0), sh(2026, 12, 1, 0, 0, 0)); got != 0 {
		t.Fatalf("two days of a fen: %d", got)
	}
	if got := Prorate(2, sh(2026, 11, 16, 0, 0, 0), sh(2026, 12, 1, 0, 0, 0)); got != 1 {
		t.Fatalf("half a fen rounds up: %d", got)
	}
}

func TestProrateSum(t *testing.T) {
	// 500 upgrade + 500 stores over 17/31 = 1000 × 17/31 = 548.38 → 54839?
	// Exact: 1000 × 17 / 31 = 548.387…  → 54839 fen? No: 548.387 cents is
	// 54839 hundredths of a cent. Keep the assertion on the same scale as
	// Prorate: 1000 cents × 17/31 = 548.4 cents → 548.
	got := prorateSum([]int64{500, 500}, sh(2026, 10, 15, 0, 0, 0), sh(2026, 11, 1, 0, 0, 0))
	want := Prorate(1000, sh(2026, 10, 15, 0, 0, 0), sh(2026, 11, 1, 0, 0, 0))
	if got != want {
		t.Fatalf("prorateSum = %d, want %d", got, want)
	}
	// Negative units are skipped, never subtracted: 100 alone over 17/31.
	wantNeg := Prorate(100, sh(2026, 10, 15, 0, 0, 0), sh(2026, 11, 1, 0, 0, 0))
	if got := prorateSum([]int64{-5, 100}, sh(2026, 10, 15, 0, 0, 0), sh(2026, 11, 1, 0, 0, 0)); got != wantNeg {
		t.Fatalf("negative units must be ignored: %d, want %d", got, wantNeg)
	}
}

func TestPurchaseAnchorSurvivesShortMonth(t *testing.T) {
	anchor := sh(2027, 1, 31, 10, 30, 0)
	feb := AnchoredEnd(anchor, anchor, 1)
	march := AnchoredEnd(anchor, feb, 1)
	if !feb.Equal(sh(2027, 2, 28, 10, 30, 0)) || !march.Equal(sh(2027, 3, 31, 10, 30, 0)) {
		t.Fatalf("anchor drift: %s %s", feb, march)
	}
	leap := sh(2028, 1, 31, 10, 30, 0)
	if !TermEnd(leap, 1).Equal(sh(2028, 2, 29, 10, 30, 0)) {
		t.Fatal("leap month")
	}
	if got := roundHalfUp(PeriodFraction(4000, anchor, feb, march)); got != 4000 {
		t.Fatalf("full service month=%d", got)
	}
	half := anchor.Add(TermEnd(anchor, 1).Sub(anchor) / 2)
	if got := roundHalfUp(PeriodFraction(2000, anchor, half, feb)); got != 1000 {
		t.Fatalf("remaining half month=%d", got)
	}
}
